"""DocFlow — Celery Worker: Email Tasks

Sends transactional email through the provider layer (app.core.email_sender).

Failure handling:
  * transient errors (network, timeout, SMTP 4xx, HTTP 429/5xx) are retried
    with exponential backoff + jitter, up to EMAIL_MAX_RETRIES;
  * permanent errors (auth failure, bad recipient, SMTP 5xx, HTTP 4xx) are NOT
    retried - retrying cannot fix them - and are logged loudly;
  * every failure is logged with the provider's full (redacted) response, the
    attempt number and whether another retry is scheduled.

A success log line means the provider ACCEPTED the message. It is not proof
of mailbox delivery or inbox placement.
"""
from __future__ import annotations

import random

import structlog
from app.config import settings
from app.core.celery_app import celery_app
from app.core.email_sender import EmailSendError, mask_email, redact, send_email_message

logger = structlog.get_logger(__name__)

MAX_BACKOFF_SECONDS = 600


def backoff_seconds(attempt: int) -> int:
    """5s, 10s, 20s, 40s ... (EMAIL_RETRY_BASE_SECONDS * 2^attempt), capped, +<=20% jitter."""
    base = settings.EMAIL_RETRY_BASE_SECONDS * (2 ** attempt)
    base = min(base, MAX_BACKOFF_SECONDS)
    return int(base + random.uniform(0, base * 0.2))


def deliver(to: str, subject: str, html: str, text: str | None = None,
            entity_ref: str | None = None) -> dict:
    """Send once, synchronously. Raises EmailSendError. Shared by the task,
    the inline fallback and scripts/test_email.py."""
    result = send_email_message(to=to, subject=subject, html=html, text=text, entity_ref=entity_ref)
    logger.info(
        "email_accepted_by_provider" if result.accepted else "email_not_sent",
        to=mask_email(to), subject=subject, provider=result.provider,
        message_id=result.message_id, provider_response=redact(result.response),
    )
    return {"accepted": result.accepted, "provider": result.provider,
            "message_id": result.message_id, "response": redact(result.response)}


@celery_app.task(name="app.workers.email_tasks.send_email", bind=True, queue="email",
                 max_retries=settings.EMAIL_MAX_RETRIES)
def send_email(self, to: str, subject: str, html: str, from_email: str | None = None,
               text: str | None = None, entity_ref: str | None = None) -> dict:
    attempt = self.request.retries
    try:
        return deliver(to, subject, html, text, entity_ref)
    except EmailSendError as exc:
        will_retry = exc.transient and attempt < self.max_retries
        logger.error(
            "email_send_failed",
            to=mask_email(to), subject=subject, provider=exc.provider, code=exc.code,
            transient=exc.transient, attempt=attempt + 1, max_attempts=self.max_retries + 1,
            will_retry=will_retry, error=redact(exc),
        )
        if will_retry:
            raise self.retry(exc=exc, countdown=backoff_seconds(attempt)) from exc
        raise
    except Exception as exc:  # defensive: unexpected bug, still never leak secrets
        logger.error("email_send_crashed", to=mask_email(to), subject=subject,
                     error=redact(f"{type(exc).__name__}: {exc}"))
        raise
