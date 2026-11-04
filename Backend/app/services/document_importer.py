"""
DocFlow — convert an uploaded document into editor JSON (spec FR-9.1).

Two very different levels of fidelity, and the difference is reported to the
user rather than hidden:

  DOCX  Real structure. Word stores headings, lists and tables explicitly, so
        they survive: Heading 1-3, Title, bullet and numbered lists, tables
        (including the cell grid), and bold/italic/underline runs.

  ODT   Real structure too. OpenDocument keeps headings (with an outline
        level), lists, tables and bold/italic/underline runs in content.xml,
        so it is read with the standard library and needs no dependency. One
        honest gap: whether a list is bulleted or numbered lives in a separate
        style file, so every list arrives bulleted and the author is told.

  PDF   Text only for text-based PDFs. A PDF records glyphs at coordinates,
        not meaning — there is no reliable way to tell a heading from a large
        paragraph, or to recover a table's cell boundaries. Scanned PDFs (fewer
        than ~50 characters per page on average) are rasterised with pdf2image
        and run through Tesseract OCR. Both paths emit a loud fidelity warning;
        the OCR path additionally warns that recognition errors may exist.

  RTF   Text only, for the same reason by a different route: RTF is a stream of
        formatting instructions, so structure would have to be inferred from
        them. Paragraphs only, with the same loud warning.

  TXT   Paragraphs, plus lists where the author wrote an explicit "- " or
        "1. " marker. Nothing else is inferred — a short line in capitals is
        not assumed to be a heading.

  DOC   Word 97-2003 OLE2 compound file. Converted to DOCX via
        `soffice --headless --convert-to docx` (LibreOffice must be installed).
        If LibreOffice is absent the import fails with a clear message. The
        conversion runs in a temp directory that is cleaned up on every path,
        including failure, and soffice is never run from inside the untrusted
        file's directory.

  Image (JPEG, PNG, TIFF, WEBP)
        OCR via Tesseract. Same loud fidelity warning as the scanned-PDF path.

Everything returned here is still UNTRUSTED. The caller passes it through
`sanitize_editor_content` before it is stored; this module never writes to the
database and never decides what is safe.
"""
from __future__ import annotations

import hashlib
import io
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import structlog

logger = structlog.get_logger(__name__)

#: Caps, deliberately generous but finite (FR-9.1 "limits are configurable").
MAX_PAGES = 50
MAX_CHARS = 400_000
MAX_BLOCKS = 5_000
#: OCR-specific caps. MAX_PAGES (50) is about text extraction; rasterising 50
#: pages at 200 dpi holds every bitmap in memory at once (hundreds of MB in one
#: Celery worker), so OCR stops earlier and says so.
MAX_OCR_PAGES = 15
#: A .doc conversion spawns LibreOffice; cap the input well below the 50 MB
#: upload limit.
MAX_DOC_BYTES = 25 * 1024 * 1024


class ImportError_(ValueError):
    """A problem the user can understand and act on."""


@dataclass
class Converted:
    content: dict
    text: str
    warnings: list[str] = field(default_factory=list)
    page_count: int | None = None

    @property
    def text_hash(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()


# ── helpers ───────────────────────────────────────────────────────────────────

def _text_node(text: str, marks: list[dict] | None = None) -> dict:
    node: dict = {"type": "text", "text": text}
    if marks:
        node["marks"] = marks
    return node


def _para(children: list[dict]) -> dict:
    return {"type": "paragraph", "content": children} if children else {"type": "paragraph"}


def _collapse(text: str) -> str:
    """Word is full of soft hyphens, NBSPs and tabs; normalise for matching."""
    return (
        text.replace("­", "")
        .replace(" ", " ")
        .replace("\t", "    ")
    )


# ── DOCX ──────────────────────────────────────────────────────────────────────

_HEADING_RE = re.compile(r"^heading\s*([1-9])$", re.IGNORECASE)


def _runs_to_nodes(para) -> list[dict]:
    """Word runs -> TipTap text nodes, preserving bold/italic/underline."""
    out: list[dict] = []
    for run in para.runs:
        text = _collapse(run.text or "")
        if not text:
            continue
        marks: list[dict] = []
        if run.bold:
            marks.append({"type": "bold"})
        if run.italic:
            marks.append({"type": "italic"})
        if run.underline:
            marks.append({"type": "underline"})
        # Merge with the previous node when the formatting matches, so a
        # sentence Word split across six runs does not become six nodes.
        if out and out[-1].get("marks", []) == marks:
            out[-1]["text"] += text
        else:
            out.append(_text_node(text, marks or None))
    return out


def _para_to_node(para) -> dict | None:
    nodes = _runs_to_nodes(para)
    raw = _collapse(para.text or "").strip()
    if not nodes and not raw:
        return None
    if not nodes:
        nodes = [_text_node(raw)]

    style = (para.style.name if para.style is not None else "") or ""

    m = _HEADING_RE.match(style.strip())
    if m:
        level = min(int(m.group(1)), 3)
        return {"type": "heading", "attrs": {"level": level}, "content": nodes}
    if style.strip().lower() == "title":
        return {"type": "heading", "attrs": {"level": 1}, "content": nodes}

    # Lists are a paragraph style in Word, not a container. The caller groups
    # consecutive list paragraphs into a single list node.
    lowered = style.lower()
    if "list bullet" in lowered or lowered == "list paragraph":
        return {"_list": "bullet", "content": nodes}
    if "list number" in lowered:
        return {"_list": "ordered", "content": nodes}

    return _para(nodes)


def _table_to_node(table) -> dict:
    """Word table -> TipTap table. Merged cells are flattened (see warnings)."""
    rows: list[dict] = []
    for r_i, row in enumerate(table.rows):
        cells: list[dict] = []
        for cell in row.cells:
            paras = [p for p in (_para_to_node(p) for p in cell.paragraphs) if p]
            # A list inside a table cell is rare; flatten it to a paragraph
            # rather than build a nested list for one line.
            body = [
                _para(p["content"]) if "_list" in p else p
                for p in paras
            ] or [{"type": "paragraph"}]
            cells.append({
                # The first row is treated as a header, which is true of most
                # real documents and is trivially changed in the editor.
                "type": "tableHeader" if r_i == 0 else "tableCell",
                "attrs": {"colspan": 1, "rowspan": 1},
                "content": body,
            })
        if cells:
            rows.append({"type": "tableRow", "content": cells})
    return {"type": "table", "content": rows} if rows else _para([])


def _flush_list(buffer: list[dict], kind: str) -> dict:
    return {
        "type": "bulletList" if kind == "bullet" else "orderedList",
        "content": [
            {"type": "listItem", "content": [_para(item["content"])]}
            for item in buffer
        ],
    }


def convert_docx(data: bytes) -> Converted:
    try:
        from docx import Document as DocxDocument
        from docx.table import Table
        from docx.text.paragraph import Paragraph
    except ImportError as exc:                                  # pragma: no cover
        raise ImportError_("Word import is not available on this server.") from exc

    try:
        doc = DocxDocument(io.BytesIO(data))
    except Exception as exc:
        raise ImportError_(
            "That file could not be read as a Word document. If it is an older "
            ".doc file, save it as .docx and try again."
        ) from exc

    warnings: list[str] = []
    blocks: list[dict] = []
    list_buffer: list[dict] = []
    list_kind = ""

    body = doc.element.body
    for child in body.iterchildren():
        if len(blocks) >= MAX_BLOCKS:
            warnings.append(
                f"Only the first {MAX_BLOCKS} blocks were imported; the document is very long."
            )
            break

        tag = child.tag.split("}")[-1]
        if tag == "p":
            node = _para_to_node(Paragraph(child, doc))
            if node is None:
                continue
            if "_list" in node:
                kind = node["_list"]
                if list_buffer and kind != list_kind:
                    blocks.append(_flush_list(list_buffer, list_kind))
                    list_buffer = []
                list_kind = kind
                list_buffer.append(node)
                continue
            if list_buffer:
                blocks.append(_flush_list(list_buffer, list_kind))
                list_buffer = []
            blocks.append(node)
        elif tag == "tbl":
            if list_buffer:
                blocks.append(_flush_list(list_buffer, list_kind))
                list_buffer = []
            table = Table(child, doc)
            blocks.append(_table_to_node(table))
            if any(
                len({id(c._tc) for c in row.cells}) != len(row.cells)
                for row in table.rows
            ):
                warnings.append(
                    "A table contains merged cells. They were imported as separate "
                    "cells, so check that table before publishing."
                )

    if list_buffer:
        blocks.append(_flush_list(list_buffer, list_kind))

    # Things Word can hold that the editor has no equivalent for. Reported,
    # never silently dropped (FR-9.7).
    xml = body.xml
    if "<w:drawing" in xml or "<w:pict" in xml:
        warnings.append("Images and drawings were not imported.")
    if "<w:txbxContent" in xml:
        warnings.append("Text boxes were not imported; their text is missing.")
    if "<w:footnoteReference" in xml or "<w:endnoteReference" in xml:
        warnings.append("Footnotes and endnotes were not imported.")
    if "<w:sdt>" in xml:
        warnings.append("Content controls were imported as plain text.")
    try:
        if any(s.header.paragraphs or s.footer.paragraphs for s in doc.sections):
            warnings.append(
                "Headers and footers were not imported. You can set them in the editor."
            )
    except Exception:                                            # pragma: no cover
        pass

    if not blocks:
        raise ImportError_("That document appears to be empty.")

    content = {"type": "doc", "content": blocks}
    text = _plain_text(content)
    if len(text) > MAX_CHARS:
        raise ImportError_(
            f"That document is too large to import ({len(text):,} characters; "
            f"the limit is {MAX_CHARS:,})."
        )
    # Deduplicate while keeping order — the same warning can fire per table.
    warnings = list(dict.fromkeys(warnings))
    return Converted(content=content, text=text, warnings=warnings)


# ── PDF ───────────────────────────────────────────────────────────────────────

def convert_pdf(data: bytes) -> Converted:
    try:
        from pypdf import PdfReader
    except ImportError as exc:                                  # pragma: no cover
        raise ImportError_("PDF import is not available on this server.") from exc

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:
        raise ImportError_("That file could not be read as a PDF.") from exc

    if getattr(reader, "is_encrypted", False):
        raise ImportError_(
            "That PDF is password-protected. Remove the password and try again."
        )

    pages = reader.pages
    page_count = len(pages)
    if page_count > MAX_PAGES:
        raise ImportError_(
            f"That PDF has {page_count} pages; the limit is {MAX_PAGES}."
        )

    # Extract text from each page; measure average character yield.
    raw_pages: list[str] = []
    total_chars = 0
    for page in pages:
        try:
            raw = page.extract_text() or ""
        except Exception:
            raw = ""
        raw_pages.append(raw)
        total_chars += len(raw)

    avg_chars_per_page = total_chars / max(page_count, 1)

    # A scanned PDF has almost no extractable text — fewer than ~50 characters
    # per page on average (a textual PDF easily yields 300-2000). Run OCR.
    if avg_chars_per_page < 50:
        return _ocr_pdf(data, page_count)

    blocks: list[dict] = []
    for raw in raw_pages:
        for chunk in re.split(r"\n\s*\n", _collapse(raw)):
            line = " ".join(chunk.split())
            if line:
                blocks.append(_para([_text_node(line)]))
                if len(blocks) >= MAX_BLOCKS:
                    break

    if not blocks:
        raise ImportError_(
            "No text could be read from that PDF. If it is a scan, it needs OCR — "
            "upload it again and we will run OCR automatically."
        )

    content = {"type": "doc", "content": blocks}
    text = _plain_text(content)
    warnings = [
        "This PDF was imported as plain paragraphs. Headings, lists, tables and "
        "styling were not preserved — PDFs do not record them. Check the layout "
        "before publishing.",
    ]
    return Converted(content=content, text=text, warnings=warnings, page_count=page_count)


def _ocr_pdf(data: bytes, page_count: int) -> Converted:
    """
    Rasterise a scanned PDF with pdf2image and run Tesseract on each page.
    Requires: LibreOffice (for soffice), pdf2image, pytesseract, Tesseract binary.
    """
    try:
        import pytesseract
    except ImportError as exc:                                  # pragma: no cover
        raise ImportError_(
            "OCR is not available on this server: pytesseract is not installed."
        ) from exc
    try:
        from pdf2image import convert_from_bytes
        from pdf2image.exceptions import PDFInfoNotInstalledError
    except ImportError as exc:                                  # pragma: no cover
        raise ImportError_(
            "OCR is not available on this server: pdf2image is not installed."
        ) from exc

    # Verify Tesseract binary is present before doing any expensive work.
    try:
        pytesseract.get_tesseract_version()
    except pytesseract.TesseractNotFoundError as exc:
        raise ImportError_(
            "OCR requires Tesseract to be installed on this server. "
            "Install it with: apt-get install tesseract-ocr (or brew install tesseract)."
        ) from exc

    # Verify poppler (required by pdf2image) is available.
    try:
        images = convert_from_bytes(
            data, dpi=200, first_page=1,
            last_page=min(page_count, MAX_OCR_PAGES),
        )
    except PDFInfoNotInstalledError as exc:
        raise ImportError_(
            "OCR for scanned PDFs requires poppler to be installed. "
            "Install it with: apt-get install poppler-utils (or brew install poppler)."
        ) from exc
    except Exception as exc:
        raise ImportError_(
            f"Could not rasterise the PDF for OCR: {exc}"
        ) from exc

    blocks: list[dict] = []
    for img in images[:MAX_OCR_PAGES]:
        try:
            raw = pytesseract.image_to_string(img)
        except Exception:
            raw = ""
        for chunk in re.split(r"\n\s*\n", _collapse(raw)):
            line = " ".join(chunk.split())
            if line:
                blocks.append(_para([_text_node(line)]))
                if len(blocks) >= MAX_BLOCKS:
                    break

    if not blocks:
        raise ImportError_(
            "OCR could not extract any text from this scanned PDF. "
            "The scan may be too low-resolution or the language unsupported."
        )

    content = {"type": "doc", "content": blocks}
    text = _plain_text(content)
    warnings = [
        "⚠ OCR FIDELITY WARNING: This PDF is a scan. The text was extracted with "
        "optical character recognition (Tesseract) and MAY CONTAIN RECOGNITION ERRORS "
        "— numbers, names and technical terms in particular. Review the full document "
        "carefully before publishing.",
        "This import is plain paragraphs only — OCR cannot recover headings, lists or "
        "tables from a scanned image.",
    ]
    return Converted(content=content, text=text, warnings=warnings, page_count=page_count)


# ── plain text ────────────────────────────────────────────────────────────────

def _plain_text(content: dict) -> str:
    """
    The document as text, in reading order.

    This is what blank detection runs against and what `content_hash` is taken
    over, so it has to be produced the same way every time — detection offsets
    are indexes into this string.
    """
    out: list[str] = []

    def walk(node: dict) -> None:
        kind = node.get("type")
        if kind == "text":
            out.append(node.get("text") or "")
            return
        for child in node.get("content") or []:
            if isinstance(child, dict):
                walk(child)
        if kind in (
            "paragraph", "heading", "listItem", "tableRow", "table", "blockquote",
        ):
            out.append("\n")
        elif kind in ("tableCell", "tableHeader"):
            out.append("\t")

    walk(content)
    return "".join(out)


# ── ODT (OpenDocument Text) ───────────────────────────────────────────────────
#
# An .odt is a zip whose `content.xml` holds the text in a namespaced XML tree,
# which means real structure survives — headings with an outline level, lists,
# tables and bold/italic runs — without any converter binary. It is handled
# with the standard library (zipfile + ElementTree) rather than a dependency.
#
# Inline formatting lives in `style:style` elements inside the same file
# (automatic styles), so the run styles are collected into a lookup first and
# resolved as the body is walked.

_ODF_NS = {
    "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "style": "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
    "fo": "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
}


def _odf_tag(qname: str) -> str:
    prefix, local = qname.split(":", 1)
    return f"{{{_ODF_NS[prefix]}}}{local}"


def _odt_text_styles(root) -> dict[str, list[dict]]:
    """Map automatic text-style names to the marks they imply."""
    styles: dict[str, list[dict]] = {}
    for style in root.iter(_odf_tag("style:style")):
        if style.get(_odf_tag("style:family")) != "text":
            continue
        name = style.get(_odf_tag("style:name"))
        if not name:
            continue
        marks: list[dict] = []
        for props in style.findall(_odf_tag("style:text-properties")):
            if props.get(_odf_tag("fo:font-weight")) in {"bold", "bolder"}:
                marks.append({"type": "bold"})
            if props.get(_odf_tag("fo:font-style")) in {"italic", "oblique"}:
                marks.append({"type": "italic"})
            if props.get(_odf_tag("style:text-underline-style")) not in {None, "none"}:
                marks.append({"type": "underline"})
        if marks:
            styles[name] = marks
    return styles


def _odt_runs(el, styles: dict[str, list[dict]], inherited: list[dict] | None = None) -> list[dict]:
    """Flatten an ODF paragraph into text nodes, carrying span styles down."""
    out: list[dict] = []
    inherited = inherited or []

    def push(text: str | None, marks: list[dict]) -> None:
        if not text:
            return
        out.append(_text_node(text, marks or None))

    push(el.text, inherited)
    for child in el:
        tag = child.tag
        if tag == _odf_tag("text:span"):
            marks = inherited + styles.get(child.get(_odf_tag("text:style-name")) or "", [])
            # Dedupe: nested spans can repeat the same mark, which TipTap
            # tolerates but the sanitiser would rather not see.
            seen: list[dict] = []
            for m in marks:
                if m not in seen:
                    seen.append(m)
            out.extend(_odt_runs(child, styles, seen))
        elif tag == _odf_tag("text:s"):
            count = int(child.get(_odf_tag("text:c")) or 1)
            push(" " * min(count, 40), inherited)
        elif tag == _odf_tag("text:tab"):
            push(" ", inherited)
        elif tag == _odf_tag("text:line-break"):
            push(" ", inherited)
        else:
            # Anything else (bookmarks, notes, annotations) contributes its text
            # and nothing more.
            out.extend(_odt_runs(child, styles, inherited))
        push(child.tail, inherited)
    return out


def _odt_paragraph_node(el, styles: dict[str, list[dict]]) -> dict | None:
    runs = [r for r in _odt_runs(el, styles) if r["text"].strip() or r["text"] == " "]
    text = "".join(r["text"] for r in runs)
    if not text.strip():
        return None
    for r in runs:
        r["text"] = _collapse(r["text"]) or " "
    if el.tag == _odf_tag("text:h"):
        try:
            level = int(el.get(_odf_tag("text:outline-level")) or 1)
        except ValueError:
            level = 1
        return {
            "type": "heading",
            "attrs": {"level": max(1, min(3, level))},
            "content": [_text_node(_collapse(text))],
        }
    return _para(runs)


def _odt_list_node(el, styles: dict[str, list[dict]], warnings: list[str]) -> dict | None:
    items: list[dict] = []
    for item in el.findall(_odf_tag("text:list-item")):
        blocks = [
            node
            for child in item
            for node in [_odt_body_node(child, styles, warnings)]
            if node
        ]
        paras = [b for b in blocks if b.get("type") == "paragraph"] or [_para([])]
        items.append({"type": "listItem", "content": paras})
    if not items:
        return None
    # content.xml records which list *style* applies, but whether that style
    # draws bullets or numbers lives in styles.xml. Rather than open a second
    # file to guess, every list comes back as a bullet list and the author is
    # told so.
    if "Numbered lists come back as bullet lists" not in " ".join(warnings):
        warnings.append(
            "Numbered lists come back as bullet lists — OpenDocument records the "
            "numbering in a separate style file. Re-apply numbering where you need it."
        )
    return {"type": "bulletList", "content": items}


def _odt_table_node(el, styles: dict[str, list[dict]], warnings: list[str]) -> dict | None:
    rows: list[dict] = []
    for r_i, row in enumerate(el.iter(_odf_tag("table:table-row"))):
        cells: list[dict] = []
        for cell in row:
            if cell.tag not in {_odf_tag("table:table-cell"), _odf_tag("table:covered-table-cell")}:
                continue
            blocks = [
                node
                for child in cell
                for node in [_odt_body_node(child, styles, warnings)]
                if node
            ]
            cells.append({
                "type": "tableHeader" if r_i == 0 else "tableCell",
                "content": blocks or [_para([])],
            })
        if cells:
            rows.append({"type": "tableRow", "content": cells})
    if not rows:
        return None
    return {"type": "table", "content": rows}


def _odt_body_node(el, styles: dict[str, list[dict]], warnings: list[str]) -> dict | None:
    tag = el.tag
    if tag in {_odf_tag("text:p"), _odf_tag("text:h")}:
        return _odt_paragraph_node(el, styles)
    if tag == _odf_tag("text:list"):
        return _odt_list_node(el, styles, warnings)
    if tag == _odf_tag("table:table"):
        return _odt_table_node(el, styles, warnings)
    return None


def convert_odt(data: bytes) -> Converted:
    import xml.etree.ElementTree as ET
    import zipfile

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            xml_bytes = zf.read("content.xml")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise ImportError_(
            "This OpenDocument file could not be read. Re-save it and try again."
        ) from exc

    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise ImportError_("This OpenDocument file is damaged.") from exc

    styles = _odt_text_styles(root)
    warnings: list[str] = []
    body = root.find(f".//{_odf_tag('office:text')}")
    if body is None:
        raise ImportError_("This OpenDocument file has no text in it.")

    blocks: list[dict] = []
    chars = 0
    truncated = False
    for el in body:
        node = _odt_body_node(el, styles, warnings)
        if not node:
            continue
        blocks.append(node)
        chars += len(_plain_text({"type": "doc", "content": [node]}))
        if len(blocks) >= MAX_BLOCKS or chars >= MAX_CHARS:
            truncated = True
            break

    if not blocks:
        raise ImportError_("This OpenDocument file has no text in it.")
    if truncated:
        warnings.append(
            "This document is very long, so only the first part was imported."
        )

    content = {"type": "doc", "content": blocks}
    return Converted(content=content, text=_plain_text(content), warnings=warnings)


# ── RTF ───────────────────────────────────────────────────────────────────────
#
# RTF is a control-word stream, not a document model: headings, lists and
# tables are expressed as formatting instructions rather than structure, and
# recovering them means reimplementing a word processor. So this is a text
# extractor, labelled exactly as honestly as the PDF path — paragraphs only,
# with a loud warning. It is the same trade the spec accepts for PDF.

#: `\u8212?` — a unicode code point plus one replacement character to skip.
_RTF_UNICODE = re.compile(r"\\u(-?\d+)\s?\??")
_RTF_HEX = re.compile(r"\\'([0-9a-fA-F]{2})")
_RTF_CONTROL = re.compile(r"\\([a-zA-Z]+)(-?\d+)?[ ]?")
#: Groups whose entire contents are metadata, not body text.
_RTF_SKIP_DESTINATIONS = {
    "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header",
    "footer", "footnote", "xmlnstbl", "listtable", "listoverridetable",
    "generator", "themedata", "colorschememapping", "latentstyles", "datastore",
}


def _rtf_to_paragraphs(text: str) -> list[str]:
    """Walk the control stream once, emitting plain-text paragraphs."""
    out: list[str] = []
    buf: list[str] = []
    depth = 0
    #: Depth at which we entered a destination group whose text is metadata.
    skip_from: int | None = None
    i = 0
    n = len(text)

    def end_para() -> None:
        line = _collapse("".join(buf))
        buf.clear()
        if line:
            out.append(line)

    while i < n:
        ch = text[i]

        if ch == "{":
            depth += 1
            i += 1
            continue
        if ch == "}":
            if skip_from is not None and depth <= skip_from:
                skip_from = None
            depth -= 1
            i += 1
            continue
        if ch == "\\":
            # Escaped literal?
            if i + 1 < n and text[i + 1] in "\\{}":
                if skip_from is None:
                    buf.append(text[i + 1])
                i += 2
                continue
            m = _RTF_HEX.match(text, i)
            if m:
                if skip_from is None:
                    try:
                        buf.append(bytes([int(m.group(1), 16)]).decode("cp1252"))
                    except UnicodeDecodeError:
                        pass
                i = m.end()
                continue
            m = _RTF_UNICODE.match(text, i)
            if m:
                if skip_from is None:
                    code = int(m.group(1))
                    if code < 0:
                        code += 65536
                    if 0 < code < 0x110000:
                        buf.append(chr(code))
                i = m.end()
                continue
            m = _RTF_CONTROL.match(text, i)
            if m:
                word = m.group(1)
                if word == "par" or word == "line" or word == "row":
                    if skip_from is None:
                        end_para()
                elif word in {"tab", "cell"}:
                    if skip_from is None:
                        buf.append(" ")
                elif word in _RTF_SKIP_DESTINATIONS and skip_from is None:
                    skip_from = depth
                i = m.end()
                continue
            # A lone backslash before something unexpected: drop it.
            i += 1
            continue
        if ch in "\r\n":
            i += 1
            continue
        if skip_from is None:
            buf.append(ch)
        i += 1

    end_para()
    return out


def convert_rtf(data: bytes) -> Converted:
    raw = data.decode("cp1252", errors="replace")
    if "\\rtf" not in raw[:512]:
        raise ImportError_("This does not look like an RTF file.")

    paragraphs = _rtf_to_paragraphs(raw)
    blocks: list[dict] = []
    chars = 0
    truncated = False
    for line in paragraphs:
        blocks.append(_para([_text_node(line)]))
        chars += len(line)
        if len(blocks) >= MAX_BLOCKS or chars >= MAX_CHARS:
            truncated = True
            break

    if not blocks:
        raise ImportError_("No text could be read out of this RTF file.")

    warnings = [
        "RTF is imported as text only. Headings, lists and tables come through "
        "as plain paragraphs — add the structure back in the editor.",
    ]
    if truncated:
        warnings.append("This document is very long, so only the first part was imported.")

    content = {"type": "doc", "content": blocks}
    return Converted(content=content, text=_plain_text(content), warnings=warnings)


# ── Plain text ────────────────────────────────────────────────────────────────
#
# A blank line separates paragraphs, and an explicit bullet or number marker
# becomes a list. Nothing else is inferred: guessing that a short line in
# capitals is a heading is exactly the kind of structural invention the DOCX/PDF
# split above exists to avoid.

_TXT_BULLET = re.compile(r"^\s*[-*\u2022\u00b7]\s+(.*)$")
_TXT_NUMBER = re.compile(r"^\s*\d{1,3}[.)]\s+(.*)$")


def convert_txt(data: bytes) -> Converted:
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            raw = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ImportError_("This text file's character encoding could not be read.")

    if not raw.strip():
        raise ImportError_("This file is empty.")

    blocks: list[dict] = []
    pending: list[dict] = []
    pending_kind = ""
    chars = 0
    truncated = False

    def flush_list() -> None:
        nonlocal pending, pending_kind
        if pending:
            blocks.append(_flush_list(pending, pending_kind))
            pending = []
            pending_kind = ""

    def flush_para(lines: list[str]) -> None:
        text = _collapse(" ".join(lines))
        if text:
            blocks.append(_para([_text_node(text)]))

    para_lines: list[str] = []
    for line in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not line.strip():
            flush_para(para_lines)
            para_lines = []
            flush_list()
        else:
            bullet = _TXT_BULLET.match(line)
            number = None if bullet else _TXT_NUMBER.match(line)
            if bullet or number:
                flush_para(para_lines)
                para_lines = []
                kind = "bullet" if bullet else "ordered"
                if pending_kind and pending_kind != kind:
                    flush_list()
                pending_kind = kind
                item_text = _collapse((bullet or number).group(1))
                pending.append({"content": [_text_node(item_text)]})
            else:
                flush_list()
                para_lines.append(line)
        chars += len(line)
        if len(blocks) >= MAX_BLOCKS or chars >= MAX_CHARS:
            truncated = True
            break
    flush_para(para_lines)
    flush_list()

    if not blocks:
        raise ImportError_("This file is empty.")

    warnings = [
        "Plain text carries no formatting. Paragraphs and lists written with "
        "- or 1. markers come through; everything else arrives as a paragraph.",
    ]
    if truncated:
        warnings.append("This document is very long, so only the first part was imported.")

    content = {"type": "doc", "content": blocks}
    return Converted(content=content, text=_plain_text(content), warnings=warnings)


def convert_doc(data: bytes, *, filename: str) -> Converted:
    """
    Convert a Word 97-2003 (.doc) OLE2 file to DOCX via LibreOffice, then parse it.

    LibreOffice must be installed and the ``soffice`` binary must be on PATH.
    The conversion runs from a temp directory that is never the directory
    holding the untrusted file, cleaned up on every path including failure.
    Hard timeout: 60 s.
    """
    # Converting a .doc spawns a whole office suite, so the ceiling is lower
    # than the generic upload limit: a 25 MB binary Word file is already an
    # outlier, and anything larger is far more likely to exhaust the worker
    # than to convert.
    if len(data) > MAX_DOC_BYTES:
        raise ImportError_(
            f"That .doc file is {len(data) // (1024 * 1024)} MB. The limit for "
            f".doc conversion is {MAX_DOC_BYTES // (1024 * 1024)} MB — save it "
            "as .docx in Word and upload that instead."
        )

    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise ImportError_(
            "Word 97-2003 (.doc) import requires LibreOffice to be installed. "
            "Install it with: apt-get install libreoffice-writer "
            "(or brew install libreoffice). "
            "The missing binary is: soffice"
        )

    tmp = tempfile.mkdtemp(prefix="docflow_doc_")
    try:
        safe_name = Path(filename or "upload.doc").name
        if not safe_name.lower().endswith(".doc"):
            safe_name += ".doc"
        src = Path(tmp) / safe_name
        src.write_bytes(data)

        # Run soffice from a *separate* temp dir — never from the directory
        # that holds the untrusted file, which could contain a soffice startup
        # script or macro auto-exec artefact.
        work_dir = tempfile.mkdtemp(prefix="docflow_soffice_")
        try:
            result = subprocess.run(
                [
                    soffice,
                    # A private user profile per run. LibreOffice keeps a single
                    # shared profile per user by default and takes a lock on it:
                    # two Celery workers converting at the same time then race,
                    # and the loser either hangs until the timeout or exits 0
                    # having produced nothing. This is the documented fix.
                    f"-env:UserInstallation=file://{Path(work_dir).as_posix()}/profile",
                    "--headless",
                    "--convert-to", "docx",
                    "--outdir", tmp,
                    str(src),
                ],
                capture_output=True,
                timeout=60,
                cwd=work_dir,
            )
        except subprocess.TimeoutExpired as exc:
            raise ImportError_(
                "Converting that .doc file took too long (60 s limit). "
                "Try saving it as .docx in Word and uploading that instead."
            ) from exc
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

        if result.returncode != 0:
            raise ImportError_(
                f"LibreOffice could not convert that .doc file "
                f"(exit {result.returncode}). "
                "Try opening it in Word and saving as .docx."
            )

        stem = Path(safe_name).stem
        out = Path(tmp) / (stem + ".docx")
        if not out.exists():
            candidates = list(Path(tmp).glob("*.docx"))
            if candidates:
                out = candidates[0]
            else:
                raise ImportError_(
                    "LibreOffice ran but produced no output. "
                    "Try saving the file as .docx manually and importing that."
                )

        docx_bytes = out.read_bytes()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    converted = convert_docx(docx_bytes)
    converted.warnings.insert(
        0,
        "This .doc file was converted via LibreOffice. Most content converts "
        "correctly, but some advanced formatting may not survive. "
        "Check tables, text boxes and complex styles before publishing.",
    )
    return converted


def convert_image_ocr(data: bytes) -> Converted:
    """
    OCR a JPEG, PNG, TIFF or WebP image with Tesseract.

    Requires pytesseract and the Tesseract binary.
    """
    try:
        import pytesseract
        from PIL import Image
    except ImportError as exc:                                  # pragma: no cover
        raise ImportError_(
            "Image import requires pytesseract and Pillow to be installed."
        ) from exc

    try:
        pytesseract.get_tesseract_version()
    except pytesseract.TesseractNotFoundError as exc:
        raise ImportError_(
            "Image import requires Tesseract to be installed on this server. "
            "Install it with: apt-get install tesseract-ocr "
            "(or brew install tesseract). "
            "The missing binary is: tesseract"
        ) from exc

    try:
        img = Image.open(io.BytesIO(data))
    except Exception as exc:
        raise ImportError_("That image file could not be read.") from exc

    try:
        raw = pytesseract.image_to_string(img)
    except Exception as exc:
        raise ImportError_(f"OCR failed on that image: {exc}") from exc

    blocks: list[dict] = []
    for chunk in re.split(r"\n\s*\n", _collapse(raw)):
        line = " ".join(chunk.split())
        if line:
            blocks.append(_para([_text_node(line)]))
            if len(blocks) >= MAX_BLOCKS:
                break

    if not blocks:
        raise ImportError_(
            "OCR could not extract any text from that image. "
            "The image may be too low-resolution or the language unsupported."
        )

    content = {"type": "doc", "content": blocks}
    text = _plain_text(content)
    warnings = [
        "⚠ OCR FIDELITY WARNING: This image was processed with optical character "
        "recognition (Tesseract). The text MAY CONTAIN RECOGNITION ERRORS — "
        "numbers, names and technical terms in particular. Review the full document "
        "carefully before publishing.",
    ]
    return Converted(content=content, text=text, warnings=warnings)


def convert(data: bytes, *, filename: str, mime_type: str | None) -> Converted:
    """Dispatch on what the file actually is, not only on what it claims."""
    name = (filename or "").lower()
    mime = (mime_type or "").lower()

    is_pdf = data[:5] == b"%PDF-" or name.endswith(".pdf") or "pdf" in mime
    # Every modern Office file is a zip — .docx AND .odt — so a zip is not
    # automatically a Word file. OpenDocument writes an uncompressed
    # `mimetype` entry as the very first member of the archive, which is why
    # it can be recognised from the first few hundred bytes without unzipping.
    is_zip = data[:2] == b"PK"
    is_odt = (
        b"opendocument.text" in data[:256]
        or name.endswith(".odt")
        or "opendocument.text" in mime
    )
    is_rtf = data[:5] == b"{\rtf" or name.endswith(".rtf") or "rtf" in mime
    is_doc = data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" or name.endswith(".doc")
    is_image = (
        name.endswith((".jpg", ".jpeg", ".png", ".tiff", ".tif", ".webp"))
        or mime.startswith("image/")
    )

    if is_pdf:
        return convert_pdf(data)
    if is_odt and is_zip:
        return convert_odt(data)
    if is_rtf:
        return convert_rtf(data)
    if is_zip or name.endswith(".docx"):
        return convert_docx(data)
    if is_doc:
        return convert_doc(data, filename=filename)
    if is_image:
        return convert_image_ocr(data)
    if name.endswith((".txt", ".text", ".md", ".csv")) or mime.startswith("text/"):
        return convert_txt(data)
    raise ImportError_(
        "Import a Word (.docx or .doc), OpenDocument (.odt), RTF, PDF, image or plain-text file."
    )


def kind_of(filename: str, mime_type: str | None) -> str:
    """The source format, as recorded on the job and shown in the UI."""
    name = (filename or "").lower()
    mime = (mime_type or "").lower()
    if name.endswith(".pdf") or "pdf" in mime:
        return "pdf"
    if name.endswith(".odt") or "opendocument.text" in mime:
        return "odt"
    if name.endswith(".rtf") or "rtf" in mime:
        return "rtf"
    if name.endswith((".txt", ".text", ".md", ".csv")) or mime.startswith("text/"):
        return "txt"
    if name.endswith(".doc") or mime == "application/msword":
        return "doc"
    if (
        name.endswith((".jpg", ".jpeg", ".png", ".tiff", ".tif", ".webp"))
        or mime.startswith("image/")
    ):
        return "ocr"
    return "docx"
