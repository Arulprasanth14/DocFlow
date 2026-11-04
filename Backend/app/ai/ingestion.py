"""
DocFlow Backend — AI: text extraction and chunking for the RAG pipeline.

Requirements §12.2:
  - "Validate files and extract text securely."
  - "Where extraction fails or a document is scanned, use an approved OCR
    process if available and report extraction problems instead of silently
    indexing empty content."
  - "Chunk and index the extracted text for retrieval. Store document and
    chunk metadata so answers can cite the source document and relevant
    section/page where available."

Security posture for extraction: parsing untrusted documents is the risky
part of any RAG system. We therefore
  - accept only an explicit allow-list of content types,
  - cap file size and extracted length before parsing,
  - never execute or resolve anything embedded in the file (no external
    entity resolution, no macro execution, no network fetch),
  - and treat ALL extracted text as DATA, never as instructions — see
    sanitize_for_prompt(), which neutralises prompt-injection attempts
    found inside uploaded documents (§12.3's "Protect against prompt
    injection embedded in uploaded documents").
"""
from __future__ import annotations

import html
import io
import re
import unicodedata
from dataclasses import dataclass

import structlog

logger = structlog.get_logger(__name__)

# Hard ceilings. A legal/policy corpus is text, not media; anything larger is
# either a mistake or an attempt to exhaust memory.
MAX_FILE_BYTES = 25 * 1024 * 1024        # 25 MB
MAX_EXTRACTED_CHARS = 2_000_000          # ~2M chars (~500k tokens)

SUPPORTED_TYPES: dict[str, str] = {
    "text/plain": "txt",
    "text/markdown": "txt",
    "text/csv": "txt",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/msword": "docx",          # best-effort; often really .docx
    "application/rtf": "txt",
    "text/rtf": "txt",
}


class ExtractionError(Exception):
    """Raised when a file cannot be turned into usable text. The message is
    shown to the administrator in the ingestion status, so it must be
    actionable and must not leak file contents."""


@dataclass
class ExtractedPage:
    """Text plus where it came from, so citations can name a page."""
    page_number: int | None
    text: str


@dataclass
class Chunk:
    index: int
    content: str
    char_count: int
    page_number: int | None = None
    section_label: str | None = None


# ── Extraction ──────────────────────────────────────────────────────────────

def extract_text(
    data: bytes, *, mime_type: str | None, filename: str | None = None
) -> list[ExtractedPage]:
    """
    Turn an uploaded file into pages of plain text.

    Raises ExtractionError with an actionable message on an unsupported
    type, an oversized file, a corrupt file, or a document that yields no
    text (the scanned-PDF case) — never returns empty content silently.
    """
    if not data:
        raise ExtractionError("The uploaded file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise ExtractionError(
            f"File is {len(data) // (1024 * 1024)} MB; the limit is "
            f"{MAX_FILE_BYTES // (1024 * 1024)} MB."
        )

    kind = _resolve_kind(mime_type, filename)
    if kind == "pdf":
        pages = _extract_pdf(data)
    elif kind == "docx":
        pages = _extract_docx(data)
    else:
        pages = _extract_plain(data)

    total = sum(len(p.text) for p in pages)
    if total == 0:
        raise ExtractionError(
            "No text could be extracted. If this is a scanned document, it "
            "needs OCR before it can be indexed — no OCR engine is "
            "configured on this server, so it has not been indexed."
        )
    if total > MAX_EXTRACTED_CHARS:
        raise ExtractionError(
            f"Extracted text is {total:,} characters; the limit is "
            f"{MAX_EXTRACTED_CHARS:,}. Split the document and upload it in parts."
        )
    return pages


def _resolve_kind(mime_type: str | None, filename: str | None) -> str:
    if mime_type:
        kind = SUPPORTED_TYPES.get(mime_type.split(";")[0].strip().lower())
        if kind:
            return kind
    # Fall back to the extension — browsers and curl both send sloppy types.
    name = (filename or "").lower()
    for ext, kind in (
        (".pdf", "pdf"), (".docx", "docx"), (".doc", "docx"),
        (".txt", "txt"), (".md", "txt"), (".csv", "txt"), (".rtf", "txt"),
    ):
        if name.endswith(ext):
            return kind
    raise ExtractionError(
        f"Unsupported file type '{mime_type or name or 'unknown'}'. "
        "Upload a PDF, Word (.docx), Markdown, or plain-text file."
    )


def _extract_plain(data: bytes) -> list[ExtractedPage]:
    for encoding in ("utf-8", "utf-16", "cp1252", "latin-1"):
        try:
            return [ExtractedPage(page_number=None, text=data.decode(encoding))]
        except UnicodeDecodeError:
            continue
    # latin-1 decodes any byte sequence, so reaching here means something
    # stranger happened.
    raise ExtractionError("The file could not be decoded as text.")


def _extract_pdf(data: bytes) -> list[ExtractedPage]:
    """
    PDF text extraction via pypdf when installed.

    pypdf is an optional dependency: if it is missing we say so explicitly
    rather than pretending the PDF had no text, because those two cases need
    completely different fixes (install a package vs. run OCR).
    """
    try:
        from pypdf import PdfReader
    except ImportError:  # pragma: no cover - depends on deployment
        try:
            from PyPDF2 import PdfReader  # type: ignore[no-redef]
        except ImportError:
            raise ExtractionError(
                "PDF support is not installed on this server. Run "
                "`pip install pypdf` in the Backend environment, or upload "
                "the document as .docx / .txt instead."
            ) from None

    try:
        reader = PdfReader(io.BytesIO(data))
        if getattr(reader, "is_encrypted", False):
            # Try the empty password, which opens many "protected" PDFs.
            try:
                reader.decrypt("")
            except Exception:
                raise ExtractionError(
                    "This PDF is password-protected. Upload an unprotected copy."
                ) from None
        pages: list[ExtractedPage] = []
        for i, page in enumerate(reader.pages, start=1):
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            if text.strip():
                pages.append(ExtractedPage(page_number=i, text=text))
        return pages
    except ExtractionError:
        raise
    except Exception as exc:
        raise ExtractionError(f"The PDF could not be read ({type(exc).__name__}).") from exc


def _extract_docx(data: bytes) -> list[ExtractedPage]:
    """
    .docx extraction via python-docx. Paragraph and table text only — no
    embedded objects are opened and no macros are executed.
    """
    try:
        import docx  # python-docx
    except ImportError:  # pragma: no cover
        raise ExtractionError(
            "Word support is not installed on this server. Run "
            "`pip install python-docx` in the Backend environment."
        ) from None

    try:
        document = docx.Document(io.BytesIO(data))
    except Exception as exc:
        raise ExtractionError(
            "The Word file could not be read. If it is an old .doc file, "
            "re-save it as .docx and upload again."
        ) from exc

    parts: list[str] = []
    # Headings become section labels downstream, so keep their markers.
    for para in document.paragraphs:
        text = (para.text or "").strip()
        if not text:
            continue
        style = (getattr(para.style, "name", "") or "").lower()
        if style.startswith("heading"):
            parts.append(f"\n## {text}\n")
        else:
            parts.append(text)
    for table in document.tables:
        for row in table.rows:
            cells = [(c.text or "").strip() for c in row.cells]
            if any(cells):
                parts.append(" | ".join(cells))

    return [ExtractedPage(page_number=None, text="\n".join(parts))]


# ── Normalisation & prompt-injection defence ────────────────────────────────

_CONTROL_CHARS = dict.fromkeys(
    c for c in range(0x20) if c not in (0x09, 0x0A, 0x0D)
)

# Phrases that only ever appear in a document because someone is trying to
# talk to the model rather than to a human reader.
_INJECTION_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"ignore (all |any )?(previous|prior|above) (instructions|prompts)",
        r"disregard (all |any )?(previous|prior|above) (instructions|prompts)",
        r"you are now (a|an) ",
        r"system prompt\s*[:=]",
        r"</?(system|assistant|user)>",
        r"\bBEGIN SYSTEM\b",
        r"reveal (your|the) (system )?(prompt|instructions)",
        r"(print|output|show) (your|the) (system )?(prompt|instructions)",
    )
]


def normalize_text(text: str) -> str:
    """Canonicalise whitespace/unicode so chunking is stable and invisible
    characters can't be used to smuggle content past the filters below."""
    text = unicodedata.normalize("NFKC", text)
    text = text.translate(_CONTROL_CHARS)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def sanitize_for_prompt(text: str) -> str:
    """
    Neutralise instruction-like content before retrieved text is placed in a
    prompt (§12.3: "Treat retrieved content as reference data, not as
    instructions that can override system security or access rules").

    The text is NOT dropped — a policy document legitimately might quote such
    a phrase — it is defanged so the model reads it as quoted material. The
    prompt builder additionally fences all retrieved content and states that
    everything inside the fence is untrusted reference data.
    """
    cleaned = text
    for pattern in _INJECTION_PATTERNS:
        # Replace with a bare marker that does NOT reproduce the matched
        # text. Echoing it back — even inside brackets — would still place
        # the imperative in the prompt, which is the thing we're defending
        # against; the administrator can always read the original document.
        cleaned = pattern.sub("[redacted-instruction]", cleaned)
    # Prevent a document from closing our own fence early.
    return cleaned.replace("```", "ʼʼʼ")


# ── Chunking ────────────────────────────────────────────────────────────────

_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6}\s+.+|[A-Z][A-Z0-9 .\-]{6,}|\d+(\.\d+)*\s+\S.*)$")


def chunk_pages(
    pages: list[ExtractedPage],
    *,
    target_chars: int = 1200,
    overlap_chars: int = 180,
) -> list[Chunk]:
    """
    Split extracted pages into overlapping, paragraph-aligned chunks.

    Design notes:
      - Paragraph boundaries are preferred over fixed windows so a chunk
        rarely cuts a sentence in half, which measurably hurts retrieval.
      - Consecutive chunks overlap by `overlap_chars` so a passage split
        across a boundary is still retrievable from at least one chunk.
      - The most recent heading seen becomes the chunk's `section_label`,
        and the page number is carried through, so a citation can point at
        "Leave Policy §3, page 4" rather than just the file name.
    """
    chunks: list[Chunk] = []
    index = 0

    for page in pages:
        text = normalize_text(page.text)
        if not text:
            continue

        buffer = ""
        # Headings covered by the CURRENT buffer. The label has to describe
        # what is actually in the chunk: labelling it with "the most recent
        # heading seen" was wrong — a chunk covering several sections got
        # tagged with the LAST one, so a citation for an annual-leave answer
        # read "— Expense Reimbursement". (Caught by a live end-to-end run.)
        buffer_sections: list[str] = []

        def flush(buf: str, sections: list[str]) -> None:
            nonlocal index
            content = buf.strip()
            if not content:
                return
            if not sections:
                label = None
            elif len(sections) == 1:
                label = sections[0][:255]
            else:
                # Several sections in one chunk: name the span rather than
                # picking one arbitrarily.
                label = f"{sections[0]} … {sections[-1]}"[:255]
            chunks.append(
                Chunk(
                    index=index,
                    content=content,
                    char_count=len(content),
                    page_number=page.page_number,
                    section_label=label,
                )
            )
            index += 1

        for block in re.split(r"\n\s*\n", text):
            block = block.strip()
            if not block:
                continue

            first_line = block.splitlines()[0].strip()
            is_heading = len(first_line) <= 120 and bool(_HEADING_RE.match(first_line))
            heading_text = first_line.lstrip("# ").strip() if is_heading else None

            # Start a new chunk at each heading once the buffer has content.
            # Section-aligned chunks retrieve far more precisely than
            # fixed-size windows (a question about leave matches the leave
            # section, not a blob containing every policy) and make the
            # citation's section label exact.
            if is_heading and buffer:
                flush(buffer, buffer_sections)
                buffer = ""
                buffer_sections = []

            if heading_text:
                buffer_sections.append(heading_text)

            if len(buffer) + len(block) + 2 <= target_chars:
                buffer = f"{buffer}\n\n{block}" if buffer else block
                continue

            # Buffer is full: emit it, then start the next one with a tail
            # overlap for continuity.
            flush(buffer, buffer_sections)
            tail = buffer[-overlap_chars:] if overlap_chars and buffer else ""
            # The continuation still belongs to the section it was cut from.
            carry_sections = buffer_sections[-1:] if buffer_sections else []
            buffer = f"{tail}\n\n{block}".strip() if tail else block
            buffer_sections = list(carry_sections)
            if heading_text and heading_text not in buffer_sections:
                buffer_sections.append(heading_text)

            # A single block larger than the target still has to be split.
            while len(buffer) > target_chars:
                cut = buffer.rfind(" ", 0, target_chars)
                if cut <= 0:
                    cut = target_chars
                flush(buffer[:cut], buffer_sections)
                carry = buffer[max(0, cut - overlap_chars):cut] if overlap_chars else ""
                buffer = (carry + buffer[cut:]).strip()
                buffer_sections = buffer_sections[-1:]

        flush(buffer, buffer_sections)

    return chunks
