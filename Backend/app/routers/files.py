"""
DocFlow Backend — Router: Presigned File URLs (S3/MinIO)
Endpoints:
  POST /api/v1/files/upload-url        — generate a presigned PUT URL for client upload
  GET  /api/v1/files/download-url/{key} — generate a presigned GET URL for client download
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, Field

from app.config import settings
from app.dependencies import CurrentUser
from app.core.storage import (
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
    try:
        validate_file(req.filename, req.mime_type, req.size_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    file_id = uuid.uuid4()
    storage_key = build_storage_key(current_user.org_id, file_id, req.filename)
    url = generate_presigned_upload_url(
        bucket=settings.MINIO_BUCKET,
        storage_key=storage_key,
        mime_type=req.mime_type,
        size_bytes=req.size_bytes,
    )
    return UploadURLResponse(
        upload_url=url,
        storage_key=storage_key,
        bucket=settings.MINIO_BUCKET,
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
) -> DownloadURLResponse:
    filename = storage_key.split("/")[-1] if "/" in storage_key else storage_key
    url = generate_presigned_download_url(
        bucket=settings.MINIO_BUCKET,
        storage_key=storage_key,
        filename=filename,
    )
    return DownloadURLResponse(
        download_url=url,
        storage_key=storage_key,
    )
