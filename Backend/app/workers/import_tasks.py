"""
DocFlow — Celery Worker: document import (spec FR-9.6).

Runs the extract/detect pipeline off the request thread and writes its
progress onto the job row, which the UI polls every 3 seconds.

The LLM pass is the only step that leaves this machine, and it only runs when
`job.use_llm` is true — which the author sets per import, with the toggle
hidden entirely when the organisation's AI switch is off. A failure in that
pass is never fatal: the rule-based detections are already saved, so the
import still lands and the UI says the AI step did not run (FR-9.6 "graceful
fallback to manual marking if AI fails").
"""
from __future__ import annotations

import asyncio
import uuid

import structlog
from sqlalchemy import select

from celery.exceptions import SoftTimeLimitExceeded

from app.config import settings
from app.core.celery_app import celery_app
from app.core.storage import download_object
from app.database import async_session_factory
from app.domain.permissions import AuthUser
from app.models.document import FileAsset
from app.models.import_job import ImportJob, ImportStatus
from app.services.document_importer import ImportError_
from app.services.import_service import STAGES, ImportService

logger = structlog.get_logger(__name__)

#: Hard ceiling on what we will pull into memory to convert.
MAX_IMPORT_BYTES = 25 * 1024 * 1024


#: FR-9.6 "timeout handling". Without a limit a document that makes the
#: converter spin would leave the job in `extracting` forever and the UI
#: polling it forever. soft_time_limit raises inside the task so the handler
#: below can mark the job failed with something the user can act on;
#: time_limit is the hard backstop if even that hangs.
@celery_app.task(
    name="app.workers.import_tasks.run_import", bind=True, max_retries=2,
    soft_time_limit=120, time_limit=180,
)
def run_import(self, job_id: str) -> dict:
    return asyncio.run(_run(uuid.UUID(job_id)))


async def _set(db, job: ImportJob, status: str, *, error: str | None = None) -> None:
    job.status = status
    stage, progress = STAGES.get(status, (status.title(), job.progress))
    job.stage = stage if error is None else "Failed"
    job.progress = progress if error is None else job.progress
    if error:
        job.error = error[:2000]
    await db.commit()


async def _run(job_id: uuid.UUID) -> dict:
    async with async_session_factory() as db:
        job = (
            await db.execute(select(ImportJob).where(ImportJob.id == job_id))
        ).scalar_one_or_none()
        if job is None:
            logger.warning("import_job_missing", job_id=str(job_id))
            return {"ok": False, "reason": "missing"}
        if job.status == ImportStatus.CANCELLED:
            return {"ok": False, "reason": "cancelled"}

        svc = ImportService(db)

        # ── 1. fetch the bytes ────────────────────────────────────────────
        await _set(db, job, ImportStatus.EXTRACTING)
        asset = None
        if job.file_asset_id:
            asset = (
                await db.execute(
                    select(FileAsset).where(
                        FileAsset.id == job.file_asset_id,
                        # Org check in the worker too: the job row and the
                        # asset are independent, and a mismatch should never
                        # silently read another organisation's file.
                        FileAsset.org_id == job.org_id,
                    )
                )
            ).scalar_one_or_none()
        if asset is None:
            await _set(db, job, ImportStatus.FAILED, error="The uploaded file could not be found.")
            return {"ok": False, "reason": "no_asset"}

        try:
            data = download_object(
                settings.S3_BUCKET_DOCUMENTS, asset.storage_key, max_bytes=MAX_IMPORT_BYTES
            )
        except Exception as exc:
            logger.warning("import_download_failed", job_id=str(job_id), exc_info=True)
            await _set(db, job, ImportStatus.FAILED, error="The uploaded file could not be read.")
            return {"ok": False, "reason": "download", "error": str(exc)}

        # ── 2. convert + sanitize + rule detection ────────────────────────
        try:
            result = svc.extract_and_detect(data, job)
        except ImportError_ as exc:
            await _set(db, job, ImportStatus.FAILED, error=str(exc))
            return {"ok": False, "reason": "convert"}
        except SoftTimeLimitExceeded:
            await _set(
                db, job, ImportStatus.FAILED,
                error="That document took too long to convert. Try a smaller or simpler file.",
            )
            return {"ok": False, "reason": "timeout"}
        except Exception as exc:
            logger.error("import_convert_crashed", job_id=str(job_id), exc_info=True)
            await _set(
                db, job, ImportStatus.FAILED,
                error="That document could not be converted. Try re-saving it and importing again.",
            )
            return {"ok": False, "reason": "crash", "error": str(exc)}

        job.content = result["content"]
        job.content_hash = result["content_hash"]
        job.detections = result["detections"]
        job.warnings = result["warnings"]
        job.page_count = result["page_count"]
        job.char_count = result["char_count"]
        await db.commit()

        rule_count = len(result["detections"])

        # ── 3. optional LLM pass ──────────────────────────────────────────
        if job.use_llm:
            await _set(db, job, ImportStatus.DETECTING)
            try:
                merged = await _llm_pass(db, job, result["text"], result["detections"])
                job.detections = merged
                await db.commit()
            except Exception as exc:
                # Non-fatal by design: the rule detections stand.
                logger.warning("import_llm_pass_failed", job_id=str(job_id), exc_info=True)
                warnings = list(job.warnings or [])
                warnings.append(
                    "The AI pass didn't run, so only the blanks found by the "
                    "standard rules are listed. You can mark any others by hand."
                )
                job.warnings = warnings
                await db.commit()
                del exc

        await _set(db, job, ImportStatus.READY)
        logger.info(
            "import_ready",
            job_id=str(job_id), rule=rule_count,
            total=len(job.detections or []), used_llm=job.use_llm,
        )
        return {"ok": True, "detections": len(job.detections or [])}


async def _llm_pass(db, job: ImportJob, text: str, existing: list[dict]) -> list[dict]:
    """
    Ask the model for the blanks the rules cannot see, and merge.

    Anything the model returns that does not literally appear in the document
    is dropped by `detect_blanks` itself, and anything overlapping a rule
    detection is dropped here -- the deterministic result always wins, because
    it is the one we can explain.
    """
    from app.services.ai_assist_service import AIAssistService

    user = AuthUser(
        id=job.created_by,
        org_id=job.org_id,

        roles=set(),
        permissions=set(),
    )
    svc = AIAssistService(db)
    result = await svc.detect_blanks(user, document_text=text)

    taken = [(int(d["start"]), int(d["end"])) for d in existing]

    def overlaps(a: int, b: int) -> bool:
        return any(a < end and b > start for start, end in taken)

    merged = list(existing)
    for raw in result.get("blanks") or []:
        snippet = (raw.get("snippet") or raw.get("original") or "").strip()
        if not snippet:
            continue
        # Locate the snippet in the real text; the model does not get to say
        # where it is, only what it is.
        at = text.find(snippet)
        if at == -1 or overlaps(at, at + len(snippet)):
            continue
        key = (raw.get("key") or "").strip()[:64]
        if not key:
            continue
        taken.append((at, at + len(snippet)))
        merged.append({
            "start": at,
            "end": at + len(snippet),
            "original": snippet,
            "key": key,
            "label": (raw.get("label") or key.replace("_", " ").capitalize())[:200],
            "type": raw.get("type") or "text",
            "confidence": raw.get("confidence") or "medium",
            "reason": raw.get("reason") or "Suggested by AI from the surrounding text",
            "source": "ai",
        })

    merged.sort(key=lambda d: d["start"])
    return merged
