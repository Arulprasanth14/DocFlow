"""
DocFlow Backend — Core: Storage
S3/MinIO abstraction layer.
Presigned upload flow: Client → POST /uploads/presign → Client PUT → POST /uploads/confirm
"""
from __future__ import annotations

import hashlib
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


# ── encryption at rest (FR-9.9) ───────────────────────────────────────────────
#
# Applied to the writes the backend performs itself. A presigned PUT is not one
# of them: signing an encryption header there obliges the browser to echo it
# exactly, and a mismatch — or a MinIO with no KMS — turns every upload into a
# signature error. Those objects are covered by the bucket's default
# encryption, which is a deployment setting, and `describe_bucket_encryption`
# below exists so its absence is visible rather than assumed.


def _sse_params() -> dict[str, Any]:
    """Encryption arguments for a server-side write, or {} when switched off."""
    algorithm = (settings.S3_SSE or "").strip()
    if not algorithm:
        return {}
    params: dict[str, Any] = {"ServerSideEncryption": algorithm}
    if algorithm == "aws:kms" and settings.S3_SSE_KMS_KEY_ID:
        params["SSEKMSKeyId"] = settings.S3_SSE_KMS_KEY_ID
    return params


def describe_bucket_encryption(bucket: str) -> dict[str, Any]:
    """
    What the bucket's default encryption actually is.

    Returns `{"enabled": bool, "detail": str}`. Never raises: this is used to
    report a fact at startup, and a storage backend that does not implement the
    call (older MinIO returns NotImplemented) must not stop the app from
    booting.
    """
    try:
        client = _get_s3_client()
        res = client.get_bucket_encryption(Bucket=bucket)
        rules = res.get("ServerSideEncryptionConfiguration", {}).get("Rules", [])
        algorithms = [
            r.get("ApplyServerSideEncryptionByDefault", {}).get("SSEAlgorithm")
            for r in rules
        ]
        algorithms = [a for a in algorithms if a]
        if algorithms:
            return {"enabled": True, "detail": ", ".join(algorithms)}
        return {"enabled": False, "detail": "no default rule"}
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "unknown")
        if code in {"ServerSideEncryptionConfigurationNotFoundError", "NoSuchBucket"}:
            return {"enabled": False, "detail": code}
        return {"enabled": False, "detail": f"could not be read ({code})"}
    except Exception as exc:  # noqa: BLE001 — a reporting call must never raise
        return {"enabled": False, "detail": f"could not be read ({type(exc).__name__})"}


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
    # FR-9.1 import formats. Added for template import; the importer
    # decides what it can actually read, this set only decides what may
    # be stored at all.
    "application/rtf",
    "text/rtf",
    "application/vnd.oasis.opendocument.text",
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


# AP-VWR-04. A URL that renders a document inside the approval screen is a
# different thing from a download link: it is handed to an <iframe>/viewer
# rather than clicked, it is re-minted on every page load, and it must not
# survive being pasted into a chat. Five minutes is the ceiling the spec
# gives; the one-hour default below stays for ordinary downloads.
MAX_INLINE_URL_SECONDS = 300


def generate_presigned_download_url(
    bucket: str,
    storage_key: str,
    filename: str,
    expires_in_seconds: int = 3600,  # 1 hour
    *,
    inline: bool = False,
) -> str:
    """Generate a presigned S3 GET URL for temporary file access.

    `inline=True` (AP-VWR-04, defect 11) serves the object for display in the
    page instead of forcing a download, and caps the lifetime at
    MAX_INLINE_URL_SECONDS. Both parts matter:

      * `attachment` makes a browser download the file rather than render it,
        so a PDF viewer cannot use the URL at all; and
      * an hour is far too long for a link that grants unauthenticated read
        access to a document under review — it outlives the page that
        minted it, the session, and in practice the reviewer's attention.

    The cap is applied here rather than left to callers, so a caller cannot
    ask for an inline URL that lasts an hour.
    """
    disposition = "inline" if inline else "attachment"
    if inline:
        expires_in_seconds = min(expires_in_seconds, MAX_INLINE_URL_SECONDS)
    # Quote the filename: a document title can contain a double quote, which
    # would otherwise terminate the header value early and let the rest of the
    # title be read as further header parameters.
    safe_filename = filename.replace("\\", "").replace('"', "")
    try:
        client = _get_s3_client()
        url = client.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": bucket,
                "Key": storage_key,
                "ResponseContentDisposition": (
                    f'{disposition}; filename="{safe_filename}"'
                ),
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


def download_object(bucket: str, storage_key: str, max_bytes: int | None = None) -> bytes:
    """
    Read an object back into memory.

    Uploads go client-direct to storage via a presigned PUT, so this is how the
    backend gets hold of the bytes it never saw — currently for the antivirus /
    macro pass in app/services/antivirus. `max_bytes` caps the read so a huge
    object cannot be pulled into the API process by accident; the caller is
    expected to treat a cap hit as "not scanned" rather than "clean".
    """
    try:
        client = _get_s3_client()
        obj = client.get_object(Bucket=bucket, Key=storage_key)
        body = obj["Body"]
        data = body.read(max_bytes + 1) if max_bytes is not None else body.read()
        body.close()
        return data
    except ClientError as exc:
        raise ServiceUnavailableException("Storage") from exc


def replace_object(bucket: str, storage_key: str, data: bytes, mime_type: str) -> None:
    """
    Overwrite an object in place — used when the macro stripper rewrites a
    document, so the only copy anyone can download is the cleaned one.
    """
    try:
        client = _get_s3_client()
        client.put_object(
            Bucket=bucket, Key=storage_key, Body=data, ContentType=mime_type,
            **_sse_params(),  # FR-9.9
        )
    except ClientError as exc:
        raise ServiceUnavailableException("Storage") from exc


# ── Resumable upload (FR-3.2) ─────────────────────────────────────────────────
#
# S3/MinIO multipart upload. The reason to use it rather than invent a chunk
# protocol is that the *server* needs no state of its own to resume: S3 already
# remembers which parts of an upload id have landed, so `list_parts` is the
# resume answer and there is no session table, no Redis key and no temp file to
# expire. The client keeps `{upload_id, storage_key}` (localStorage) and can
# come back to it after a network drop, a reload or a closed tab.
#
# Nothing here calls into the single-PUT path above; small files keep using it.

#: Part size. S3 requires every part except the last to be >= 5 MB, and allows
#: at most 10,000 parts. 8 MB keeps a 50 MB upload (the cap in validate_file)
#: to seven parts, so a dropped connection costs at most 8 MB of re-upload.
MULTIPART_PART_SIZE = 8 * 1024 * 1024

#: Below this, a resumable upload is not worth its extra round trips.
MULTIPART_MIN_BYTES = MULTIPART_PART_SIZE


class UploadSessionGone(Exception):
    """The multipart upload id no longer exists (completed, aborted, expired)."""


def _is_missing_upload(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code") in {"NoSuchUpload", "NoSuchKey", "404"}


def create_multipart_upload(bucket: str, storage_key: str, mime_type: str) -> str:
    """Begin a multipart upload and return its upload id."""
    try:
        client = _get_s3_client()
        res = client.create_multipart_upload(
            Bucket=bucket, Key=storage_key, ContentType=mime_type,
            # FR-9.9 — set at initiation; every part inherits it, so no
            # per-part header is needed and the browser is unaffected.
            **_sse_params(),
        )
        return str(res["UploadId"])
    except ClientError as exc:
        raise ServiceUnavailableException("Storage") from exc


def presign_upload_part(
    bucket: str,
    storage_key: str,
    upload_id: str,
    part_number: int,
    expires_in_seconds: int = 3600,
) -> str:
    """
    Presigned PUT URL for one part.

    ContentType is deliberately not signed here: the browser sets no content
    type on a Blob slice, and a signed header the client cannot reproduce makes
    every part fail with a signature mismatch.
    """
    try:
        client = _get_s3_client()
        return client.generate_presigned_url(
            "upload_part",
            Params={
                "Bucket": bucket,
                "Key": storage_key,
                "UploadId": upload_id,
                "PartNumber": part_number,
            },
            ExpiresIn=expires_in_seconds,
        )
    except ClientError as exc:
        raise ServiceUnavailableException("Storage") from exc


def list_multipart_parts(bucket: str, storage_key: str, upload_id: str) -> list[dict[str, Any]]:
    """
    Which parts storage already holds, as `[{"part_number", "etag", "size"}]`.

    This is what makes resume work without the client having kept anything but
    the upload id — and it is also where `complete_multipart_upload` gets its
    ETags, so the browser never has to read the ETag response header (which
    requires a CORS ExposeHeaders rule that is easy to forget and silently
    breaks the upload when it is missing).
    """
    parts: list[dict[str, Any]] = []
    try:
        client = _get_s3_client()
        marker = 0
        while True:
            res = client.list_parts(
                Bucket=bucket, Key=storage_key, UploadId=upload_id, PartNumberMarker=marker
            )
            for p in res.get("Parts", []):
                parts.append(
                    {
                        "part_number": int(p["PartNumber"]),
                        "etag": str(p["ETag"]),
                        "size": int(p.get("Size", 0)),
                    }
                )
            if not res.get("IsTruncated"):
                break
            marker = int(res.get("NextPartNumberMarker", 0))
    except ClientError as exc:
        if _is_missing_upload(exc):
            raise UploadSessionGone(upload_id) from exc
        raise ServiceUnavailableException("Storage") from exc
    parts.sort(key=lambda p: p["part_number"])
    return parts


def complete_multipart_upload(
    bucket: str, storage_key: str, upload_id: str, parts: list[dict[str, Any]]
) -> None:
    """Assemble the parts into the final object. `parts` must be sorted."""
    if not parts:
        raise UploadSessionGone(upload_id)
    try:
        client = _get_s3_client()
        client.complete_multipart_upload(
            Bucket=bucket,
            Key=storage_key,
            UploadId=upload_id,
            MultipartUpload={
                "Parts": [
                    {"PartNumber": p["part_number"], "ETag": p["etag"]} for p in parts
                ]
            },
        )
    except ClientError as exc:
        if _is_missing_upload(exc):
            raise UploadSessionGone(upload_id) from exc
        raise ServiceUnavailableException("Storage") from exc


def abort_multipart_upload(bucket: str, storage_key: str, upload_id: str) -> None:
    """
    Discard an unfinished upload and the parts it has accumulated.

    Aborting is best-effort on purpose: a cancelled upload must not leave the
    user with an error, and an already-gone upload is the outcome we wanted.
    """
    try:
        client = _get_s3_client()
        client.abort_multipart_upload(Bucket=bucket, Key=storage_key, UploadId=upload_id)
    except ClientError as exc:
        if _is_missing_upload(exc):
            return
        raise ServiceUnavailableException("Storage") from exc
