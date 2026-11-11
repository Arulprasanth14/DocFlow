"""
DocFlow — Service: review renditions (section 6.4.1), task P3-3

The approval viewer renders PDF and nothing else (AP-VWR-01). An owner who
submits a .docx must still be reviewable, so the file is converted once and
the resulting PDF is kept beside the version as its rendition.

Why a stored rendition rather than converting on demand: converting spawns a
whole office suite and takes seconds to minutes. Doing that inside the
request that opens the approval screen would make the screen appear broken,
and doing it per page-load would do the same work for every approver on a
multi-stage workflow.

Why not DocFlow's own `pdf_renderer`: that renders our block structure, which
means re-flowing the document. The approver signs against the artefact the
owner submitted, and a re-flowed copy is a different artefact - different
pagination, so an annotation anchored to "page 3" means something else.
soffice preserves the layout.

**The rendition is never the source of truth.** `document_versions.checksum`
is still the hash of the bytes the owner uploaded, and that is what a
signature binds to (AP-APR-03). The rendition is a view of it.
"""
from __future__ import annotations

import uuid

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.document import Document, DocumentVersion, FileAsset
from app.services.document_importer import (
    RenditionError,
    assert_pdf_is_reviewable,
    convert_to_pdf,
    needs_rendition,
)

logger = structlog.get_logger(__name__)

PDF_MIME = "application/pdf"


class RenditionService:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    # -- Planning ------------------------------------------------------------

    async def mark_initial_state(self, version: DocumentVersion) -> str:
        """Decide, at upload time, whether this version needs converting.

        Recorded rather than inferred on every read: 'not_needed' is a real
        answer, and without it the worker would re-examine every PDF in the
        system on every sweep looking for work that does not exist.
        """
        filename, mime = await self._file_hints(version)
        if version.storage_key is None and version.rendition_file_id is None:
            # A form-only document has no uploaded file at all; it is rendered
            # from its own content by `pdf_tasks`, not by this service.
            version.rendition_status = "not_needed"
        elif needs_rendition(filename, mime):
            version.rendition_status = "pending"
        else:
            version.rendition_status = "not_needed"
        version.rendition_error = None
        await self.db.flush()
        return version.rendition_status

    async def _file_hints(self, version: DocumentVersion) -> tuple[str, str | None]:
        """A filename and mime type to decide on, best-effort.

        `document_versions` stores a storage key and a mime type but not the
        original filename, so the key's last segment stands in for it - which
        is what `build_storage_key` puts there.
        """
        name = (version.storage_key or "").rsplit("/", 1)[-1]
        return name, version.mime_type

    # -- Doing the work ------------------------------------------------------

    async def build(self, version_id: uuid.UUID) -> dict:
        """Produce the rendition for one version. Idempotent.

        Returns a small dict for the worker's log. Never raises for a
        conversion failure: a file that cannot be converted is a recorded
        state ('failed' with a message the owner can act on), not an
        exception for the queue to retry forever.
        """
        version = await self.db.get(DocumentVersion, version_id)
        if version is None or version.deleted_at is not None:
            return {"status": "missing", "version_id": str(version_id)}
        if version.rendition_status == "ready" and version.rendition_file_id:
            return {"status": "ready", "cached": True}
        if version.rendition_status == "not_needed":
            return {"status": "not_needed"}
        if version.storage_key is None:
            version.rendition_status = "not_needed"
            await self.db.flush()
            return {"status": "not_needed"}

        doc = await self.db.get(Document, version.document_id)
        if doc is None:
            return {"status": "missing", "reason": "document gone"}

        filename, mime = await self._file_hints(version)
        try:
            source = await self._download(version)
            pdf_bytes = convert_to_pdf(source, filename=filename)
            page_count = assert_pdf_is_reviewable(pdf_bytes, filename=filename)
        except RenditionError as exc:
            # Expected failure: a password-protected file, a corrupt one, a
            # format soffice cannot handle. The message goes on the row so the
            # owner sees something they can act on.
            version.rendition_status = "failed"
            version.rendition_error = str(exc)[:2000]
            await self.db.flush()
            logger.info(
                "rendition_failed", version_id=str(version_id), reason=str(exc)
            )
            return {"status": "failed", "error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            # Unexpected failure: still recorded, but with a message that does
            # not pretend to explain it, and logged at error so it is visible.
            version.rendition_status = "failed"
            version.rendition_error = (
                "A review copy of this file could not be prepared. "
                "An administrator has been notified."
            )
            await self.db.flush()
            logger.error(
                "rendition_error", version_id=str(version_id), error=str(exc)
            )
            return {"status": "failed", "error": str(exc)}

        asset = await self._store(doc, version, pdf_bytes)
        version.rendition_file_id = asset.id
        version.rendition_status = "ready"
        version.rendition_error = None
        version.rendition_page_count = page_count
        await self.db.flush()
        logger.info(
            "rendition_ready", version_id=str(version_id), pages=page_count
        )
        return {"status": "ready", "pages": page_count}

    async def _download(self, version: DocumentVersion) -> bytes:
        import asyncio

        from app.core.storage import download_object
        from app.services.document_importer import MAX_RENDITION_BYTES

        # Blocking S3 read: keep it off the event loop.
        return await asyncio.to_thread(
            download_object,
            settings.S3_BUCKET_DOCUMENTS,
            version.storage_key,
            MAX_RENDITION_BYTES,
        )

    async def _store(
        self, doc: Document, version: DocumentVersion, pdf_bytes: bytes
    ) -> FileAsset:
        """Put the PDF in object storage and record it as a FileAsset.

        A FileAsset rather than a bare storage key, so the rendition is
        covered by the same access checks, retention sweep and deletion path
        as every other stored file - a second, parallel notion of "a file we
        keep somewhere" is how orphaned objects accumulate.
        """
        import asyncio

        from app.core.storage import compute_checksum, replace_object

        asset_id = uuid.uuid4()
        key = (
            f"orgs/{doc.org_id}/files/renditions/"
            f"{version.document_id}/{version.id}.pdf"
        )
        await asyncio.to_thread(
            replace_object,
            settings.S3_BUCKET_DOCUMENTS,
            key,
            pdf_bytes,
            PDF_MIME,
        )
        asset = FileAsset(
            id=asset_id,
            org_id=doc.org_id,
            document_id=doc.id,
            uploaded_by=version.uploaded_by,
            filename=f"{doc.title or 'document'}.pdf",
            mime_type=PDF_MIME,
            size_bytes=len(pdf_bytes),
            storage_key=key,
            bucket=settings.S3_BUCKET_DOCUMENTS,
            storage_mode=settings.STORAGE_BACKEND,
            checksum=compute_checksum(pdf_bytes),
        )
        self.db.add(asset)
        await self.db.flush()
        return asset

    # -- The submit-time gate (WF-REV-09, E15) ------------------------------

    async def assert_version_reviewable(self, version: DocumentVersion) -> None:
        """Refuse a version that cannot be displayed for review.

        WF-REV-09 / E15 want this "at upload". Uploads go client-direct to
        object storage via a presigned PUT, so the server never sees the
        bytes during the upload itself - the earliest point at which it holds
        them and the earliest point at which being unreadable actually
        matters are both here, at submit.

        Submit is the right gate regardless: a document that cannot be opened
        must not enter review, because by the time an approver discovers it
        the run is live, an approver has been notified, and the owner has
        been told their document is in review. Refusing here leaves the owner
        with a file they can fix and nothing to undo.

        Only PDFs are checked synchronously, and only because the check is a
        header parse. An office file needs a full conversion, which would put
        minutes into this request; those are converted in the background and
        a failure surfaces on the approval screen as a reported state.
        """
        from app.core.exceptions import UnprocessableEntityException

        if version.storage_key is None:
            return
        filename, mime = await self._file_hints(version)
        is_pdf = filename.lower().endswith(".pdf") or (mime or "") == "application/pdf"
        if not is_pdf:
            return

        try:
            data = await self._download(version)
            page_count = assert_pdf_is_reviewable(data, filename=filename)
        except RenditionError as exc:
            # Recorded as well as refused: if the owner retries the
            # submission the reason is already on the row, and the approval
            # screen would show the same message rather than a blank viewer.
            version.rendition_status = "failed"
            version.rendition_error = str(exc)[:2000]
            await self.db.flush()
            raise UnprocessableEntityException(str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            # Could not read it from storage at all. NOT a refusal: the file
            # may be perfectly fine and the storage call may have failed, and
            # blocking a submission on our own infrastructure problem would
            # be the wrong trade.
            logger.warning(
                "pdf_precheck_unavailable",
                version_id=str(version.id), error=str(exc),
            )
            return

        version.rendition_status = "not_needed"
        version.rendition_error = None
        version.rendition_page_count = page_count
        await self.db.flush()

    # -- What the viewer asks for -------------------------------------------

    async def viewable_file(
        self, version: DocumentVersion
    ) -> tuple[FileAsset | None, str, str | None]:
        """The file the viewer should render, and why if there is none.

        Returns `(asset_or_None, status, message)`. A PDF upload is served
        directly; anything else is served from its rendition. `status` is what
        the client switches on, so a failure is a state the UI can render
        rather than an error it has to guess at (UX-INT-01).
        """
        if version.rendition_status == "failed":
            return None, "failed", version.rendition_error
        if version.rendition_status == "pending":
            return None, "pending", None

        if version.rendition_file_id:
            asset = await self.db.get(FileAsset, version.rendition_file_id)
            # `deleted_at` is checked explicitly: this codebase has no global
            # soft-delete filter, so `db.get()` happily returns a row the
            # retention sweep has already retired. Serving one would hand the
            # viewer a presigned URL for an object that may no longer exist.
            if asset is not None and asset.deleted_at is None:
                return asset, "ready", None
            # The rendition is gone. Re-queue and rebuild it rather than
            # showing a broken viewer.
            version.rendition_status = "pending"
            version.rendition_file_id = None
            await self.db.flush()
            return None, "pending", None

        # No rendition recorded. Either the upload is already a PDF, or
        # nothing has decided yet.
        filename, mime = await self._file_hints(version)
        if version.storage_key and not needs_rendition(filename, mime):
            asset = (
                await self.db.execute(
                    select(FileAsset).where(
                        FileAsset.storage_key == version.storage_key,
                        FileAsset.deleted_at.is_(None),
                    ).limit(1)
                )
            ).scalars().first()
            if asset is not None:
                return asset, "ready", None
            # The bytes exist but no FileAsset row describes them; the
            # endpoint can still presign the key directly.
            return None, "ready_raw", None

        if version.rendition_status is None:
            await self.mark_initial_state(version)
            return None, version.rendition_status or "pending", None
        return None, "pending", None


async def presign_for_viewer(
    db: AsyncSession, version: DocumentVersion, *, filename: str,
) -> tuple[str | None, int | None, str, str | None]:
    """An inline, short-lived URL for the review viewer.

    Returns `(url, expires_in, status, message)`. The URL is minted per
    request and never stored: AP-VWR-04 caps its life at five minutes, which
    only means anything if a fresh one is issued each time the viewer asks.
    """
    import asyncio

    from app.core.storage import (
        MAX_INLINE_URL_SECONDS,
        generate_presigned_download_url,
    )

    svc = RenditionService(db)
    asset, status, message = await svc.viewable_file(version)

    if status in ("pending", "failed"):
        return None, None, status, message

    key = asset.storage_key if asset is not None else version.storage_key
    bucket = asset.bucket if asset is not None else settings.S3_BUCKET_DOCUMENTS
    if not key:
        return None, None, "failed", "This version has no file attached."

    url = await asyncio.to_thread(
        generate_presigned_download_url,
        bucket,
        key,
        filename,
        MAX_INLINE_URL_SECONDS,
        inline=True,
    )
    return url, MAX_INLINE_URL_SECONDS, "ready", None


async def queue_rendition(version_id: uuid.UUID) -> None:
    """Hand a version to the rendition worker.

    Best-effort: if the broker is unreachable the row stays 'pending' and the
    sweep picks it up, so a submission is never blocked by the queue being
    down.
    """
    try:
        from app.workers.rendition_tasks import build_rendition

        # retry=False: fail fast if the broker is down instead of holding
        # the submitting request open; the sweep picks the version up.
        build_rendition.apply_async(args=[str(version_id)], retry=False)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "rendition_enqueue_failed", version_id=str(version_id), error=str(exc)
        )

