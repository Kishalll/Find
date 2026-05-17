/**
 * Tests: gallery URL-state restoration
 * File: frontend/src/__tests__/gallery-url-state.test.tsx
 *
 * Covers issue #93 acceptance criteria:
 *   1. Status tab UI renders correctly
 *   2. Liked-only filter UI renders correctly
 *   3. Media deep-link (?media=<id>) opens the correct item
 *
 * NOTE: The current page.tsx reads ?media from the URL but manages
 * ?status and ?liked as local React state only. Tests for URL-based
 * restoration of those filters are marked with todo() — they will be
 * activated once issue #89 (persist gallery tab and liked filter in URL)
 * is merged into this branch.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock next/navigation
// ---------------------------------------------------------------------------
const mockSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/gallery",
}));

// ---------------------------------------------------------------------------
// Mock next/image
// ---------------------------------------------------------------------------
vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

// ---------------------------------------------------------------------------
// Mock next/link
// ---------------------------------------------------------------------------
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

// ---------------------------------------------------------------------------
// Mock sonner
// ---------------------------------------------------------------------------
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// ---------------------------------------------------------------------------
// Mock API layer
// ---------------------------------------------------------------------------
const MOCK_ITEMS = [
  {
    id: 1,
    filename: "sunset.jpg",
    status: "indexed",
    liked: false,
    url: "/images/1.jpg",
    minio_key: null,
    caption: "A sunset",
  },
  {
    id: 2,
    filename: "mountain.jpg",
    status: "processing",
    liked: false,
    url: "/images/2.jpg",
    minio_key: null,
    caption: null,
  },
  {
    id: 3,
    filename: "beach.jpg",
    status: "failed",
    liked: false,
    url: "/images/3.jpg",
    minio_key: null,
    caption: null,
  },
  {
    id: 4,
    filename: "forest.jpg",
    status: "indexed",
    liked: true,
    url: "/images/4.jpg",
    minio_key: null,
    caption: "A forest",
  },
];

vi.mock("@/lib/api", () => ({
  getGallery: vi.fn(() =>
    Promise.resolve({
      items: MOCK_ITEMS,
      total: MOCK_ITEMS.length,
      page: 1,
      limit: 24,
    }),
  ),
  getImageDetail: vi.fn((id: number) => {
    const item = MOCK_ITEMS.find((i) => i.id === id);
    if (!item) return Promise.reject(new Error("Not found"));
    return Promise.resolve(item);
  }),
  toggleLike: vi.fn((id: number) => Promise.resolve({ id })),
  deleteImage: vi.fn((id: number) => Promise.resolve({ id })),
  reprocessImage: vi.fn((id: number) => Promise.resolve({ media_id: id })),
}));

vi.mock("@/lib/media", () => ({
  resolveMediaUrl: vi.fn(() => "/images/mock.jpg"),
}));

// ---------------------------------------------------------------------------
// Mock child components not under test
// ---------------------------------------------------------------------------
vi.mock("@/components/image-preview-modal", () => ({
  ImagePreviewModal: ({ media }: { media: { filename: string } }) => (
    <div role="dialog" aria-label="image preview">
      <span data-testid="modal-filename">{media.filename}</span>
    </div>
  ),
}));

vi.mock("@/components/status-indicator", () => ({
  StatusIndicator: ({ status }: { status: string }) => (
    <span data-testid="status-indicator">{status}</span>
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function setParams(params: Record<string, string>) {
  mockSearchParams.forEach((_v, k) => mockSearchParams.delete(k));
  for (const [k, v] of Object.entries(params)) {
    mockSearchParams.set(k, v);
  }
}

function clearParams() {
  mockSearchParams.forEach((_v, k) => mockSearchParams.delete(k));
}

// ---------------------------------------------------------------------------
// Import component under test
// ---------------------------------------------------------------------------
import GalleryPage from "../app/gallery/page";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gallery — URL-state restoration", () => {
  beforeEach(() => {
    clearParams();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearParams();
  });

  // ── 1. Status tab UI ─────────────────────────────────────────────────────

  describe("status tab UI", () => {
    it("renders all four filter tab buttons", async () => {
      render(<GalleryPage />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /^all$/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: /^indexed$/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: /^processing$/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: /^failed$/i }),
        ).toBeInTheDocument();
      });
    });

    it("shows all gallery items on initial load", async () => {
      render(<GalleryPage />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /view sunset\.jpg/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: /view mountain\.jpg/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: /view beach\.jpg/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: /view forest\.jpg/i }),
        ).toBeInTheDocument();
      });
    });

    it("calls getGallery on mount", async () => {
      const { getGallery } = await import("@/lib/api");
      render(<GalleryPage />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(getGallery).toHaveBeenCalled();
      });
    });

    // These will pass once issue #89 is implemented
    it.todo(
      "restores Processing tab from ?status=processing and calls getGallery with status:processing",
    );
    it.todo(
      "restores Failed tab from ?status=failed and calls getGallery with status:failed",
    );
    it.todo(
      "restores Indexed tab from ?status=indexed and calls getGallery with status:indexed",
    );
  });

  // ── 2. Liked-only filter UI ───────────────────────────────────────────────

  describe("liked-only filter UI", () => {
    it("renders the liked toggle button showing 'All images' by default", async () => {
      render(<GalleryPage />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /all images/i }),
        ).toBeInTheDocument();
      });
    });

    it("shows all images on initial load", async () => {
      render(<GalleryPage />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /view sunset\.jpg/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: /view forest\.jpg/i }),
        ).toBeInTheDocument();
      });
    });

    // These will pass once issue #89 is implemented
    it.todo(
      "restores liked-only mode from ?liked=true and calls getGallery with liked:true",
    );
    it.todo(
      "shows 'Liked' button text when ?liked=true is in the URL",
    );
    it.todo(
      "shows only liked items in gallery when ?liked=true is in the URL",
    );
  });

  // ── 3. Media deep-link (?media=) — already implemented in page.tsx ────────

  describe("media deep-link with filter params", () => {
    it("opens image preview modal when ?media=1 is in the URL", async () => {
      setParams({ media: "1" });

      render(<GalleryPage />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByTestId("modal-filename")).toHaveTextContent(
          "sunset.jpg",
        );
      });
    });

    it("opens modal for item id=4 when ?media=4", async () => {
      setParams({ media: "4" });

      render(<GalleryPage />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByTestId("modal-filename")).toHaveTextContent(
          "forest.jpg",
        );
      });
    });

    it("does not open modal when ?media param is absent", async () => {
      render(<GalleryPage />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /view sunset\.jpg/i }),
        ).toBeInTheDocument();
      });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("fetches image detail for off-page ?media id not in gallery results", async () => {
      const { getGallery, getImageDetail } = await import("@/lib/api");

      // Return only item 1 from gallery so item 2 is "off page"
      (getGallery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        items: [MOCK_ITEMS[0]],
        total: 1,
        page: 1,
        limit: 24,
      });

      setParams({ media: "2" });

      render(<GalleryPage />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(getImageDetail).toHaveBeenCalledWith(2);
      });
    });

    it("handles non-existent ?media id gracefully without crashing", async () => {
      setParams({ media: "9999" });

      render(<GalleryPage />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /view sunset\.jpg/i }),
        ).toBeInTheDocument();
      });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("handles non-numeric ?media value gracefully without crashing", async () => {
      setParams({ media: "not-a-number" });

      render(<GalleryPage />, { wrapper: makeWrapper() });

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /view sunset\.jpg/i }),
        ).toBeInTheDocument();
      });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
