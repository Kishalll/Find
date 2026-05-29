"""Tests for the small-team authentication system.

Covers admin setup, login/logout, invite tokens, join requests,
admin approval, authorization enforcement, and security properties.
"""

import io

from PIL import Image

from find_api.core.auth import verify_password
from find_api.models.session import AuthSession
from find_api.models.user import User

TEST_PASSWORD = "".join(("auth", "-", "fixture", "-", "value"))
WRONG_PASSWORD = "".join(("wrong", "-", "fixture", "-", "value"))


# -- Helpers ------------------------------------------------------------------
# Thin wrappers around common request patterns so tests read more naturally.


def _setup_admin(client, username="admin", password=TEST_PASSWORD):
    """Create the admin account and return the response."""
    return client.post(
        "/api/auth/setup",
        json={
            "username": username,
            "password": password,
            "display_name": "Test Admin",
        },
    )


def _login(client, username="admin", password=TEST_PASSWORD):
    """Log in and return the response."""
    return client.post(
        "/api/auth/login",
        json={
            "username": username,
            "password": password,
        },
    )


def _auth_header(token):
    """Build an Authorization header dict."""
    return {"Authorization": f"Bearer {token}"}


def _create_invite(client, token):
    """Create an invite as admin and return the response."""
    return client.post("/api/auth/invites", headers=_auth_header(token))


def _join(client, invite_token, username="newuser", password=TEST_PASSWORD):
    """Submit a join request and return the response."""
    return client.post(
        "/api/auth/join",
        json={
            "invite_token": invite_token,
            "username": username,
            "password": password,
            "display_name": username.title(),
        },
    )


def _valid_png():
    """Return the raw bytes of a tiny valid PNG."""
    buf = io.BytesIO()
    Image.new("RGB", (1, 1), color="red").save(buf, format="PNG")
    return buf.getvalue()


# -- Admin setup --------------------------------------------------------------


def test_setup_creates_admin(client):
    """First call to /setup should create an admin user and return a token."""
    resp = _setup_admin(client)
    assert resp.status_code == 200

    data = resp.json()
    assert data["user"]["role"] == "admin"
    assert data["user"]["username"] == "admin"
    assert "token" in data
    assert "expires_at" in data


def test_setup_rejects_second_call(client):
    """Once an admin exists, /setup must return 409 — no double-init."""
    _setup_admin(client)
    resp = _setup_admin(client, username="sneaky")
    assert resp.status_code == 409


def test_setup_validates_short_password(client):
    """Passwords under 8 characters should be rejected by Pydantic."""
    resp = client.post(
        "/api/auth/setup",
        json={
            "username": "admin",
            "password": "short",
            "display_name": "Admin",
        },
    )
    assert resp.status_code == 422


# -- Login / logout -----------------------------------------------------------


def test_login_returns_token(client):
    """After setup, the admin should be able to log in and use the token."""
    _setup_admin(client)
    resp = _login(client)
    assert resp.status_code == 200

    data = resp.json()
    token = data["token"]
    assert data["user"]["username"] == "admin"

    # The token should work against /me
    me_resp = client.get("/api/auth/me", headers=_auth_header(token))
    assert me_resp.status_code == 200
    assert me_resp.json()["user"]["username"] == "admin"


def test_login_rejects_bad_password(client):
    """Wrong password → 401, nothing else leaked."""
    _setup_admin(client)
    resp = _login(client, password=WRONG_PASSWORD)
    assert resp.status_code == 401


def test_login_rejects_unknown_user(client):
    """Non-existent username → same 401 as bad password (no user enumeration)."""
    _setup_admin(client)
    resp = _login(client, username="ghost", password=WRONG_PASSWORD)
    assert resp.status_code == 401


def test_logout_invalidates_session(client):
    """After logout, the same bearer token should no longer authenticate."""
    setup = _setup_admin(client)
    token = setup.json()["token"]

    # Confirm it works first
    assert client.get("/api/auth/me", headers=_auth_header(token)).status_code == 200

    # Logout
    client.post("/api/auth/logout", headers=_auth_header(token))

    # Same token should now be rejected (shared mode → 401)
    assert client.get("/api/auth/me", headers=_auth_header(token)).status_code == 401


def test_me_in_local_mode(client):
    """Without setup, /me should indicate local mode with no user."""
    resp = client.get("/api/auth/me")
    # In local mode get_required_user returns None, route returns local
    assert resp.status_code == 200
    data = resp.json()
    assert data["mode"] == "local"
    assert data["user"] is None


def test_me_in_shared_mode(client):
    """After setup, /me with a valid token should return user info."""
    setup = _setup_admin(client)
    token = setup.json()["token"]

    resp = client.get("/api/auth/me", headers=_auth_header(token))
    assert resp.status_code == 200

    data = resp.json()
    assert data["mode"] == "shared"
    assert data["user"]["role"] == "admin"


# -- Invite flow --------------------------------------------------------------


def test_admin_creates_invite(client):
    """Admin should be able to generate a single-use invite token."""
    setup = _setup_admin(client)
    token = setup.json()["token"]

    resp = _create_invite(client, token)
    assert resp.status_code == 200

    data = resp.json()
    assert "invite_token" in data
    assert "expires_at" in data
    assert "id" in data


def test_member_cannot_create_invite(client):
    """A non-admin member should get 403 on invite creation."""
    setup = _setup_admin(client)
    admin_token = setup.json()["token"]

    # Create a member via the invite → join → approve flow
    invite_resp = _create_invite(client, admin_token)
    assert invite_resp.status_code == 200
    inv_token = invite_resp.json()["invite_token"]

    join_resp = _join(client, inv_token, username="member1")
    assert join_resp.status_code == 200
    req_id = join_resp.json()["join_request_id"]

    approve_resp = client.post(
        f"/api/auth/join-requests/{req_id}/approve",
        headers=_auth_header(admin_token),
    )
    assert approve_resp.status_code == 200

    # Log in as the new member
    member_login = _login(client, username="member1", password=TEST_PASSWORD)
    assert member_login.status_code == 200
    member_token = member_login.json()["token"]

    # Try to create an invite — should be forbidden
    resp = _create_invite(client, member_token)
    assert resp.status_code == 403


def test_invite_is_single_use(client):
    """Using the same invite code twice should fail on the second attempt."""
    setup = _setup_admin(client)
    admin_token = setup.json()["token"]

    invite_resp = _create_invite(client, admin_token)
    assert invite_resp.status_code == 200
    inv_token = invite_resp.json()["invite_token"]

    # First use succeeds
    first = _join(client, inv_token, username="first_user")
    assert first.status_code == 200

    # Second use with a different username should fail
    second = _join(client, inv_token, username="second_user")
    assert second.status_code == 400
    assert "used" in second.json()["detail"].lower()


# -- Join request --------------------------------------------------------------


def test_join_creates_pending_request(client):
    """Submitting a join request with a valid invite creates a pending entry."""
    setup = _setup_admin(client)
    admin_token = setup.json()["token"]

    invite_resp = _create_invite(client, admin_token)
    assert invite_resp.status_code == 200
    inv_token = invite_resp.json()["invite_token"]

    resp = _join(client, inv_token)
    assert resp.status_code == 200

    data = resp.json()
    assert data["status"] == "pending"
    assert "join_request_id" in data


def test_join_rejects_invalid_invite(client):
    """A made-up invite token should be rejected."""
    _setup_admin(client)

    resp = _join(client, invite_token="bogus-invite-token-value")
    assert resp.status_code == 400


def test_join_rejects_duplicate_username(client):
    """If the username is already taken by an existing user, return 409."""
    setup = _setup_admin(client)
    admin_token = setup.json()["token"]

    invite_resp = _create_invite(client, admin_token)
    assert invite_resp.status_code == 200
    inv_token = invite_resp.json()["invite_token"]

    # Try to join with the same username as the admin
    resp = _join(client, inv_token, username="admin")
    assert resp.status_code == 409


# -- Admin approval / rejection ------------------------------------------------


def test_approve_creates_member(client):
    """Approving a join request should create a user with role=member."""
    setup = _setup_admin(client)
    admin_token = setup.json()["token"]

    invite_resp = _create_invite(client, admin_token)
    assert invite_resp.status_code == 200
    inv_token = invite_resp.json()["invite_token"]

    join_resp = _join(client, inv_token, username="alice")
    assert join_resp.status_code == 200
    req_id = join_resp.json()["join_request_id"]

    resp = client.post(
        f"/api/auth/join-requests/{req_id}/approve",
        headers=_auth_header(admin_token),
    )
    assert resp.status_code == 200

    user_data = resp.json()["user"]
    assert user_data["role"] == "member"
    assert user_data["username"] == "alice"


def test_approved_user_can_login(client):
    """After approval, the new member should be able to authenticate."""
    setup = _setup_admin(client)
    admin_token = setup.json()["token"]

    invite_resp = _create_invite(client, admin_token)
    assert invite_resp.status_code == 200
    inv_token = invite_resp.json()["invite_token"]

    join_resp = _join(client, inv_token, username="bob", password=TEST_PASSWORD)
    assert join_resp.status_code == 200
    req_id = join_resp.json()["join_request_id"]

    approve_resp = client.post(
        f"/api/auth/join-requests/{req_id}/approve",
        headers=_auth_header(admin_token),
    )
    assert approve_resp.status_code == 200

    login_resp = _login(client, username="bob", password=TEST_PASSWORD)
    assert login_resp.status_code == 200
    assert login_resp.json()["user"]["username"] == "bob"


def test_reject_marks_rejected(client):
    """Rejecting a join request should set its status to 'rejected'."""
    setup = _setup_admin(client)
    admin_token = setup.json()["token"]

    invite_resp = _create_invite(client, admin_token)
    assert invite_resp.status_code == 200
    inv_token = invite_resp.json()["invite_token"]

    join_resp = _join(client, inv_token, username="eve")
    assert join_resp.status_code == 200
    req_id = join_resp.json()["join_request_id"]

    resp = client.post(
        f"/api/auth/join-requests/{req_id}/reject",
        headers=_auth_header(admin_token),
    )
    assert resp.status_code == 200
    assert resp.json()["message"] == "Join request rejected"


def test_non_admin_cannot_approve(client):
    """A regular member cannot approve join requests (403)."""
    setup = _setup_admin(client)
    admin_token = setup.json()["token"]

    # Create a member first
    invite1 = _create_invite(client, admin_token)
    assert invite1.status_code == 200
    inv1 = invite1.json()["invite_token"]
    join1 = _join(client, inv1, username="member1")
    assert join1.status_code == 200
    approve1 = client.post(
        f"/api/auth/join-requests/{join1.json()['join_request_id']}/approve",
        headers=_auth_header(admin_token),
    )
    assert approve1.status_code == 200
    member_login = _login(client, username="member1", password=TEST_PASSWORD)
    assert member_login.status_code == 200
    member_token = member_login.json()["token"]

    # Now create another join request for member to try approving
    invite2 = _create_invite(client, admin_token)
    assert invite2.status_code == 200
    inv2 = invite2.json()["invite_token"]
    join2 = _join(client, inv2, username="pending_user")
    assert join2.status_code == 200
    req_id = join2.json()["join_request_id"]

    resp = client.post(
        f"/api/auth/join-requests/{req_id}/approve",
        headers=_auth_header(member_token),
    )
    assert resp.status_code == 403


# -- Authorization in shared mode ---------------------------------------------


def test_upload_without_auth_still_works_in_shared_mode(client):
    """Upload uses get_optional_user, so it should still accept files
    even in shared mode — the uploader just won't be recorded."""
    _setup_admin(client)

    resp = client.post(
        "/api/upload",
        files=[("files", ("photo.png", _valid_png(), "image/png"))],
    )
    assert resp.status_code == 200
    assert resp.json()["results"][0]["status"] == "uploaded"


def test_upload_records_uploader(client, db):
    """When an authenticated user uploads, their ID is saved on the media row."""
    setup = _setup_admin(client)
    token = setup.json()["token"]
    user_id = setup.json()["user"]["id"]

    resp = client.post(
        "/api/upload",
        files=[("files", ("photo.png", _valid_png(), "image/png"))],
        headers=_auth_header(token),
    )
    assert resp.status_code == 200

    from find_api.models.media import Media

    media_id = resp.json()["results"][0]["media_id"]
    media = db.query(Media).filter(Media.id == media_id).one()
    assert media.uploader_user_id == user_id


# -- Security properties ------------------------------------------------------


def test_passwords_are_hashed(client, db):
    """The stored password_hash must NOT be the plaintext password."""
    _setup_admin(client, password=TEST_PASSWORD)

    admin = db.query(User).filter(User.username == "admin").one()
    assert admin.password_hash != TEST_PASSWORD
    assert admin.password_hash.startswith("$2")


def test_long_passwords_do_not_match_after_bcrypt_limit(client):
    """Different long passwords that share the first 72 bytes must not collide."""
    prefix = "a" * 80
    exact_password = f"{prefix}-one"
    colliding_password = f"{prefix}-two"

    resp = _setup_admin(client, password=exact_password)
    assert resp.status_code == 200

    assert _login(client, password=exact_password).status_code == 200
    assert _login(client, password=colliding_password).status_code == 401


def test_verify_password_accepts_hash_password_output(client, db):
    _setup_admin(client, password=TEST_PASSWORD)

    admin = db.query(User).filter(User.username == "admin").one()
    assert verify_password(TEST_PASSWORD, admin.password_hash)


def test_session_tokens_are_hashed(client, db):
    """The raw token returned to the client must NOT match the DB value."""
    setup = _setup_admin(client)
    raw_token = setup.json()["token"]

    session = db.query(AuthSession).first()
    assert session is not None
    # The DB stores a SHA-256 hex digest, not the raw token
    assert session.token_hash != raw_token
    assert len(session.token_hash) == 64  # SHA-256 hex length
