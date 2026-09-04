"""DocFlow — Celery Worker: Email Tasks"""
from __future__ import annotations

import structlog
from app.core.celery_app import celery_app

logger = structlog.get_logger(__name__)


@celery_app.task(name="app.workers.email_tasks.send_email", bind=True, max_retries=3, queue="email")
def send_email(self, to: str, subject: str, html: str, from_email: str | None = None) -> bool:
    """Send transactional email. Uses Resend in prod, Mailpit SMTP in dev. Implemented in Milestone 6."""
    logger.info("Email task", to=to, subject=subject)
    return True
