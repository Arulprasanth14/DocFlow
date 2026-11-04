"""
DocFlow Backend — Router: document import (spec FR-9).

  POST   /imports                 start a job for an already-uploaded file
  GET    /imports/{id}            poll status / collect the result
  GET    /imports/{id}/stream     server-sent progress events (FR-9.6)
  POST   /imports/{id}/cancel     stop waiting on one
  POST   /imports/{id}/apply      turn the reviewed result into a template

Every route is scoped to the caller's organisation AND to the caller: an
import holds the full text of a document its owner has not yet decided to
share, so another member of the same org gets a 404, not a 403.
"""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncGenerator
from uuid import UUID

import structlog
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.core.exceptions import ForbiddenException
from app.database import AsyncSessionFactory
from app.dependencies import CurrentUser, DatabaseDep
from app.schemas.import_job import (
    ImportApplyRequest,
    ImportCreateRequest,
    ImportJobResponse,
)
from app.schemas.org import MessageResponse
from app.schemas.template import TemplateDetailResponse
from app.services.import_service import ImportService

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["imports"])


def _to_response(job) -> ImportJobResponse:
    # Re-derive rather than store: the text is a pure function of the content,
    # and keeping one copy means they can never drift apart.
    text = ""
    if job.content:
        from app.services.import_service import _index_text_nodes
        _, text = _index_text_nodes(job.content)
    return ImportJobResponse(
        id=job.id,
        filename=job.filename,
        source_kind=job.source_kind,
        file_asset_id=job.file_asset_id,
        status=job.status,
        stage=job.stage,
        progress=job.progress,
        use_llm=job.use_llm,
        page_count=job.page_count,
        char_count=job.char_count,
        content=job.content,
        text=text,
        detections=job.detections or [],
        warnings=job.warnings or [],
        error=job.error,
        template_id=job.template_id,
        created_at=job.created_at,
    )


@router.post(
    "",
    response_model=ImportJobResponse,
    status_code=201,
)
async def start_import(
    body: ImportCreateRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> ImportJobResponse:
    """
    Queue a conversion of an uploaded document into a template draft.

    The file must already have gone through POST /files/confirm-upload, which
    is where the antivirus scan and macro stripping happen (FR-9.8) -- this
    route never accepts raw bytes.
    """
    if not current_user.org_id:
        raise ForbiddenException("No organization context")

    svc = ImportService(db)
    job = await svc.create(
        current_user,
        filename=body.filename,
        mime_type=body.mime_type,
        file_asset_id=body.file_asset_id,
        use_llm=body.use_llm,
    )

    # Dispatch after the row is committed, so the worker cannot race ahead of
    # the job it is meant to pick up.
    try:
        from app.workers.import_tasks import run_import
        run_import.delay(str(job.id))
    except Exception:
        # A broker that is down should surface as a failed job the user can
        # retry, not as a 500 on a request that already saved a row.
        logger.error("import_dispatch_failed", job_id=str(job.id), exc_info=True)
        job.status = "failed"
        job.stage = "Failed"
        job.error = "The import service is not running. Please try again shortly."
        await db.commit()

    return _to_response(job)


@router.get("/{job_id}", response_model=ImportJobResponse)
async def get_import(
    job_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> ImportJobResponse:
    """Poll an import. The client stops polling once status is terminal."""
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    job = await ImportService(db).get(job_id, current_user)
    return _to_response(job)


@router.post("/{job_id}/cancel", response_model=MessageResponse)
async def cancel_import(
    job_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> MessageResponse:
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    await ImportService(db).cancel(job_id, current_user)
    return MessageResponse(message="Import cancelled")


@router.post(
    "/{job_id}/apply",
    response_model=TemplateDetailResponse,
)
async def apply_import(
    job_id: UUID,
    body: ImportApplyRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> TemplateDetailResponse:
    """
    Create a draft template from the reviewed import.

    Refuses if applying the accepted blanks would change any text outside
    those blanks (FR-9.4).
    """
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    svc = ImportService(db)
    return await svc.apply(
        job_id,
        current_user,
        accepted=[a.model_dump() for a in body.accepted],
        name=body.name,
    )


# ── streaming progress (FR-9.6) ───────────────────────────────────────────────
#
# The spec asks for streamed progress, not a client that asks "are you done
# yet?" every three seconds. This is a server-sent-events stream: one `stage`
# event whenever the job's stage or status changes, then a final `done` event
# and the connection closes.
#
# Notes on the shape of it:
#
#  * Each tick opens its own short-lived session instead of holding the
#    request's session open for the life of the stream. A stream can last two
#    minutes; a connection from the pool held that long, times the number of
#    concurrent imports, is how a pool runs dry.
#  * Only *changes* are sent. A stream that re-sends the same stage every
#    second is a poll with extra steps.
#  * A heartbeat comment goes out every 15 seconds. Proxies close idle
#    connections, and an SSE comment is the standard way to stay alive without
#    the client having to understand a new event type.
#  * The stream has a hard deadline. If the job is still running when it
#    expires, the client is told to reconnect rather than left on a socket
#    nobody is going to write to.
#  * The client keeps its 3-second poll as a fallback. A stream is better when
#    it works, and it must not be the only way to learn that a job finished —
#    corporate proxies buffer text/event-stream often enough that treating it
#    as the single source of truth would strand users.

#: Terminal states. Reaching one ends the stream.
_IMPORT_DONE = {"ready", "failed", "cancelled", "applied"}
#: How long one connection may live before the client is asked to reconnect.
_STREAM_SECONDS = 120
#: How often the job is re-read.
_STREAM_TICK = 1.0
#: How often a keep-alive comment goes out while nothing changes.
_STREAM_HEARTBEAT = 15.0


def _sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"


@router.get("/{job_id}/stream")
async def stream_import(
    job_id: UUID,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> StreamingResponse:
    """
    Stream an import job's progress as server-sent events (FR-9.6).

    Events:
      `stage` — `{status, stage, progress}` on every change
      `done`  — `{status}` once, when the job reaches a terminal state
      `timeout` — `{status}` if the deadline passes first; reconnect to continue
    """
    if not current_user.org_id:
        raise ForbiddenException("No organization context")

    # Authorise once, on the request's own session, before opening the stream:
    # a 404 must arrive as a 404 and not as an error event inside a 200.
    job = await ImportService(db).get(job_id, current_user)
    first = {"status": job.status, "stage": job.stage or "", "progress": job.progress or 0}

    async def events() -> AsyncGenerator[str, None]:
        yield _sse("stage", first)
        if job.status in _IMPORT_DONE:
            yield _sse("done", {"status": job.status})
            return

        last = first
        started = time.monotonic()
        last_beat = started

        while True:
            await asyncio.sleep(_STREAM_TICK)
            now = time.monotonic()

            try:
                async with AsyncSessionFactory() as session:
                    current = await ImportService(session).get(job_id, current_user)
                    snapshot = {
                        "status": current.status,
                        "stage": current.stage or "",
                        "progress": current.progress or 0,
                    }
            except Exception:  # noqa: BLE001
                # The job was deleted, or the database hiccuped. Either way the
                # client's poll is the safety net; end the stream quietly.
                logger.warning("import_stream_read_failed", job_id=str(job_id))
                yield _sse("timeout", {"status": last["status"]})
                return

            if snapshot != last:
                last = snapshot
                last_beat = now
                yield _sse("stage", snapshot)

            if snapshot["status"] in _IMPORT_DONE:
                yield _sse("done", {"status": snapshot["status"]})
                return

            if now - started >= _STREAM_SECONDS:
                yield _sse("timeout", {"status": snapshot["status"]})
                return

            if now - last_beat >= _STREAM_HEARTBEAT:
                last_beat = now
                yield ": keep-alive\n\n"

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            # Nginx buffers proxied responses by default, which turns a stream
            # into one delivery at the end. This is the documented opt-out.
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
