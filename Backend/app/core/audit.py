"""
DocFlow — Core: audit-log writes (Auth/RBAC spec section 14.2, Gap #19).

Auth and RBAC events used to go to structlog only, which means they were not
visible through `admin:audit` - the screen an administrator actually looks at
when asking "who changed this". This is the one helper that writes them, so
the field names stay consistent across the services that call it.

`audit_logs.org_id` is NOT NULL, so an event with no organization context (a
sign-in by a user who has not joined one yet, a failed sign-in where the
account is unknown) cannot be stored here at all. Those stay in structlog;
`write_audit_event` returns False so the caller can tell.

Never raises: an audit write must not be the reason a legitimate action fails.
A failure is logged loudly instead, because a silently missing audit trail is
worse than a noisy one.
"""
from __future__ import annotations

import uuid

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditLog

logger = structlog.get_logger(__name__)


async def write_audit_event(
    db: AsyncSession,
    *,
    org_id: uuid.UUID | None,
    actor_id: uuid.UUID | None,
    action: str,
    resource_type: str,
    resource_id: uuid.UUID,
    actor_role: str | None = None,
    before: dict | None = None,
    after: dict | None = None,
    commit: bool = False,
) -> bool:
    """Append one audit row. Returns True when it was written.

    `commit=False` (the default) leaves the row in the caller's transaction,
    so the event and the change it describes land together or not at all.
    `commit=True` is for callers that have already committed the change.
    """
    if org_id is None:
        logger.info(
            "audit_event_without_org_not_stored",
            action=action, actor_id=str(actor_id) if actor_id else None,
        )
        return False

    try:
        db.add(
            AuditLog(
                org_id=org_id,
                actor_id=actor_id,
                actor_role=actor_role,
                action=action,
                resource_type=resource_type,
                resource_id=resource_id,
                before=before,
                after=after,
            )
        )
        if commit:
            await db.commit()
        else:
            await db.flush()
        return True
    except Exception as exc:  # noqa: BLE001 - never fail the action being audited
        logger.error(
            "audit_event_write_failed",
            action=action, error=f"{type(exc).__name__}: {exc}",
        )
        return False
