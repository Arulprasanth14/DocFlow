"""
DocFlow Backend — Core: Storage
S3/MinIO abstraction layer.
Presigned upload flow: Client → POST /uploads/presign → Client PUT → POST /uploads/confirm
"""
from __future__ import annotations

import hashlib
from datetime import timedelta
from typing import Any
from uuid import UUID

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.config import settings
from app.core.exceptions import ServiceUnavailableException

# ── S3 Client ─────────────────────────────────────────────────────────────────

def _get_s3_client():
    """Create and return an S3/MinIO boto3 client."""
    kwargs: dict[str, Any] = {
        "aws_access_key_id": settings.AWS_ACCESS_KEY_ID,
        "aws_secret_access_key": settings.AWS_SECRET_ACCESS_KEY,
        "region_name": settings.AWS_REGION,
        "config": Config(
            signature_version="s3v4",
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    }
    if settings.STORAGE_BACKEND == "minio":
        kwargs["endpoint_url"] = settings.MINIO_ENDPOINT
    return boto3.client("s3", **kwargs)


# ── Allowed File Types ─────────────────────────────────────────────────────────
ALLOWED_MIME_TYPES: set[str] = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/webp",
    "text/plain",
    "text/csv",
}

MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024  # 50 MB


def validate_file(filename: str, mime_type: str, size_bytes: int) -> None:
    """
    Validate file before generating presigned URL.
    Raises ValueError on invalid file.
    """
    if mime_type not in ALLOWED_MIME_TYPES:
        raise ValueError(f"File type '{mime_type}' is not allowed. Allowed: {ALLOWED_MIME_TYPES}")
    if size_bytes > MAX_FILE_SIZE_BYTES:
        raise ValueError(f"File size {size_bytes} bytes exceeds limit of {MAX_FILE_SIZE_BYTES} bytes (50 MB)")
    if not filename or len(filename) > 500:
        raise ValueError("Invalid filename")


def build_storage_key(org_id: UUID, file_id: UUID, filename: str) -> str:
    """Build the S3 object key: orgs/{org_id}/files/{file_id}/{filename}"""
    import re
    safe_filename = re.sub(r"[^\w.\-]", "_", filename)
    return f"orgs/{org_id}/files/{file_id}/{safe_filename}"


def generate_presigned_upload_url(
    bucket: str,
    storage_key: str,
    mime_type: str,
    size_bytes: int,
    expires_in_seconds: int = 900,  # 15 minutes
) -> str:
    """
    Generate a presigned S3 PUT URL for direct client upload.
    The client uploads directly to S3 — the backend never handles the file bytes.
    """
    try:
        client = _get_s3_client()
        url = client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": bucket,
                "Key": storage_key,
                "ContentType": mime_type,
                "ContentLength": size_bytes,
            },
            ExpiresIn=expires_in_seconds,
        )
        return url
    except ClientError as exc:
        raise ServiceUnavailableException("Storage") from exc


def generate_presigned_download_url(
    bucket: str,
    storage_key: str,
    filename: str,
    expires_in_seconds: int = 3600,  # 1 hour
) -> str:
    """Generate a presigned S3 GET URL for temporary file access."""
    try:
        client = _get_s3_client()
        url = client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": bucket,
                "Key": storage_key,
                "ResponseContentDisposition": f'attachment; filename="{filename}"',
            },
            ExpiresIn=expires_in_seconds,
        )
        return url
    except ClientError as exc:
        raise ServiceUnavailableException("Storage") from exc


def delete_object(bucket: str, storage_key: str) -> None:
    """Permanently delete an object from S3/MinIO."""
    try:
        client = _get_s3_client()
        client.delete_object(Bucket=bucket, Key=storage_key)
    except ClientError as exc:
        raise ServiceUnavailableException("Storage") from exc


def compute_checksum(data: bytes) -> str:
    """Compute SHA-256 checksum of file bytes."""
    return hashlib.sha256(data).hexdigest()
