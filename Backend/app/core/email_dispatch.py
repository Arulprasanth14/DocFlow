"""
DocFlow Backend - email dispatch (queue vs. inline, with dev fallback).

`dispatch_email` is the single entry point the application uses to send mail.
It NEVER raises: login, organization creation and every other flow that
triggers an email must keep working when mail cannot be sent. Problems are
logged (redacted) instead.

Why a liveness check: Celery's `.delay()` succeeds as soon as the message is
written to Redis - even when no worker is consuming. That is how org-created
emails sat in the queue forever with no error anywhere. So in queue mode we
first ask whether a worker is actually answering; if not:

  EMAIL_SYNC_FALLBACK=true  -> send inline from the API process instead
                               (and log that we did), so dev setups without a
                               worker still get their mail;
  EMAIL_SYNC_FALLBACK=false -> still enqueue (a worker started later will
                               drain it) but log an ERROR saying nobody is
                               consuming the queue.

The function is blocking (network). Call it via asyncio.to_thread from async code.
"""
from __future__ import annotations

import logging
import time

from app.config import settings
from app.core.email_sender import EmailSendError, mask_email, redact

logger = logging.getLogger(__name__)

_worker_cache: tuple[float, bool] = (0.0, False)


def worker_available(force: bool = False) -> bool:
    """True if at least one Celery worker answers a ping (cached briefly)."""
    global _worker_cache
    now = time.monotonic()
    if not force and now - _worker_cache[0] < settings.EMAIL_WORKER_CHECK_TTL_SECONDS and _worker_cache[0]:
        return _worker_cache[1]
    ok = False
    try:
        from app.core.celery_app import celery_app

        replies = celery_app.control.inspect(timeout=1.0).ping()
        ok = bool(replies)
    except Exception as exc:  # broker down, import problem, ...
        logger.warning("email_worker_check_failed: %s", redact(f"{type(exc).__name__}: {exc}"))
    _worker_cache = (now, ok)
    return ok


def _send_inline(to: str, subject: str, html: str, text: str | None, entity_ref: str | None, why: str) -> str:
    from app.workers.email_tasks import deliver

    try:
        info = deliver(to, subject, html, text, entity_ref)
        logger.info("email_sent_inline (%s) to=%s provider=%s accepted=%s",
                    why, mask_email(to), info["provider"], info["accepted"])
        return "sent_inline" if info["accepted"] else "logged"
    except EmailSendError as exc:
        logger.error("email_inline_failed (%s) to=%s provider=%s code=%s transient=%s error=%s",
                     why, mask_email(to), exc.provider, exc.code, exc.transient, redact(exc))
    except Exception as exc:
        logger.error("email_inline_crashed (%s) to=%s error=%s", why, mask_email(to),
                     redact(f"{type(exc).__name__}: {exc}"))
    # Last resort in dev: make the content visible so the flow can still be tested.
    if settings.APP_ENV != "production" and settings.EMAIL_SYNC_FALLBACK:
        from app.core.email_sender import build_message

        try:
            body = build_message(to=to, subject=subject, html=html, text=text).get_body(("plain",))
            logger.warning("email_console_fallback to=%s subject=%s\n%s", to, subject,
                           body.get_content() if body else "")
            return "logged"
        except Exception:
            pass
    return "failed"


def dispatch_email(*, to: str, subject: str, html: str, text: str | None = None,
                   entity_ref: str | None = None) -> str:
    """Returns one of: queued | sent_inline | logged | failed. Never raises."""
    try:
        if settings.EMAIL_DELIVERY_MODE == "inline" or settings.EMAIL_PROVIDER == "console":
            return _send_inline(to, subject, html, text, entity_ref, "inline mode")

        if worker_available():
            return _enqueue(to, subject, html, text, entity_ref)

        if settings.EMAIL_SYNC_FALLBACK:
            logger.warning("email_no_worker: no Celery worker is answering; sending inline "
                           "(EMAIL_SYNC_FALLBACK=true). Start a worker for retries/backoff.")
            return _send_inline(to, subject, html, text, entity_ref, "no worker")

        logger.error("email_no_worker: no Celery worker is consuming the 'email' queue; the message "
                     "is queued but will NOT be sent until a worker starts "
                     "(or set EMAIL_SYNC_FALLBACK=true).")
        return _enqueue(to, subject, html, text, entity_ref)
    except Exception as exc:
        logger.error("email_dispatch_crashed to=%s error=%s", mask_email(to),
                     redact(f"{type(exc).__name__}: {exc}"))
        return "failed"


def _enqueue(to, subject, html, text, entity_ref) -> str:
    from app.workers.email_tasks import send_email

    try:
        res = send_email.apply_async(
            kwargs={"to": to, "subject": subject, "html": html, "text": text, "entity_ref": entity_ref},
            queue="email",
        )
        logger.info("email_queued to=%s task_id=%s", mask_email(to), res.id)
        return "queued"
    except Exception as exc:
        logger.error("email_enqueue_failed (broker unreachable?) to=%s error=%s", mask_email(to),
                     redact(f"{type(exc).__name__}: {exc}"))
        if settings.EMAIL_SYNC_FALLBACK:
            return _send_inline(to, subject, html, text, entity_ref, "enqueue failed")
        return "failed"
