"""DocFlow — Celery Worker: AI Tasks (OCR, embedding, classification)"""
from __future__ import annotations

import structlog
from app.core.celery_app import celery_app

logger = structlog.get_logger(__name__)


@celery_app.task(name="app.workers.ai_tasks.generate_embedding", bind=True, max_retries=3, queue="ai")
def generate_embedding(self, document_id: str) -> bool:
    """Generate and store document embedding. Implemented in Milestone 7."""
    logger.info("Embedding task", document_id=document_id)
    return True


@celery_app.task(name="app.workers.ai_tasks.run_ocr", bind=True, max_retries=3, queue="ai")
def run_ocr(self, file_asset_id: str) -> bool:
    """Run OCR on an uploaded file. Implemented in Milestone 7."""
    logger.info("OCR task", file_asset_id=file_asset_id)
    return True


@celery_app.task(name="app.workers.ai_tasks.refresh_stale_embeddings")
def refresh_stale_embeddings() -> dict:
    """Refresh embeddings for documents with outdated content_hash. Implemented in Milestone 7."""
    return {"refreshed": 0}
