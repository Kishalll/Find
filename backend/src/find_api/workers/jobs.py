"""
Background worker jobs for image processing
"""

from PIL import Image
import io
import logging
from datetime import datetime
import numpy as np
from rq import get_current_job

from find_api.core.database import SessionLocal
from find_api.core.queue import clear_clustering_job_state, enqueue_clustering_job
from find_api.core.storage import get_file
from find_api.models.media import Media
from find_api.utils.exif import extract_exif_data

logger = logging.getLogger(__name__)


def set_stage(job, stage: str):
    """Persist the current upload-processing stage in RQ metadata."""
    if job:
        job.meta["stage"] = stage
        job.save_meta()


def set_error(job, error: str):
    """Persist a safe user-facing processing error in RQ metadata."""
    if job:
        job.meta["error"] = error
        job.save_meta()


def analyze_image(media_id: int):
    """
    Main worker job to analyze an uploaded image
    """

    from find_api.workers.processors import (
        extract_image_metadata,
        generate_hybrid_embedding,
    )

    job = get_current_job()

    db = SessionLocal()
    media = None

    try:
        set_stage(job, "loading image")

        media = db.query(Media).filter(Media.id == media_id).first()
        if not media:
            logger.error(f"Media {media_id} not found")
            return

        media.status = "processing"
        db.commit()

        image_data = get_file(media.minio_key)
        image = Image.open(io.BytesIO(image_data))

        if image.mode != "RGB":
            image = image.convert("RGB")

        media.width, media.height = image.size

        set_stage(job, "extracting EXIF")

        try:
            exif_data = extract_exif_data(image)
            media.exif_json = exif_data
        except Exception as e:
            logger.warning(f"Failed to extract EXIF: {e}")
            media.exif_json = {}

        metadata = extract_image_metadata(
            image,
            on_stage=lambda stage: set_stage(job, stage),
        )

        set_stage(job, "generating embedding")

        media.vector = generate_hybrid_embedding(image, metadata)

        set_stage(job, "indexing complete")

        media.metadata_json = metadata
        media.status = "indexed"
        media.processed_at = datetime.utcnow()

        db.commit()

        # Detect faces and store them in the faces table
        # This runs after the main image processing is complete
        from find_api.workers.processors import detect_and_store_faces

        face_count = detect_and_store_faces(image, media_id, db)
        logger.info("Face detection complete: %s faces found", face_count)

        set_stage(job, "clustering queued")

        try:
            enqueue_clustering_job(reason=f"media:{media_id}")
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Indexed media %s but failed to queue clustering: %s",
                media_id,
                exc,
            )

        logger.info(f"Successfully processed media {media_id}")

        return {"media_id": media_id, "status": "success", "metadata": metadata}

    except Exception as e:
        logger.error(f"Failed to process media {media_id}: {e}")
        db.rollback()

        set_stage(job, "failed")
        set_error(job, str(e))

        if media:
            media.status = "failed"
            media.error_message = str(e)
            db.commit()

        raise

    finally:
        db.close()


def cluster_images():
    """
    Background job to cluster all indexed images
    """

    from find_api.ml.clusterer import get_image_clusterer
    from find_api.models.cluster import Cluster
    from find_api.core.config import settings

    db = SessionLocal()

    try:
        logger.info("Starting clustering job...")

        db.query(Media).filter(Media.cluster_id.isnot(None)).update(
            {Media.cluster_id: None}, synchronize_session=False
        )
        db.query(Cluster).delete(synchronize_session=False)
        db.flush()

        media_rows = (
            db.query(Media.id, Media.vector)
            .filter(Media.status == "indexed", Media.vector.isnot(None))
            .all()
        )

        if len(media_rows) < settings.MIN_CLUSTER_SIZE:
            db.commit()
            logger.warning(
                "Not enough images for clustering (found %s, need %s)",
                len(media_rows),
                settings.MIN_CLUSTER_SIZE,
            )
            return {
                "n_clusters": 0,
                "noise_points": len(media_rows),
                "total_points": len(media_rows),
                "message": "Not enough indexed images for clustering",
            }

        embeddings = np.asarray([row.vector for row in media_rows], dtype=np.float32)
        media_ids = [row.id for row in media_rows]

        logger.info(f"Clustering {len(media_rows)} images...")

        clusterer = get_image_clusterer()
        labels, info = clusterer.cluster(embeddings)

        cluster_labels = sorted({int(label) for label in labels if int(label) != -1})

        if not cluster_labels:
            db.commit()
            logger.info("Clustering completed with no stable clusters")
            return {
                **info,
                "message": "No stable clusters found",
                "cluster_ids": [],
            }

        centroids = clusterer.compute_centroids(embeddings, labels)

        cluster_records = {}
        for cluster_label in cluster_labels:
            member_ids = [
                media_ids[i]
                for i, label in enumerate(labels)
                if int(label) == cluster_label
            ]
            cluster = Cluster(
                cluster_type="general",
                member_ids=member_ids,
                member_count=len(member_ids),
                centroid_vector=centroids[cluster_label].tolist(),
            )
            db.add(cluster)
            db.flush()
            cluster_records[cluster_label] = cluster

        db.bulk_update_mappings(
            Media,
            [
                {
                    "id": media_id,
                    "cluster_id": None
                    if int(labels[index]) == -1
                    else cluster_records[int(labels[index])].id,
                }
                for index, media_id in enumerate(media_ids)
            ],
        )

        db.commit()

        result = {
            **info,
            "message": "Clustering completed successfully",
            "cluster_ids": [cluster.id for cluster in cluster_records.values()],
        }
        logger.info("Clustering complete: %s", result)
        return result

    except Exception as e:
        logger.error(f"Clustering failed: {e}")
        db.rollback()
        raise

    finally:
        clear_clustering_job_state()
        db.close()


def cluster_faces():
    """
    Background job to cluster all detected faces into person groups.

    How it works:
    1. Load all face embeddings from the database
    2. Check we have enough faces BEFORE deleting anything
    3. Run HDBSCAN to group similar faces together
    4. Create a Person row for each group
    5. Link each face to its Person group
    """
    from find_api.ml.clusterer import get_image_clusterer
    from find_api.models.face import Face
    from find_api.models.person import Person

    db = SessionLocal()

    try:
        logger.info("Starting face clustering job...")

        # Step 1: Load all faces that have embeddings
        # Check BEFORE deleting anything so we don't lose data
        face_rows = (
            db.query(Face.id, Face.embedding).filter(Face.embedding.isnot(None)).all()
        )

        # Need at least 2 faces to cluster
        if len(face_rows) < 2:
            db.commit()
            logger.warning(
                "Not enough faces for clustering (found %s, need 2)",
                len(face_rows),
            )
            return {
                "n_clusters": 0,
                "total_faces": len(face_rows),
                "message": "Not enough faces for clustering",
            }

        # Step 2: Only reset assignments once we know clustering will proceed
        db.query(Face).update({Face.person_id: None}, synchronize_session=False)
        db.query(Person).delete(synchronize_session=False)
        db.flush()

        # Step 3: Prepare embeddings as numpy array
        embeddings = np.asarray([row.embedding for row in face_rows], dtype=np.float32)
        face_ids = [row.id for row in face_rows]

        logger.info("Clustering %s faces...", len(face_rows))

        # Step 4: Run HDBSCAN clustering
        clusterer = get_image_clusterer()
        labels, info = clusterer.cluster(embeddings)

        # Step 5: Create Person rows for each cluster
        # label -1 means noise - skip those
        unique_labels = sorted({int(label) for label in labels if int(label) != -1})

        if not unique_labels:
            db.commit()
            logger.info("Face clustering found no stable person groups")
            return {
                **info,
                "message": "No stable person groups found",
            }

        # Create one Person per cluster label
        person_records = {}
        for label in unique_labels:
            person = Person()
            db.add(person)
            db.flush()
            person_records[label] = person

        # Step 6: Link each face to its Person
        for face_id, label in zip(face_ids, labels):
            if int(label) == -1:
                continue
            person = person_records[int(label)]
            db.query(Face).filter(Face.id == face_id).update(
                {Face.person_id: person.id},
                synchronize_session=False,
            )

        db.commit()

        result = {
            **info,
            "n_persons": len(unique_labels),
            "message": "Face clustering completed successfully",
        }
        logger.info("Face clustering complete: %s", result)
        return result

    except Exception as e:
        logger.error("Face clustering failed: %s", e)
        db.rollback()
        raise

    finally:
        db.close()
