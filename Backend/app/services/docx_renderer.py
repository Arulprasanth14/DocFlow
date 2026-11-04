"""
DocFlow Backend — DOCX export (spec FR-6.7).

Writes editor JSON out as a real Word document using python-docx, which is
already a dependency (it is used for import/ingestion), so export costs no
new package.

Deliberately the same node vocabulary as `pdf_renderer`, read from the same
JSON, so the two exports of one document agree. Where Word has no equivalent
for something the editor can express, the fallback is stated in a comment
rather than silently approximated.

Unlike the PDF path there is no escaping concern: python-docx writes text
through the XML layer, which escapes for us. The care needed here is about
STRUCTURE — a table or list built wrongly makes Word declare the file
corrupt, which is a worse failure than a missing style.
"""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from typing import Any, Callable

import structlog
from docx import Document as DocxDocument
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

logger = structlog.get_logger(__name__)

MAX_NODES = 60_000
MAX_IMAGE_BYTES = 12 * 1024 * 1024

_ALIGN = {
    "left": WD_ALIGN_PARAGRAPH.LEFT,
    "center": WD_ALIGN_PARAGRAPH.CENTER,
    "right": WD_ALIGN_PARAGRAPH.RIGHT,
    "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
}

ImageResolver = Callable[[str], bytes | None]


class DocxRenderError(RuntimeError):
    """Export failed in a way the caller should surface."""


@dataclass
class RenderedDocx:
    data: bytes
    checksum: str
    pages: int = 0  # Word paginates on open; we cannot know this here.


def _add_hyperlink(paragraph, url: str, text: str) -> None:
    """
    python-docx has no hyperlink API, so the relationship and the w:hyperlink
    element are added by hand. Without the relationship Word opens the file
    but the link does nothing.
    """
    part = paragraph.part
    r_id = part.relate_to(
        url,
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
        is_external=True,
    )
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), r_id)
    run = OxmlElement("w:r")
    props = OxmlElement("w:rPr")
    colour = OxmlElement("w:color")
    colour.set(qn("w:val"), "1A4FD6")
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    props.append(colour)
    props.append(underline)
    run.append(props)
    text_el = OxmlElement("w:t")
    text_el.text = text
    run.append(text_el)
    link.append(run)
    paragraph._p.append(link)


class _Writer:
    def __init__(self, doc, answers: dict[str, Any] | None,
                 image_resolver: ImageResolver | None):
        self.doc = doc
        self.answers = answers or {}
        self.resolve_image = image_resolver
        self.nodes_seen = 0

    # ── inline ────────────────────────────────────────────────────────────

    def inline(self, paragraph, nodes: Any) -> None:
        for node in nodes or []:
            if not isinstance(node, dict):
                continue
            kind = node.get("type")

            if kind == "text":
                text = node.get("text")
                if not isinstance(text, str) or not text:
                    continue
                self._text_run(paragraph, text, node.get("marks"))

            elif kind == "hardBreak":
                paragraph.add_run().add_break()

            elif kind == "placeholder":
                self._placeholder_run(paragraph, node)

            elif kind == "image":
                # Inline images become their alt text; a block image gets a
                # real picture. Word has no clean inline-picture-in-run story
                # that is worth the complexity here.
                alt = (node.get("attrs") or {}).get("alt")
                paragraph.add_run(f"[{alt}]" if alt else "[image]").italic = True

            elif isinstance(node.get("content"), list):
                self.inline(paragraph, node["content"])

    def _text_run(self, paragraph, text: str, marks: Any) -> None:
        names = {
            m.get("type") for m in (marks or [])
            if isinstance(m, dict) and isinstance(m.get("type"), str)
        }
        href = next(
            (
                str((m.get("attrs") or {}).get("href") or "")
                for m in (marks or [])
                if isinstance(m, dict) and m.get("type") == "link"
            ),
            "",
        )
        if href.lower().startswith(("http://", "https://", "mailto:", "tel:")):
            _add_hyperlink(paragraph, href, text)
            return

        run = paragraph.add_run(text)
        run.bold = "bold" in names
        run.italic = "italic" in names
        run.underline = "underline" in names
        if "strike" in names:
            run.font.strike = True
        if "code" in names:
            run.font.name = "Consolas"
            run.font.size = Pt(9.5)

    def _placeholder_run(self, paragraph, node: dict) -> None:
        attrs = node.get("attrs") or {}
        key = str(attrs.get("fieldKey") or "")
        value = self.answers.get(key, attrs.get("value"))
        if value is None or value == "":
            # An unfilled blank must LOOK unfilled in the export, or an
            # incomplete document reads as finished.
            label = str(attrs.get("label") or key or "blank")
            run = paragraph.add_run(f"[{label}: not filled in]")
            run.italic = True
            run.font.color.rgb = RGBColor(0x8A, 0x8A, 0x8A)
            return
        if isinstance(value, bool):
            text = "Yes" if value else "No"
        elif isinstance(value, (list, tuple)):
            text = ", ".join(str(v) for v in value)
        else:
            text = str(value)
        paragraph.add_run(text).bold = True

    # ── blocks ────────────────────────────────────────────────────────────

    def blocks(self, nodes: Any, *, container=None) -> None:
        for node in nodes or []:
            self.nodes_seen += 1
            if self.nodes_seen > MAX_NODES:
                self.doc.add_paragraph(
                    "This document was too large to export in full."
                ).italic = True
                return
            self.block(node, container=container)

    def block(self, node: Any, *, container=None) -> None:
        if not isinstance(node, dict):
            return
        kind = node.get("type")
        attrs = node.get("attrs") or {}
        content = node.get("content") or []
        host = container if container is not None else self.doc

        if kind == "paragraph":
            para = host.add_paragraph()
            align = _ALIGN.get(str(attrs.get("textAlign") or "").lower())
            if align is not None:
                para.alignment = align
            self.inline(para, content)
            return

        if kind == "heading":
            level = attrs.get("level")
            level = level if isinstance(level, int) and 1 <= level <= 6 else 1
            para = host.add_paragraph(style=f"Heading {level}")
            align = _ALIGN.get(str(attrs.get("textAlign") or "").lower())
            if align is not None:
                para.alignment = align
            self.inline(para, content)
            return

        if kind in ("bulletList", "orderedList"):
            style = "List Number" if kind == "orderedList" else "List Bullet"
            for item in content:
                if not isinstance(item, dict):
                    continue
                for i, child in enumerate(item.get("content") or []):
                    if not isinstance(child, dict):
                        continue
                    if child.get("type") == "paragraph":
                        # Word's list styles apply per paragraph; only the
                        # first paragraph of an item carries the bullet.
                        para = host.add_paragraph(style=style if i == 0 else None)
                        self.inline(para, child.get("content") or [])
                    else:
                        self.block(child, container=container)
            return

        if kind == "taskList":
            for item in content:
                if not isinstance(item, dict):
                    continue
                checked = bool((item.get("attrs") or {}).get("checked"))
                para = host.add_paragraph()
                para.add_run("☒ " if checked else "☐ ")
                inner = (item.get("content") or [{}])[0]
                self.inline(para, (inner or {}).get("content") or [])
            return

        if kind == "blockquote":
            for child in content:
                if isinstance(child, dict) and child.get("type") == "paragraph":
                    para = host.add_paragraph(style="Quote")
                    self.inline(para, child.get("content") or [])
                else:
                    self.block(child, container=container)
            return

        if kind == "codeBlock":
            raw = "".join(c.get("text", "") for c in content if isinstance(c, dict))
            para = host.add_paragraph()
            run = para.add_run(raw)
            run.font.name = "Consolas"
            run.font.size = Pt(9.5)
            return

        if kind == "horizontalRule":
            # Word has no horizontal-rule element; a bottom-bordered empty
            # paragraph is the conventional equivalent.
            para = host.add_paragraph()
            p_pr = para._p.get_or_add_pPr()
            borders = OxmlElement("w:pBdr")
            bottom = OxmlElement("w:bottom")
            bottom.set(qn("w:val"), "single")
            bottom.set(qn("w:sz"), "6")
            bottom.set(qn("w:color"), "D4D4D8")
            borders.append(bottom)
            p_pr.append(borders)
            return

        if kind == "pageBreak":
            self.doc.add_page_break()
            return

        if kind == "table":
            self.table(content)
            return

        if kind == "image":
            self.image(attrs)
            return

        if content:
            self.blocks(content, container=container)

    def table(self, rows: Any) -> None:
        parsed: list[list[dict]] = []
        for row in rows or []:
            if not isinstance(row, dict) or row.get("type") != "tableRow":
                continue
            cells = [c for c in (row.get("content") or []) if isinstance(c, dict)]
            if cells:
                parsed.append(cells)
        if not parsed:
            return

        cols = max(len(r) for r in parsed)
        table = self.doc.add_table(rows=len(parsed), cols=cols)
        table.style = "Table Grid"

        for r_i, cells in enumerate(parsed):
            for c_i in range(cols):
                cell = table.cell(r_i, c_i)
                # python-docx gives every new cell one empty paragraph; reuse
                # it for the first block so the cell has no blank line on top.
                cell.paragraphs[0].text = ""
                if c_i >= len(cells):
                    continue
                source = cells[c_i]
                is_header = source.get("type") == "tableHeader"
                first = True
                for child in source.get("content") or []:
                    if not isinstance(child, dict):
                        continue
                    if child.get("type") == "paragraph":
                        para = cell.paragraphs[0] if first else cell.add_paragraph()
                        self.inline(para, child.get("content") or [])
                        if is_header:
                            for run in para.runs:
                                run.bold = True
                        first = False
                    else:
                        self.block(child, container=cell)

    def image(self, attrs: dict) -> None:
        asset_id = attrs.get("assetId")
        alt = str(attrs.get("alt") or "")
        data = None
        if asset_id and self.resolve_image is not None:
            try:
                data = self.resolve_image(str(asset_id))
            except Exception as exc:  # noqa: BLE001 — never fail the export
                logger.warning("docx_image_failed", asset_id=str(asset_id), error=str(exc))
        if not data or len(data) > MAX_IMAGE_BYTES:
            run = self.doc.add_paragraph().add_run(f"[{alt or 'Image unavailable'}]")
            run.italic = True
            return
        try:
            width = attrs.get("width")
            kwargs = {}
            if isinstance(width, (int, float)) and width > 0:
                # Editor widths are CSS pixels; Word wants real units.
                kwargs["width"] = Inches(min(float(width) / 96.0, 6.0))
            self.doc.add_picture(io.BytesIO(data), **kwargs)
        except Exception as exc:  # noqa: BLE001
            logger.warning("docx_image_embed_failed", error=str(exc))
            run = self.doc.add_paragraph().add_run(f"[{alt or 'Image unavailable'}]")
            run.italic = True


def _set_runner(section, header_text: str, footer_text: str) -> None:
    """Running header/footer with a real page-number field (FR-6.4)."""
    if header_text:
        para = section.header.paragraphs[0]
        para.text = header_text[:120]
        para.alignment = WD_ALIGN_PARAGRAPH.LEFT
        for run in para.runs:
            run.font.size = Pt(8)
            run.font.color.rgb = RGBColor(0x6B, 0x6B, 0x6B)

    para = section.footer.paragraphs[0]
    para.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    if footer_text:
        run = para.add_run(footer_text[:120] + "    ")
        run.font.size = Pt(8)
        run.font.color.rgb = RGBColor(0x6B, 0x6B, 0x6B)

    # PAGE / NUMPAGES as Word fields, so the numbers stay right if the reader
    # edits the document. A literal number would be wrong the moment they do.
    for label, instr in (("Page ", "PAGE"), (" of ", "NUMPAGES")):
        lbl = para.add_run(label)
        lbl.font.size = Pt(8)
        lbl.font.color.rgb = RGBColor(0x6B, 0x6B, 0x6B)
        run = para.add_run()
        run.font.size = Pt(8)
        run.font.color.rgb = RGBColor(0x6B, 0x6B, 0x6B)
        begin = OxmlElement("w:fldChar")
        begin.set(qn("w:fldCharType"), "begin")
        instr_el = OxmlElement("w:instrText")
        instr_el.set(qn("xml:space"), "preserve")
        instr_el.text = f" {instr} "
        end = OxmlElement("w:fldChar")
        end.set(qn("w:fldCharType"), "end")
        run._r.append(begin)
        run._r.append(instr_el)
        run._r.append(end)


def render_docx(
    content: Any,
    *,
    answers: dict[str, Any] | None = None,
    image_resolver: ImageResolver | None = None,
    title: str | None = None,
    reference: str | None = None,
    author: str | None = None,
) -> RenderedDocx:
    """Render editor JSON to .docx bytes plus a SHA-256 of those bytes."""
    try:
        doc = DocxDocument()

        style = doc.styles["Normal"]
        style.font.name = "Calibri"
        style.font.size = Pt(11)

        section = doc.sections[0]
        section.start_type = WD_SECTION.NEW_PAGE
        _set_runner(section, title or "", reference or "")

        if title:
            doc.core_properties.title = title[:200]
        if author:
            doc.core_properties.author = author[:200]

        writer = _Writer(doc, answers, image_resolver)
        if isinstance(content, dict) and content.get("type") == "doc":
            writer.blocks(content.get("content") or [])
        else:
            doc.add_paragraph("This document has no content.")

        buf = io.BytesIO()
        doc.save(buf)
        data = buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        raise DocxRenderError(f"DOCX export failed: {exc}") from exc

    if not data:
        raise DocxRenderError("DOCX export produced no output.")

    return RenderedDocx(data=data, checksum=hashlib.sha256(data).hexdigest())
