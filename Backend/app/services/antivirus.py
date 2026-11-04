"""
DocFlow Backend — upload safety checks (spec FR-3.3 / FR-9.8).

Shape chosen with the product owner (Option C): a scanner PROTOCOL with a
structural implementation on by default and a real antivirus behind a config
flag, so the pluggable seam exists today and switching on ClamAV later touches
one setting rather than every call site.

The honesty rule that goes with it: a `ScanStatus` is never upgraded to
something it did not earn. `StructuralScanner` returns CHECKED, never CLEAN,
because it detects malformed and macro-bearing containers — not malware. Only
a scanner that actually ran signatures may return CLEAN, and only CLEAN may be
described to a user as virus-scanned. Everything that renders a status reads
`SCAN_LABELS` below rather than inventing its own wording.

What the structural pass does do, which is not nothing:
  - confirms the bytes match the declared type (magic numbers), so a .exe
    renamed to .docx is rejected at the door;
  - rejects encrypted / password-protected Office files, which no scanner
    downstream could inspect anyway;
  - STRIPS VBA macros out of OOXML files and rewrites the object, which
    removes the realistic macro-malware vector for Word documents;
  - refuses zip bombs by compression ratio and uncompressed size.
"""
from __future__ import annotations

import asyncio
import io
import zipfile
from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol

import structlog

from app.config import settings
from app.models.base import utcnow

logger = structlog.get_logger(__name__)


class ScanStatus(str, Enum):
    CLEAN = "clean"          # a real antivirus ran and found nothing
    CHECKED = "checked"      # structural checks passed; NOT a virus scan
    INFECTED = "infected"    # a real antivirus found something
    REJECTED = "rejected"    # structurally unsafe or not what it claims to be
    SKIPPED = "skipped"      # too large, or scanning switched off
    ERROR = "error"          # the scanner was unreachable or failed


#: The ONLY wording the UI may use for a status. "Scanned" and "virus-free"
#: appear for CLEAN and nowhere else.
SCAN_LABELS: dict[ScanStatus, str] = {
    ScanStatus.CLEAN: "Virus scan passed",
    ScanStatus.CHECKED: "File checked",
    ScanStatus.INFECTED: "Threat detected",
    ScanStatus.REJECTED: "File rejected",
    ScanStatus.SKIPPED: "Virus scan not enabled",
    ScanStatus.ERROR: "Could not be checked",
}

#: Statuses that must block the file from being used.
BLOCKING = frozenset({ScanStatus.INFECTED, ScanStatus.REJECTED})


@dataclass
class ScanResult:
    status: ScanStatus
    scanner: str
    detail: str | None = None
    #: Set when the scanner rewrote the bytes (macro strip). The caller must
    #: write these back to storage before the file becomes downloadable.
    cleaned_bytes: bytes | None = field(default=None, repr=False)
    macros_removed: bool = False

    @property
    def blocked(self) -> bool:
        return self.status in BLOCKING

    def to_metadata(self) -> dict:
        """The JSON written to FileAsset.metadata_['av']."""
        return {
            "status": self.status.value,
            "label": SCAN_LABELS[self.status],
            "scanner": self.scanner,
            "detail": self.detail,
            "macros_removed": self.macros_removed,
            "checked_at": utcnow().isoformat(),
        }


class AntivirusScanner(Protocol):
    name: str

    async def scan(self, data: bytes, filename: str, mime_type: str) -> ScanResult: ...


# ── structural checks ─────────────────────────────────────────────────────────

#: Leading bytes each container type must actually start with.
_MAGIC: dict[str, tuple[bytes, ...]] = {
    "application/pdf": (b"%PDF-",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/gif": (b"GIF87a", b"GIF89a"),
    "application/zip": (b"PK\x03\x04",),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (b"PK\x03\x04",),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": (b"PK\x03\x04",),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": (b"PK\x03\x04",),
}

#: Parts of an OOXML package that carry executable content.
_MACRO_PARTS = ("vbaproject.bin", "vbadata.xml", "vbaprojectsignature.bin")

#: An OOXML package should not be wildly larger uncompressed than compressed.
MAX_EXPANSION_RATIO = 120
MAX_UNCOMPRESSED_BYTES = 400 * 1024 * 1024


class StructuralScanner:
    """
    Validates the container and removes macros. Explicitly NOT malware
    detection — see the module docstring. Returns CHECKED at best.
    """

    name = "structural"

    async def scan(self, data: bytes, filename: str, mime_type: str) -> ScanResult:
        # Pure CPU on bytes already in memory; keep the event loop free.
        return await asyncio.to_thread(self._scan, data, filename, mime_type)

    def _scan(self, data: bytes, filename: str, mime_type: str) -> ScanResult:
        if not data:
            return ScanResult(ScanStatus.REJECTED, self.name, "The file is empty.")

        expected = _MAGIC.get(mime_type)
        if expected and not any(data.startswith(sig) for sig in expected):
            return ScanResult(
                ScanStatus.REJECTED,
                self.name,
                "The file's contents don't match its type. It may have been renamed.",
            )

        if not zipfile.is_zipfile(io.BytesIO(data)):
            # Not an OOXML/zip container — nothing further this scanner can do.
            return ScanResult(ScanStatus.CHECKED, self.name, "Format check passed.")

        return self._scan_zip(data, mime_type)

    def _scan_zip(self, data: bytes, mime_type: str) -> ScanResult:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                infos = zf.infolist()

                total = sum(i.file_size for i in infos)
                if total > MAX_UNCOMPRESSED_BYTES or (
                    len(data) > 0 and total / len(data) > MAX_EXPANSION_RATIO
                ):
                    return ScanResult(
                        ScanStatus.REJECTED, self.name,
                        "The file expands to an unreasonable size and was not accepted.",
                    )

                for info in infos:
                    # A zip entry naming a path outside the archive is never
                    # legitimate in a document (zip-slip).
                    if info.filename.startswith(("/", "\\")) or ".." in info.filename.split("/"):
                        return ScanResult(
                            ScanStatus.REJECTED, self.name,
                            "The file contains an unsafe internal path.",
                        )
                    if info.flag_bits & 0x1:
                        return ScanResult(
                            ScanStatus.REJECTED, self.name,
                            "Password-protected files can't be checked, so they aren't accepted.",
                        )

                macro_parts = [
                    i.filename for i in infos
                    if i.filename.rsplit("/", 1)[-1].lower() in _MACRO_PARTS
                ]
                if not macro_parts:
                    return ScanResult(ScanStatus.CHECKED, self.name, "Format check passed.")

                cleaned = self._strip_macros(zf, infos, macro_parts)
        except zipfile.BadZipFile:
            return ScanResult(ScanStatus.REJECTED, self.name, "The file is damaged and couldn't be read.")

        logger.info("av_macros_stripped", mime_type=mime_type, parts=len(macro_parts))
        return ScanResult(
            ScanStatus.CHECKED, self.name,
            "Macros were removed from this file.",
            cleaned_bytes=cleaned,
            macros_removed=True,
        )

    @staticmethod
    def _strip_macros(zf: zipfile.ZipFile, infos: list, macro_parts: list[str]) -> bytes:
        """Rebuild the package without its macro parts or their references."""
        drop = set(macro_parts)
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dest:
            for info in infos:
                if info.filename in drop:
                    continue
                payload = zf.read(info.filename)
                # Remove the content-type and relationship entries that point at
                # the parts just dropped, or Word reports the file as corrupt.
                lower = info.filename.lower()
                if lower.endswith(("[content_types].xml", ".rels")):
                    payload = _drop_macro_references(payload)
                dest.writestr(info, payload)
        return out.getvalue()


def _drop_macro_references(xml: bytes) -> bytes:
    """
    Remove <Override>/<Relationship> elements referring to a macro part.
    Deliberately a byte-level filter over whole elements rather than an XML
    parse: it cannot reformat or re-encode the rest of the package.
    """
    text = xml.decode("utf-8", errors="ignore")
    out: list[str] = []
    i = 0
    while i < len(text):
        start = text.find("<", i)
        if start == -1:
            out.append(text[i:])
            break
        end = text.find(">", start)
        if end == -1:
            out.append(text[i:])
            break
        element = text[start : end + 1]
        lowered = element.lower()
        is_macro_ref = any(part in lowered for part in _MACRO_PARTS) or (
            "ms-office.vbaproject" in lowered
        )
        out.append(text[i:start])
        if not is_macro_ref:
            out.append(element)
        i = end + 1
    return "".join(out).encode("utf-8")


# ── ClamAV ────────────────────────────────────────────────────────────────────


class ClamAVScanner:
    """
    Real signature scanning, over clamd's INSTREAM protocol on a TCP socket.

    Speaks the wire protocol directly rather than taking a client library —
    INSTREAM is a length-prefixed byte stream and a terminating zero-length
    chunk, which is less code than configuring a dependency would be, and the
    product owner's constraint was no new dependency.
    """

    name = "clamav"

    def __init__(self, host: str, port: int, timeout: float, chunk_size: int = 64 * 1024):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.chunk_size = chunk_size

    async def scan(self, data: bytes, filename: str, mime_type: str) -> ScanResult:
        try:
            verdict = await asyncio.wait_for(self._instream(data), timeout=self.timeout)
        except asyncio.TimeoutError:
            logger.warning("av_clamav_timeout", host=self.host, size=len(data))
            return ScanResult(ScanStatus.ERROR, self.name, "The virus scanner timed out.")
        except OSError as exc:
            logger.warning("av_clamav_unreachable", host=self.host, error=str(exc))
            return ScanResult(ScanStatus.ERROR, self.name, "The virus scanner is unavailable.")

        if verdict.endswith("OK"):
            return ScanResult(ScanStatus.CLEAN, self.name, "No threats found.")
        if "FOUND" in verdict:
            # The signature name is logged for operators but not shown to the
            # uploader, who can do nothing with it.
            logger.warning("av_threat_found", verdict=verdict, filename=filename)
            return ScanResult(
                ScanStatus.INFECTED, self.name,
                "This file was identified as malicious and was not accepted.",
            )
        logger.warning("av_clamav_unexpected", verdict=verdict)
        return ScanResult(ScanStatus.ERROR, self.name, "The virus scanner returned an unexpected result.")

    async def _instream(self, data: bytes) -> str:
        reader, writer = await asyncio.open_connection(self.host, self.port)
        try:
            writer.write(b"zINSTREAM\0")
            for offset in range(0, len(data), self.chunk_size):
                chunk = data[offset : offset + self.chunk_size]
                writer.write(len(chunk).to_bytes(4, "big") + chunk)
            writer.write((0).to_bytes(4, "big"))
            await writer.drain()
            response = await reader.read(4096)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
        return response.decode("utf-8", errors="replace").strip().rstrip("\0")


class DisabledScanner:
    """Used when scanning is switched off, so callers need no special case."""

    name = "off"

    async def scan(self, data: bytes, filename: str, mime_type: str) -> ScanResult:
        return ScanResult(ScanStatus.SKIPPED, self.name, "File checking is switched off.")


def get_scanner() -> AntivirusScanner:
    """Pick the configured scanner. One setting, three behaviours."""
    choice = (settings.AV_SCANNER or "structural").lower()
    if choice == "off":
        return DisabledScanner()
    if choice == "clamav":
        return ClamAVScanner(
            host=settings.CLAMAV_HOST,
            port=settings.CLAMAV_PORT,
            timeout=settings.AV_TIMEOUT_SECONDS,
        )
    return StructuralScanner()


async def scan_upload(data: bytes, filename: str, mime_type: str) -> ScanResult:
    """
    Entry point for the upload path. A scanner that raises is reported as
    ERROR, never as clean — a broken scanner must not look like a pass.
    """
    if len(data) > settings.AV_MAX_INLINE_BYTES:
        return ScanResult(
            ScanStatus.SKIPPED,
            get_scanner().name,
            "This file is too large to check automatically.",
        )
    scanner = get_scanner()
    try:
        return await scanner.scan(data, filename, mime_type)
    except Exception as exc:  # noqa: BLE001 — any failure must degrade to ERROR
        logger.exception("av_scan_failed", scanner=scanner.name, error=str(exc))
        return ScanResult(ScanStatus.ERROR, scanner.name, "The file couldn't be checked.")
