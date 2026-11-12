"""
DocFlow — Service: audit CSV export (X-AUD-04), task P4-11

Org Admins only. Streams rather than building the file in memory: an audit
log is append-only and grows forever, so a year of it must not have to fit
in the worker's RAM before the first byte reaches the browser.

Two deliberate choices about content:

**`before` and `after` are emitted as JSON text, not flattened into
columns.** Their shape differs per action, and flattening would either lose
fields or produce a sheet with hundreds of mostly-empty columns. A reader who
wants one field can filter the JSON; a reader who wants an overview reads the
other columns.

**Names are resolved, and the actor id is kept as well.** An export that only
has UUIDs cannot be read by the person who asked for it, and one that only
has names cannot be matched against anything else later.
"""
from __future__ import annotations

import csv
import io
import uuid
from collections.abc import AsyncIterator
from datetime import datetime

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenException
from app.domain.permissions import AuthUser
from app.models.audit import AuditLog
from app.models.user import User

logger = structlog.get_logger(__name__)

COLUMNS = (
    "timestamp", "action", "actor_name", "actor_email", "actor_id",
    "actor_role", "resource_type", "resource_id", "workflow_instance_id",
    "before", "after",
)

#: Rows fetched per round trip. Large enough that a big export is not
#: thousands of queries, small enough that one batch is a sensible chunk to
#: hold and hand to the client.
BATCH = 500


async def stream_audit_csv(
    db: AsyncSession,
    actor: AuthUser,
    *,
    org_id: uuid.UUID,
    instance_id: uuid.UUID | None = None,
    resource_id: uuid.UUID | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> AsyncIterator[str]:
    """Yield the audit log as CSV text, oldest first.

    Scoped to the caller's organization always (BR-12): `org_id` comes from
    the authenticated user, never from a query parameter, so there is no
    parameter to tamper with.
    """
    # Authorization is enforced by the ROUTE, before the StreamingResponse is
    # constructed. It cannot live here: FastAPI consumes this generator after
    # the response has started, so a ForbiddenException raised at this point
    # never reaches the exception handler - it surfaced as an unhandled error
    # (HTTP 500 / a torn stream) instead of a 403. Found by the role x
    # endpoint matrix.

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")

    def flush() -> str:
        value = buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
        return value

    writer.writerow(COLUMNS)
    yield flush()

    query = select(AuditLog).where(AuditLog.org_id == org_id)
    if instance_id is not None:
        query = query.where(AuditLog.instance_id == instance_id)
    if resource_id is not None:
        query = query.where(AuditLog.resource_id == resource_id)
    if since is not None:
        query = query.where(AuditLog.created_at >= since)
    if until is not None:
        query = query.where(AuditLog.created_at <= until)
    # Oldest first: an audit trail is read as a sequence of events.
    query = query.order_by(AuditLog.created_at.asc(), AuditLog.id.asc())

    names: dict[uuid.UUID, tuple[str, str]] = {}
    exported = 0
    offset = 0

    while True:
        rows = (
            await db.execute(query.offset(offset).limit(BATCH))
        ).scalars().all()
        if not rows:
            break
        offset += len(rows)

        unknown = {
            r.actor_id for r in rows
            if r.actor_id is not None and r.actor_id not in names
        }
        if unknown:
            for user in (
                await db.execute(select(User).where(User.id.in_(unknown)))
            ).scalars().all():
                names[user.id] = (user.name or "", user.email or "")

        for row in rows:
            name, email = names.get(row.actor_id, ("", "")) if row.actor_id else ("", "")
            writer.writerow([
                row.created_at.isoformat() if row.created_at else "",
                row.action or "",
                name,
                email,
                str(row.actor_id) if row.actor_id else "",
                # The role the actor held AT THE TIME, which is the whole
                # point of snapshotting it on the row: their role today says
                # nothing about what they were allowed to do then.
                row.actor_role or "",
                row.resource_type or "",
                str(row.resource_id) if row.resource_id else "",
                str(row.instance_id) if row.instance_id else "",
                _as_json(row.before),
                _as_json(row.after),
            ])
            exported += 1
        yield flush()

        if len(rows) < BATCH:
            break

    logger.info(
        "audit_exported", org_id=str(org_id), actor_id=str(actor.id),
        rows=exported,
    )


def _as_json(value: object) -> str:
    if value is None:
        return ""
    import json

    try:
        return json.dumps(value, default=str, sort_keys=True)
    except (TypeError, ValueError):
        # Never fail an export over one unserializable row.
        return str(value)
