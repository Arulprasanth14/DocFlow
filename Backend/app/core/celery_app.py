"""
DocFlow Backend — Core: Celery App
Celery task queue with Redis broker.
Queues: default, ai (separate for GPU workers), email
"""
from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from app.config import settings

# ── Celery App ────────────────────────────────────────────────────────────────
celery_app = Celery(
    "docflow",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
    include=[
        "app.workers.notification_tasks",
        "app.workers.ai_tasks",
        "app.workers.sla_tasks",
        "app.workers.email_tasks",
        "app.workers.cleanup_tasks",
    ],
)

celery_app.conf.update(
    # Serialisation
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    # Timezone
    timezone="UTC",
    enable_utc=True,
    # Routing (separate queues)
    task_routes={
        "app.workers.ai_tasks.*": {"queue": "ai"},
        "app.workers.email_tasks.*": {"queue": "email"},
        "app.workers.notification_tasks.*": {"queue": "default"},
        "app.workers.sla_tasks.*": {"queue": "default"},
        "app.workers.cleanup_tasks.*": {"queue": "default"},
    },
    # Reliability
    task_acks_late=True,              # ack after task completes (survive worker crash)
    task_reject_on_worker_lost=True,  # requeue if worker dies
    worker_prefetch_multiplier=1,     # fair dispatch (esp. important for AI tasks)
    # Result expiry
    result_expires=86400,             # 24 hours
    # Retry defaults
    task_max_retries=3,
    task_default_retry_delay=60,      # 1 minute between retries
)

# ── Celery Beat Schedule ──────────────────────────────────────────────────────
celery_app.conf.beat_schedule = {
    # SLA checker — every 15 minutes
    "check-sla-breaches": {
        "task": "app.workers.sla_tasks.check_sla_breaches",
        "schedule": crontab(minute="*/15"),
        "options": {"queue": "default"},
    },
    # Retention policy cleanup — daily at 3am UTC
    "cleanup-expired-documents": {
        "task": "app.workers.cleanup_tasks.cleanup_expired_documents",
        "schedule": crontab(hour=3, minute=0),
        "options": {"queue": "default"},
    },
    # Stale embedding refresh — daily at 2am UTC
    "refresh-stale-embeddings": {
        "task": "app.workers.ai_tasks.refresh_stale_embeddings",
        "schedule": crontab(hour=2, minute=0),
        "options": {"queue": "ai"},
    },
}
