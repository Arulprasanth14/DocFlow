"""
DocFlow Backend — Router: Presigned File URLs (S3/MinIO)
Endpoints:
  POST /api/v1/files/upload-url        — generate a presigned PUT URL for client upload
  POST /api/v1/files/confirm-upload    — record the FileAsset after the client PUT succeeds
  GET  /api/v1/files/download-url/{key} — generate a presigned GET URL for client download

Upload flow (client never sends file bytes through this backend):
  1. POST /upload-url    → presigned PUT URL + storage_key
  2. Client PUTs the file directly to that URL (S3/MinIO)
  3. POST /confirm-upload → creates the FileAsset row, returns file_asset_id
  4. POST /documents/{id}/attachments with that file_asset_id
"""
from __future__ import annotations

import uuid
from typing import Annotated

import structlog

from fastapi import APIRouter, HTTPException, Path, Response, status
from pydantic import BaseModel, Field

from app.config import settings
from app.core.exceptions import ForbiddenException
from app.dependencies import CurrentUser, DatabaseDep
from app.core.storage import (
    ALLOWED_MIME_TYPES,
    MULTIPART_MIN_BYTES,
    MULTIPART_PART_SIZE,
    UploadSessionGone,
    abort_multipart_upload,
    build_storage_key,
    complete_multipart_upload,
    create_multipart_upload,
    delete_object,
    download_object,
    generate_presigned_download_url,
    generate_presigned_upload_url,
    list_multipart_parts,
    presign_upload_part,
    replace_object,
    validate_file,
)
from app.services.antivirus import ScanStatus, scan_upload

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/files", tags=["Files"])


class UploadURLRequest(BaseModel):
    filename: str = Field(..., description="Original filename")
    mime_type: str = Field(..., description="MIME type of the file to be uploaded")
    size_bytes: int = Field(..., gt=0, description="Size of file in bytes")


class UploadURLResponse(BaseModel):
    upload_url: str
    storage_key: str
    bucket: str


class ConfirmUploadRequest(BaseModel):
    storage_key: str = Field(..., description="storage_key returned by /upload-url")
    bucket: str
    filename: str = Field(..., max_length=500)
    mime_type: str
    size_bytes: int = Field(..., gt=0)


class ConfirmUploadResponse(BaseModel):
    file_asset_id: str
    # Honest reporting of what actually happened to the file (FR-3.3). The UI
    # shows `scan_label` verbatim — it never invents wording of its own, and
    # "Virus scan passed" appears only when a real scanner produced it.
    scan_status: str
    scan_label: str
    scan_detail: str | None = None
    macros_removed: bool = False


class DownloadURLResponse(BaseModel):
    download_url: str
    storage_key: str


@router.post(
    "/upload-url",
    response_model=UploadURLResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate presigned S3/MinIO PUT URL for client upload",
)
async def generate_upload_endpoint(
    req: UploadURLRequest,
    current_user: CurrentUser,
) -> UploadURLResponse:
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    try:
        validate_file(req.filename, req.mime_type, req.size_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    file_id = uuid.uuid4()
    storage_key = build_storage_key(current_user.org_id, file_id, req.filename)
    url = generate_presigned_upload_url(
        bucket=settings.S3_BUCKET_DOCUMENTS,
        storage_key=storage_key,
        mime_type=req.mime_type,
        size_bytes=req.size_bytes,
    )
    return UploadURLResponse(
        upload_url=url,
        storage_key=storage_key,
        bucket=settings.S3_BUCKET_DOCUMENTS,
    )


@router.post(
    "/confirm-upload",
    response_model=ConfirmUploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Record the FileAsset row after the client's direct PUT to storage succeeds",
)
async def confirm_upload_endpoint(
    req: ConfirmUploadRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> ConfirmUploadResponse:
    """
    Previously missing: /upload-url only ever generated a presigned URL — nothing
    created the FileAsset row the rest of the app (attachments, downloads) expects
    to reference by id. This is step 3 of the flow documented in core/storage.py's
    module docstring, implemented here for the first time.
    """
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    if req.mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=400, detail=f"File type '{req.mime_type}' is not allowed")
    # storage_key is namespaced by org (orgs/{org_id}/files/...) — refuse to record
    # an asset under a key that doesn't belong to the caller's own org.
    if f"orgs/{current_user.org_id}/files/" not in req.storage_key:
        raise ForbiddenException("storage_key does not belong to your organization")

    from app.models.document import FileAsset

    # FR-3.3: the bytes went client-direct to storage, so this is the first
    # moment the backend can look at them. Read them back and check before the
    # FileAsset row exists — nothing can reference a file we have rejected.
    data = download_object(req.bucket, req.storage_key, max_bytes=settings.AV_MAX_INLINE_BYTES)
    result = await scan_upload(data, req.filename, req.mime_type)

    if result.blocked:
        # Remove the object as well: a rejected upload must not linger in the
        # bucket where a presigned URL could still reach it.
        try:
            delete_object(req.bucket, req.storage_key)
        except Exception:  # noqa: BLE001 — the rejection matters more than the cleanup
            logger.warning("av_rejected_cleanup_failed", storage_key=req.storage_key)
        raise HTTPException(status_code=400, detail=result.detail or "This file was not accepted.")

    # The macro stripper rewrites the package; put the cleaned bytes back so the
    # only version anyone can download is the one without macros.
    if result.cleaned_bytes is not None:
        replace_object(req.bucket, req.storage_key, result.cleaned_bytes, req.mime_type)

    asset = FileAsset(
        org_id=current_user.org_id,
        uploaded_by=current_user.id,
        filename=req.filename,
        mime_type=req.mime_type,
        size_bytes=len(result.cleaned_bytes) if result.cleaned_bytes is not None else req.size_bytes,
        storage_key=req.storage_key,
        bucket=req.bucket,
        storage_mode=settings.STORAGE_BACKEND,
        # Tri-state on purpose: True only when a real scanner cleared it,
        # False when one found something, NULL when nothing scanned it.
        is_malware_clean=True if result.status is ScanStatus.CLEAN else None,
        metadata_={"av": result.to_metadata()},
    )
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    return ConfirmUploadResponse(
        file_asset_id=str(asset.id),
        scan_status=result.status.value,
        scan_label=result.to_metadata()["label"],
        scan_detail=result.detail,
        macros_removed=result.macros_removed,
    )


@router.get(
    "/download-url/{storage_key:path}",
    response_model=DownloadURLResponse,
    status_code=status.HTTP_200_OK,
    summary="Generate presigned S3/MinIO GET URL for client download",
)
async def generate_download_endpoint(
    storage_key: Annotated[str, Path(...)],
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DownloadURLResponse:
    from sqlalchemy import select
    from app.models.document import FileAsset, Document
    from app.services.document_service import can_user_access_document
    from app.core.exceptions import ForbiddenException
    
    # Check FileAsset to find associated document
    res = await db.execute(select(FileAsset).where(FileAsset.storage_key == storage_key))
    asset = res.scalar_one_or_none()
    
    if asset:
        if asset.org_id != current_user.org_id:
            raise ForbiddenException("You cannot access files from another organization")
            
        if asset.document_id:
            res_doc = await db.execute(select(Document).where(Document.id == asset.document_id))
            doc = res_doc.scalar_one_or_none()
            if doc:
                if not await can_user_access_document(db, current_user, doc):
                    raise ForbiddenException("You do not have permission to download attachments for this document")
        else:
            # Not attached to a document yet. Let the uploader download it (for preview)
            if asset.uploaded_by != current_user.id:
                raise ForbiddenException("You do not have permission to access this unattached file")

    filename = storage_key.split("/")[-1] if "/" in storage_key else storage_key
    url = generate_presigned_download_url(
        bucket=settings.S3_BUCKET_DOCUMENTS,
        storage_key=storage_key,
        filename=filename,
    )
    return DownloadURLResponse(
        download_url=url,
        storage_key=storage_key,
    )


@router.get(
    "/asset/{file_asset_id}/download-url",
    response_model=DownloadURLResponse,
    status_code=status.HTTP_200_OK,
    summary="Presigned GET URL for a FileAsset, addressed by id",
)
async def asset_download_url_endpoint(
    file_asset_id: Annotated[uuid.UUID, Path(...)],
    current_user: CurrentUser,
    db: DatabaseDep,
) -> DownloadURLResponse:
    """
    Resolve a FileAsset id to a short-lived presigned URL.

    Images embedded in a document body store only this id (see
    content_sanitizer: the `image` node has no `src` attribute at all), so the
    document can never carry a URL of its own. Every view goes through this
    check, which means revoking access to the document revokes the image with
    it, and an id copied into another org's document resolves to nothing.
    """
    from sqlalchemy import select

    from app.models.document import Document, FileAsset
    from app.services.document_service import can_user_access_document

    asset = (
        await db.execute(select(FileAsset).where(FileAsset.id == file_asset_id))
    ).scalar_one_or_none()
    # 404 rather than 403 for a foreign asset: an id from another org must not
    # be distinguishable from one that does not exist.
    if asset is None or asset.org_id != current_user.org_id:
        raise HTTPException(status_code=404, detail="File not found")

    if asset.document_id:
        doc = (
            await db.execute(select(Document).where(Document.id == asset.document_id))
        ).scalar_one_or_none()
        if doc and not await can_user_access_document(db, current_user, doc):
            raise ForbiddenException("You do not have permission to view this file")
    elif asset.uploaded_by != current_user.id:
        raise ForbiddenException("You do not have permission to access this file")

    url = generate_presigned_download_url(
        bucket=asset.bucket or settings.S3_BUCKET_DOCUMENTS,
        storage_key=asset.storage_key,
        filename=asset.filename,
    )
    return DownloadURLResponse(download_url=url, storage_key=asset.storage_key)


# ── Resumable upload (FR-3.2) ─────────────────────────────────────────────────
#
# Four endpoints over S3/MinIO multipart upload:
#
#   POST /files/multipart/init      → upload_id + a presigned PUT URL per part
#   (client PUTs each part; it may stop and come back at any point)
#   POST /files/multipart/resume    → which parts landed + fresh URLs for the rest
#   POST /files/multipart/complete  → assemble, then the ordinary confirm pass
#   POST /files/multipart/abort     → discard the parts
#
# The server keeps no session state: storage itself remembers which parts of an
# upload id exist, so `resume` is a question put to storage rather than to a
# table we would have to migrate, expire and clean up. The client holds only
# `{upload_id, storage_key}`, which is enough to come back after a reload.
#
# `complete` reads the part list, with its ETags, from storage rather than
# trusting the client's. That also means the browser never needs to read the
# ETag response header — which requires a CORS ExposeHeaders rule whose
# absence would break every upload in a way that is hard to see.
#
# Nothing above is modified: a file under MULTIPART_MIN_BYTES keeps using the
# single presigned PUT, and this path ends by calling the same confirm
# endpoint, so the antivirus pass, the macro strip and the FileAsset row are
# identical however the bytes arrived.


class MultipartInitRequest(BaseModel):
    filename: str = Field(..., max_length=500)
    mime_type: str
    size_bytes: int = Field(..., gt=0)


class MultipartInitResponse(BaseModel):
    upload_id: str
    storage_key: str
    bucket: str
    part_size: int
    part_count: int
    part_urls: list[str]


class MultipartSessionRequest(BaseModel):
    storage_key: str
    bucket: str
    upload_id: str
    size_bytes: int = Field(..., gt=0)


class MultipartResumeResponse(BaseModel):
    #: Part numbers (1-based) storage already holds — the client skips these.
    uploaded_parts: list[int]
    part_size: int
    part_count: int
    #: Fresh presigned URLs, one per part, index 0 == part 1. Parts already
    #: uploaded get a URL too, so a retry needs no extra round trip.
    part_urls: list[str]


class MultipartCompleteRequest(BaseModel):
    storage_key: str
    bucket: str
    upload_id: str
    filename: str = Field(..., max_length=500)
    mime_type: str
    size_bytes: int = Field(..., gt=0)


class MultipartAbortRequest(BaseModel):
    storage_key: str
    bucket: str
    upload_id: str


def _require_own_key(current_user, storage_key: str) -> None:
    """A storage key is namespaced by org; refuse to act on another org's."""
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    if f"orgs/{current_user.org_id}/files/" not in storage_key:
        raise ForbiddenException("storage_key does not belong to your organization")


def _part_count(size_bytes: int) -> int:
    return max(1, -(-size_bytes // MULTIPART_PART_SIZE))


def _part_urls(bucket: str, storage_key: str, upload_id: str, count: int) -> list[str]:
    return [
        presign_upload_part(bucket, storage_key, upload_id, n)
        for n in range(1, count + 1)
    ]


@router.post(
    "/multipart/init",
    response_model=MultipartInitResponse,
    status_code=status.HTTP_200_OK,
    summary="Begin a resumable (multipart) upload",
)
async def multipart_init_endpoint(
    req: MultipartInitRequest,
    current_user: CurrentUser,
) -> MultipartInitResponse:
    if not current_user.org_id:
        raise ForbiddenException("No organization context")
    try:
        validate_file(req.filename, req.mime_type, req.size_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # Under the threshold the single PUT is strictly better: one round trip and
    # nothing to abandon. Say so rather than quietly doing something slower.
    if req.size_bytes < MULTIPART_MIN_BYTES:
        raise HTTPException(
            status_code=400,
            detail="This file is small enough for a single upload; use /files/upload-url.",
        )

    file_id = uuid.uuid4()
    storage_key = build_storage_key(current_user.org_id, file_id, req.filename)
    bucket = settings.S3_BUCKET_DOCUMENTS
    upload_id = create_multipart_upload(bucket, storage_key, req.mime_type)
    count = _part_count(req.size_bytes)
    logger.info(
        "multipart_upload_started",
        storage_key=storage_key,
        part_count=count,
        size_bytes=req.size_bytes,
    )
    return MultipartInitResponse(
        upload_id=upload_id,
        storage_key=storage_key,
        bucket=bucket,
        part_size=MULTIPART_PART_SIZE,
        part_count=count,
        part_urls=_part_urls(bucket, storage_key, upload_id, count),
    )


@router.post(
    "/multipart/resume",
    response_model=MultipartResumeResponse,
    status_code=status.HTTP_200_OK,
    summary="Ask storage which parts of an interrupted upload already landed",
)
async def multipart_resume_endpoint(
    req: MultipartSessionRequest,
    current_user: CurrentUser,
) -> MultipartResumeResponse:
    _require_own_key(current_user, req.storage_key)
    count = _part_count(req.size_bytes)
    try:
        parts = list_multipart_parts(req.bucket, req.storage_key, req.upload_id)
    except UploadSessionGone:
        # 410 and not 404: the client's saved session was real, it is simply no
        # longer resumable, and the UI should start the file over rather than
        # report an error about a file that is missing.
        raise HTTPException(status_code=410, detail="This upload can no longer be resumed.")
    # A part whose size does not match this part size cannot be reused — treat
    # it as not uploaded so the client sends it again. Only the last part is
    # allowed to be short.
    uploaded = [
        p["part_number"]
        for p in parts
        if p["size"] == MULTIPART_PART_SIZE or p["part_number"] == count
    ]
    return MultipartResumeResponse(
        uploaded_parts=sorted(uploaded),
        part_size=MULTIPART_PART_SIZE,
        part_count=count,
        part_urls=_part_urls(req.bucket, req.storage_key, req.upload_id, count),
    )


@router.post(
    "/multipart/complete",
    response_model=ConfirmUploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Assemble a resumable upload, then scan and record it as usual",
)
async def multipart_complete_endpoint(
    req: MultipartCompleteRequest,
    current_user: CurrentUser,
    db: DatabaseDep,
) -> ConfirmUploadResponse:
    _require_own_key(current_user, req.storage_key)
    expected = _part_count(req.size_bytes)
    try:
        parts = list_multipart_parts(req.bucket, req.storage_key, req.upload_id)
    except UploadSessionGone:
        raise HTTPException(status_code=410, detail="This upload can no longer be resumed.")

    if len(parts) != expected:
        raise HTTPException(
            status_code=409,
            detail=f"This upload is incomplete: {len(parts)} of {expected} parts received.",
        )
    total = sum(p["size"] for p in parts)
    if total != req.size_bytes:
        # Either a part holds different bytes than the client thinks, or the
        # declared size was wrong. Completing would produce an object that
        # nothing validated.
        raise HTTPException(
            status_code=409,
            detail="The uploaded parts do not add up to the expected file size.",
        )
    # Storage rejects a non-final part under its minimum at complete time, with
    # a message the user cannot act on. Catch it while we can still say what to
    # do about it.
    if any(p["size"] < MULTIPART_PART_SIZE for p in parts[:-1]):
        raise HTTPException(
            status_code=409,
            detail="This upload was split with the wrong part size. Start the file again.",
        )

    try:
        complete_multipart_upload(req.bucket, req.storage_key, req.upload_id, parts)
    except UploadSessionGone:
        raise HTTPException(status_code=410, detail="This upload can no longer be resumed.")

    # From here the object is an ordinary uploaded file. Reuse the existing
    # confirm path verbatim, so the antivirus pass, the macro strip and the
    # FileAsset row are exactly the same as for a single PUT.
    return await confirm_upload_endpoint(
        ConfirmUploadRequest(
            storage_key=req.storage_key,
            bucket=req.bucket,
            filename=req.filename,
            mime_type=req.mime_type,
            size_bytes=req.size_bytes,
        ),
        current_user,
        db,
    )


@router.post(
    "/multipart/abort",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
    summary="Discard an unfinished resumable upload and its parts",
)
async def multipart_abort_endpoint(
    req: MultipartAbortRequest,
    current_user: CurrentUser,
) -> Response:
    _require_own_key(current_user, req.storage_key)
    abort_multipart_upload(req.bucket, req.storage_key, req.upload_id)
    logger.info("multipart_upload_aborted", storage_key=req.storage_key)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
