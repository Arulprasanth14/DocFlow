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

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, Field

from app.config import settings
from app.core.exceptions import ForbiddenException
from app.dependencies import CurrentUser, DatabaseDep
from app.core.storage import (
    ALLOWED_MIME_TYPES,
    build_storage_key,
    generate_presigned_download_url,
    generate_presigned_upload_url,
    validate_file,
)

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

    asset = FileAsset(
        org_id=current_user.org_id,
        uploaded_by=current_user.id,
        filename=req.filename,
        mime_type=req.mime_type,
        size_bytes=req.size_bytes,
        storage_key=req.storage_key,
        bucket=req.bucket,
        storage_mode=settings.STORAGE_BACKEND,
    )
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    return ConfirmUploadResponse(file_asset_id=str(asset.id))


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
    from app.core.exceptions import ForbiddenException, NotFoundException
    
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
