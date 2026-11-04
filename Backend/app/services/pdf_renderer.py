"""
DocFlow Backend — PDF rendering (spec FR-13.8 snapshot, FR-6.2/6.4/6.7).

Turns the editor's ProseMirror/TipTap JSON into a paginated PDF with
reportlab. Used for two things that must agree:

  - the IMMUTABLE SUBMISSION SNAPSHOT (FR-13.8), rendered from
    `Document.submitter_snapshot` and only ever from there;
  - on-demand EXPORT (FR-6.7) of a draft the author is still working on.

Three rules this module is built around:

  1. **ESCAPE EVERYTHING.** reportlab's `Paragraph` parses its input as
     XML-ish markup, so an unescaped `<` in a user's document either breaks
     the render or injects markup. Every scrap of user text goes through
     `_esc` before it is concatenated into a paragraph string, and the markup
     we add ourselves is the only markup there is.
  2. **EMBED THE FONT.** Noto Sans (SIL OFL 1.1) is registered from
     app/assets/fonts. Nothing relies on Helvetica or on a font being present
     on the host, so a developer's machine and the container produce the same
     bytes. Characters Noto Sans cannot draw are replaced with a VISIBLE
     marker and counted — never dropped silently, because a rupee amount
     quietly vanishing from an approved PDF is the worst outcome here.
  3. **NO LIVE DATA IN A SNAPSHOT.** `render_snapshot` reads the frozen
     JSON. It never touches DocumentContent, the template, or anything else
     that can change after submission.
"""
from __future__ import annotations

import hashlib
import io
import os
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

import structlog
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4, LETTER, landscape

from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    Image,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

logger = structlog.get_logger(__name__)

#: The page sizes the Layout tab offers. Anything else falls back to A4
#: rather than raising: page_settings is free-form JSON written by the studio,
#: and a typo there must not make a document unexportable.
PAGE_SIZES: dict[str, tuple[float, float]] = {"a4": A4, "letter": LETTER}


def resolve_pagesize(settings: dict | None) -> tuple[float, float]:
    """(width, height) in points for a template's page_settings."""
    s = settings or {}
    name = str(s.get("size") or s.get("page_size") or "A4").strip().lower()
    size = PAGE_SIZES.get(name, A4)
    if str(s.get("orientation") or "").strip().lower() == "landscape":
        return landscape(size)
    return size


FONT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "fonts")

BODY_FONT = "NotoSans"
BODY_FONT_BOLD = "NotoSans-Bold"
BODY_FONT_ITALIC = "NotoSans-Italic"
BODY_FONT_BOLDITALIC = "NotoSans-BoldItalic"
MONO_FONT = "Courier"  # reportlab built-in; code blocks are ASCII in practice

_FACES = (
    (BODY_FONT, "NotoSans-Regular.ttf"),
    (BODY_FONT_BOLD, "NotoSans-Bold.ttf"),
    (BODY_FONT_ITALIC, "NotoSans-Italic.ttf"),
    (BODY_FONT_BOLDITALIC, "NotoSans-BoldItalic.ttf"),
)

_fonts_ready = False
#: Codepoints the registered font can draw. Built once at registration.
_supported: set[int] = set()

#: Shown in place of a character the font cannot draw (FR-6.7). Visible on
#: purpose — see rule 2 in the module docstring.
MISSING_GLYPH = "□"  # □

MAX_NODES = 60_000
MAX_IMAGE_BYTES = 12 * 1024 * 1024


class PDFRenderError(RuntimeError):
    """Rendering failed in a way the caller should record and surface."""


def ensure_fonts() -> None:
    """Register the embedded family once per process."""
    global _fonts_ready
    if _fonts_ready:
        return
    try:
        for name, filename in _FACES:
            path = os.path.join(FONT_DIR, filename)
            if not os.path.exists(path):
                raise PDFRenderError(f"Missing bundled font: {filename}")
            pdfmetrics.registerFont(TTFont(name, path))
        # Lets <b>/<i> inside a Paragraph pick the real bold/italic faces
        # instead of reportlab faking them by smearing the regular one.
        pdfmetrics.registerFontFamily(
            BODY_FONT,
            normal=BODY_FONT,
            bold=BODY_FONT_BOLD,
            italic=BODY_FONT_ITALIC,
            boldItalic=BODY_FONT_BOLDITALIC,
        )
        _supported.update(pdfmetrics.getFont(BODY_FONT).face.charToGlyph.keys())
        _fonts_ready = True
    except PDFRenderError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise PDFRenderError(f"Could not register PDF fonts: {exc}") from exc


# ── text handling ─────────────────────────────────────────────────────────────

_ESCAPES = (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;"))


@dataclass
class RenderStats:
    """What happened during a render, for logging and for honest UI."""

    pages: int = 0
    missing_glyphs: int = 0
    missing_chars: set[str] = field(default_factory=set)
    images_embedded: int = 0
    images_failed: int = 0

    def as_metadata(self) -> dict:
        return {
            "pages": self.pages,
            "missing_glyphs": self.missing_glyphs,
            # Capped: enough to diagnose, not an essay.
            "missing_chars": sorted(self.missing_chars)[:20],
            "images_embedded": self.images_embedded,
            "images_failed": self.images_failed,
        }


def _esc(text: str, stats: RenderStats) -> str:
    """
    Make user text safe for a reportlab Paragraph.

    Escaping happens BEFORE any of our own markup is added, so a document
    containing `<b>` renders as the literal characters rather than turning
    the rest of the paragraph bold.
    """
    out_chars: list[str] = []
    for ch in text:
        cp = ord(ch)
        if cp in (0x09, 0x0A, 0x0D):
            out_chars.append(" ")
            continue
        if cp < 0x20:
            continue  # control characters have no glyph and can corrupt output
        if _supported and cp not in _supported and not ch.isspace():
            stats.missing_glyphs += 1
            stats.missing_chars.add(ch)
            out_chars.append(MISSING_GLYPH)
            continue
        out_chars.append(ch)
    escaped = "".join(out_chars)
    for needle, replacement in _ESCAPES:
        escaped = escaped.replace(needle, replacement)
    return escaped


_SAFE_HREF = re.compile(r"^(?:https?:|mailto:|tel:)", re.IGNORECASE)


def _inline(nodes: Any, stats: RenderStats, answers: dict[str, Any] | None = None) -> str:
    """
    Flatten an array of inline nodes into one marked-up Paragraph string.

    Mirrors content_sanitizer's mark allow-list: anything else contributes its
    text without decoration rather than being guessed at.
    """
    parts: list[str] = []
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        kind = node.get("type")

        if kind == "text":
            text = node.get("text")
            if not isinstance(text, str) or not text:
                continue
            parts.append(_marked(_esc(text, stats), node.get("marks")))

        elif kind == "hardBreak":
            parts.append("<br/>")

        elif kind == "placeholder":
            parts.append(_placeholder(node, stats, answers))

        elif kind == "image":
            # An inline image inside a paragraph is rendered as its alt text;
            # block-level images become real Image flowables.
            alt = (node.get("attrs") or {}).get("alt")
            parts.append(f"[{_esc(str(alt), stats)}]" if alt else "[image]")

        elif isinstance(node.get("content"), list):
            parts.append(_inline(node["content"], stats, answers))

    return "".join(parts)


def _marked(escaped: str, marks: Any) -> str:
    """Wrap already-escaped text in the inline markup its marks call for."""
    if not isinstance(marks, list):
        return escaped
    out = escaped
    for mark in marks:
        if not isinstance(mark, dict):
            continue
        name = mark.get("type")
        attrs = mark.get("attrs") or {}
        if name == "bold":
            out = f"<b>{out}</b>"
        elif name == "italic":
            out = f"<i>{out}</i>"
        elif name == "underline":
            out = f"<u>{out}</u>"
        elif name == "strike":
            out = f"<strike>{out}</strike>"
        elif name == "code":
            out = f'<font face="{MONO_FONT}">{out}</font>'
        elif name == "link":
            href = str(attrs.get("href") or "")
            # Same allow-list as the sanitiser. A link we would not store is
            # not a link we will make clickable in a PDF either.
            if _SAFE_HREF.match(href):
                safe = href.replace("&", "&amp;").replace('"', "&quot;")
                out = f'<a href="{safe}" color="#1a4fd6">{out}</a>'
    return out


def _placeholder(node: dict, stats: RenderStats, answers: dict[str, Any] | None) -> str:
    """
    A blank renders as its answer, or as a visible unfilled marker.

    An unanswered blank must look unanswered in the PDF — printing nothing
    would make an incomplete document look finished to an approver.
    """
    attrs = node.get("attrs") or {}
    key = str(attrs.get("fieldKey") or "")

    # FR-7.10 — conditional placeholder visibility: if hidden, emit empty string
    rule = attrs.get("visible_when")
    if rule and isinstance(rule, dict):
        target = rule.get("field")
        op = rule.get("op", "eq")
        target_val = rule.get("value")
        actual_val = (answers or {}).get(target)
        visible = True
        if op in ("eq", "=="):
            visible = (actual_val == target_val or str(actual_val) == str(target_val))
        elif op in ("neq", "!="):
            visible = (actual_val != target_val and str(actual_val) != str(target_val))
        elif op == "in":
            visible = actual_val in target_val if isinstance(target_val, (list, tuple)) else False
        elif op == "not_in":
            visible = actual_val not in target_val if isinstance(target_val, (list, tuple)) else True
        elif op == "truthy":
            visible = bool(actual_val) and actual_val != "false"
        elif op == "falsy":
            visible = not bool(actual_val) or actual_val == "false"
        if not visible:
            return ""

    value = (answers or {}).get(key, attrs.get("value"))
    if value is None or value == "":
        if attrs.get("if_empty_behavior") == "remove_phrase":
            return ""
        label = str(attrs.get("label") or key or "blank")
        return (
            f'<font color="#8a8a8a">[{_esc(label, stats)}: '
            f"not filled in]</font>"
        )
    if isinstance(value, bool):
        text = "Yes" if value else "No"
    elif isinstance(value, (list, tuple)):
        text = ", ".join(str(v) for v in value)
    else:
        text = str(value)
    return f"<b>{_esc(text, stats)}</b>"


# ── styles ────────────────────────────────────────────────────────────────────

_ALIGN = {"left": TA_LEFT, "center": TA_CENTER, "right": TA_RIGHT, "justify": TA_JUSTIFY}


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    body = ParagraphStyle(
        "DFBody", parent=base["Normal"], fontName=BODY_FONT, fontSize=10.5,
        leading=15.5, spaceAfter=7, textColor=colors.HexColor("#1a1a1a"),
    )
    styles = {
        "body": body,
        "h1": ParagraphStyle("DFH1", parent=body, fontName=BODY_FONT_BOLD,
                             fontSize=19, leading=24, spaceBefore=12, spaceAfter=9),
        "h2": ParagraphStyle("DFH2", parent=body, fontName=BODY_FONT_BOLD,
                             fontSize=15, leading=20, spaceBefore=11, spaceAfter=7),
        "h3": ParagraphStyle("DFH3", parent=body, fontName=BODY_FONT_BOLD,
                             fontSize=12.5, leading=17, spaceBefore=9, spaceAfter=6),
        "quote": ParagraphStyle("DFQuote", parent=body, leftIndent=12,
                                borderPadding=(0, 0, 0, 8),
                                textColor=colors.HexColor("#4a4a4a"), italic=1),
        "code": ParagraphStyle("DFCode", parent=body, fontName=MONO_FONT,
                               fontSize=9, leading=12.5,
                               backColor=colors.HexColor("#f4f4f5"),
                               borderPadding=6, spaceAfter=9),
        "cell": ParagraphStyle("DFCell", parent=body, fontSize=9.5, leading=13,
                               spaceAfter=0),
        "cellhead": ParagraphStyle("DFCellHead", parent=body, fontSize=9.5,
                                   leading=13, spaceAfter=0, fontName=BODY_FONT_BOLD),
        "runner": ParagraphStyle("DFRunner", parent=body, fontSize=8,
                                 leading=10, spaceAfter=0,
                                 textColor=colors.HexColor("#6b6b6b")),
    }
    for level in (4, 5, 6):
        styles[f"h{level}"] = styles["h3"]
    return styles


# ── node → flowable ───────────────────────────────────────────────────────────

ImageResolver = Callable[[str], bytes | None]


class _Builder:
    def __init__(self, stats: RenderStats, answers: dict[str, Any] | None,
                 image_resolver: ImageResolver | None, frame_width: float):
        self.s = _styles()
        self.stats = stats
        self.answers = answers
        self.resolve_image = image_resolver
        self.frame_width = frame_width
        self.nodes_seen = 0

    def build(self, doc_json: Any) -> list:
        if not isinstance(doc_json, dict) or doc_json.get("type") != "doc":
            return [Paragraph("This document has no content.", self.s["body"])]
        flow = self.blocks(doc_json.get("content") or [])
        return flow or [Paragraph("This document is empty.", self.s["body"])]

    def _find_repeat_list(self, node: Any) -> list[dict] | None:
        """If node belongs to a repeating section, return the list of answer dicts (or [])."""
        if not isinstance(node, dict) or not isinstance(self.answers, dict):
            return None
        attrs = node.get("attrs") or {}
        sec = attrs.get("section") or attrs.get("repeat_group")
        if sec and isinstance(self.answers.get(sec), list):
            return self.answers[sec]

        # Check placeholders inside the node
        def find_phs(n):
            phs = []
            if isinstance(n, dict):
                if n.get("type") == "placeholder":
                    phs.append(n)
                for c in n.get("content") or []:
                    phs.extend(find_phs(c))
            return phs

        phs = find_phs(node)
        if not phs:
            return None
        ph_keys = {p.get("attrs", {}).get("fieldKey") for p in phs if p.get("attrs", {}).get("fieldKey")}

        for k, v in self.answers.items():
            if isinstance(v, list) and not k.startswith("_"):
                if len(v) == 0:
                    # An empty list indicates an unfilled repeating section
                    if any(p.get("attrs", {}).get("section") == k or p.get("attrs", {}).get("repeat_group") == k for p in phs):
                        return []
                elif isinstance(v[0], dict):
                    if any(pk in v[0] for pk in ph_keys) or any(p.get("attrs", {}).get("section") == k for p in phs):
                        return v
        return None

    def blocks(self, nodes: Iterable[Any]) -> list:
        out: list = []
        for node in nodes:
            self.nodes_seen += 1
            if self.nodes_seen > MAX_NODES:
                out.append(Paragraph(
                    "<i>This document was too large to render in full.</i>",
                    self.s["body"],
                ))
                break

            # FR-7.10 — repeating section block expansion
            repeat_list = self._find_repeat_list(node)
            if repeat_list is not None:
                if len(repeat_list) == 0:
                    # Unfilled repeating section: do NOT render anything
                    continue
                orig_answers = self.answers
                for inst in repeat_list:
                    merged = dict(orig_answers or {})
                    if isinstance(inst, dict):
                        merged.update(inst)
                    self.answers = merged
                    out.extend(self.block(node))
                self.answers = orig_answers
                continue

            out.extend(self.block(node))
        return out

    def block(self, node: Any) -> list:
        if not isinstance(node, dict):
            return []
        kind = node.get("type")
        attrs = node.get("attrs") or {}
        content = node.get("content") or []

        if kind == "paragraph":
            text = _inline(content, self.stats, self.answers)
            if not text.strip():
                return [Spacer(1, 6)]
            style = self.s["body"]
            align = _ALIGN.get(str(attrs.get("textAlign") or "").lower())
            if align is not None:
                style = ParagraphStyle("DFBodyA", parent=style, alignment=align)
            return [Paragraph(text, style)]

        if kind == "heading":
            level = attrs.get("level")
            level = level if isinstance(level, int) and 1 <= level <= 6 else 1
            text = _inline(content, self.stats, self.answers)
            style = self.s[f"h{level}"]
            align = _ALIGN.get(str(attrs.get("textAlign") or "").lower())
            if align is not None:
                style = ParagraphStyle(f"DFH{level}A", parent=style, alignment=align)
            # Never leave a heading alone at the foot of a page.
            return [KeepTogether([Paragraph(text, style)])]

        if kind in ("bulletList", "orderedList"):
            return self.list_block(node, ordered=kind == "orderedList")

        if kind == "taskList":
            return self.task_list(content)

        if kind == "blockquote":
            inner = self.blocks(content)
            return [Table(
                [[inner]],
                colWidths=[self.frame_width],
                style=TableStyle([
                    ("LINEBEFORE", (0, 0), (0, -1), 2, colors.HexColor("#d4d4d8")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 10),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                    ("TOPPADDING", (0, 0), (-1, -1), 2),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ]),
            ), Spacer(1, 7)]

        if kind == "codeBlock":
            # Code is literal: no inline marks, and the text is escaped only.
            raw = "".join(
                c.get("text", "") for c in content if isinstance(c, dict)
            )
            lines = _esc(raw, self.stats).replace("\n", "<br/>")
            return [Paragraph(lines or "&nbsp;", self.s["code"])]

        if kind == "horizontalRule":
            return [Spacer(1, 5), HRFlowable(
                width="100%", thickness=0.8, color=colors.HexColor("#d4d4d8"),
            ), Spacer(1, 9)]

        if kind == "pageBreak":
            return [PageBreak()]

        if kind == "table":
            return self.table(content)

        if kind == "image":
            return self.image(attrs)

        # Unknown wrapper: keep the children, drop the wrapper — the same
        # policy content_sanitizer applies.
        if content:
            return self.blocks(content)
        return []

    def list_block(self, node: dict, *, ordered: bool) -> list:
        items: list = []
        for child in node.get("content") or []:
            if not isinstance(child, dict):
                continue
            inner = self.blocks(child.get("content") or [])
            if inner:
                items.append(ListItem(inner, leftIndent=16))
        if not items:
            return []
        start = (node.get("attrs") or {}).get("start")
        return [ListFlowable(
            items,
            bulletType="1" if ordered else "bullet",
            start=start if ordered and isinstance(start, int) else None,
            bulletFontName=BODY_FONT,
            bulletFontSize=9,
            leftIndent=18,
        ), Spacer(1, 5)]

    def task_list(self, content: Iterable[Any]) -> list:
        out: list = []
        for child in content:
            if not isinstance(child, dict):
                continue
            checked = bool((child.get("attrs") or {}).get("checked"))
            box = "☒" if checked else "☐"
            text = _inline(
                (child.get("content") or [{}])[0].get("content") or [],
                self.stats, self.answers,
            )
            out.append(Paragraph(f"{box} {text}", ParagraphStyle(
                "DFTask", parent=self.s["body"], leftIndent=12, spaceAfter=3,
            )))
        return out + ([Spacer(1, 5)] if out else [])

    def table(self, rows: Iterable[Any]) -> list:
        data: list[list] = []
        head_rows = 0
        col_widths: list[float] | None = None

        for r_i, row in enumerate(rows):
            if not isinstance(row, dict) or row.get("type") != "tableRow":
                continue
            cells: list = []
            widths: list[float] = []
            all_header = True
            for cell in row.get("content") or []:
                if not isinstance(cell, dict):
                    continue
                is_header = cell.get("type") == "tableHeader"
                all_header = all_header and is_header
                style = self.s["cellhead"] if is_header else self.s["cell"]
                inner = self.blocks(cell.get("content") or [])
                if not inner:
                    inner = [Paragraph("", style)]
                elif all(isinstance(f, Paragraph) for f in inner):
                    # Re-render single paragraphs in the cell style so font
                    # size is consistent inside the table.
                    inner = [Paragraph(
                        _inline((cell.get("content") or [{}])[0].get("content") or [],
                                self.stats, self.answers),
                        style,
                    )] if len(inner) == 1 else inner
                cells.append(inner)
                cw = (cell.get("attrs") or {}).get("colwidth")
                widths.append(float(cw[0]) if isinstance(cw, list) and cw and isinstance(cw[0], (int, float)) else 0.0)
            if not cells:
                continue
            if all_header and r_i == head_rows:
                head_rows += 1
            data.append(cells)
            if col_widths is None and any(widths):
                col_widths = widths

        if not data:
            return []

        cols = max(len(r) for r in data)
        for row in data:
            while len(row) < cols:
                row.append([Paragraph("", self.s["cell"])])

        # Scale author-set column widths to the frame; fall back to equal.
        if col_widths and len(col_widths) == cols and sum(col_widths) > 0:
            total = sum(w if w > 0 else 0 for w in col_widths)
            filled = [w if w > 0 else (total / cols) for w in col_widths]
            scale = self.frame_width / sum(filled)
            widths_final = [w * scale for w in filled]
        else:
            widths_final = [self.frame_width / cols] * cols

        style_cmds = [
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d4d4d8")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]
        if head_rows:
            style_cmds.append(("BACKGROUND", (0, 0), (-1, head_rows - 1),
                               colors.HexColor("#f4f4f5")))

        table = Table(data, colWidths=widths_final, repeatRows=head_rows)
        table.setStyle(TableStyle(style_cmds))
        return [table, Spacer(1, 9)]

    def image(self, attrs: dict) -> list:
        asset_id = attrs.get("assetId")
        alt = str(attrs.get("alt") or "")
        if not asset_id or self.resolve_image is None:
            return self._image_placeholder(alt)
        try:
            data = self.resolve_image(str(asset_id))
        except Exception as exc:  # noqa: BLE001 — a bad image must not fail the doc
            logger.warning("pdf_image_fetch_failed", asset_id=str(asset_id), error=str(exc))
            data = None
        if not data or len(data) > MAX_IMAGE_BYTES:
            self.stats.images_failed += 1
            return self._image_placeholder(alt)
        try:
            img = Image(io.BytesIO(data))
            iw, ih = img.imageWidth, img.imageHeight
            requested = attrs.get("width")
            target = float(requested) if isinstance(requested, (int, float)) and requested > 0 else iw
            target = min(target, self.frame_width)
            img.drawWidth = target
            img.drawHeight = ih * (target / iw) if iw else target
            # FR-6.3 alignment. reportlab's Image has no alignment of its
            # own, so it is wrapped in a single-cell table the width of the
            # frame and aligned inside that.
            align = str(attrs.get("align") or "").lower()
            self.stats.images_embedded += 1
            if align in ("left", "center", "right"):
                holder = Table([[img]], colWidths=[self.frame_width])
                holder.setStyle(TableStyle([
                    ("ALIGN", (0, 0), (-1, -1), align.upper()),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                    ("TOPPADDING", (0, 0), (-1, -1), 0),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                ]))
                return [holder, Spacer(1, 7)]
            return [img, Spacer(1, 7)]
        except Exception as exc:  # noqa: BLE001
            logger.warning("pdf_image_decode_failed", asset_id=str(asset_id), error=str(exc))
            self.stats.images_failed += 1
            return self._image_placeholder(alt)

    def _image_placeholder(self, alt: str) -> list:
        label = _esc(alt or "Image unavailable", self.stats)
        return [Paragraph(
            f'<font color="#8a8a8a">[{label}]</font>',
            ParagraphStyle("DFImgAlt", parent=self.s["body"], alignment=TA_CENTER),
        ), Spacer(1, 6)]


# ── page furniture (FR-6.4 headers/footers, FR-6.2 page count) ────────────────


@dataclass
class PageFurniture:
    """Running header and footer. Empty strings mean "draw nothing"."""

    header_left: str = ""
    header_right: str = ""
    footer_left: str = ""
    #: `{page}` and `{pages}` are substituted. Two-pass render fills `{pages}`.
    footer_right: str = "Page {page} of {pages}"
    watermark: str = ""


def resolve_furniture(
    page_settings: dict | None,
    *,
    fallback: PageFurniture | None = None,
) -> PageFurniture:
    """
    Build the page furniture from a template's authored settings (FR-6.6).

    `fallback` supplies the values DocFlow derives itself — the document title,
    its reference number, the submission date — which is what a template that
    authors nothing continues to get. An authored field overrides the derived
    one, and an authored *empty* field means "print nothing here", which is a
    different instruction from "not set".

    Determinism matters here: a snapshot taken before this existed has no
    header/footer keys at all, so it renders exactly as it did before and its
    stored SHA-256 still matches (FR-13.8).
    """
    base = fallback or PageFurniture()
    if not isinstance(page_settings, dict):
        return base

    authored = {
        field: page_settings[field]
        for field in ("header_left", "header_right", "footer_left", "footer_right")
        if isinstance(page_settings.get(field), str)
    }
    page_numbers = page_settings.get("page_numbers")

    if not authored and page_numbers is None:
        return base

    out = PageFurniture(
        header_left=authored.get("header_left", base.header_left)[:120],
        header_right=authored.get("header_right", base.header_right)[:120],
        footer_left=authored.get("footer_left", base.footer_left)[:140],
        footer_right=authored.get("footer_right", base.footer_right)[:140],
        watermark=base.watermark,
    )
    # The toggle is the plain-language control in the ribbon; it wins over
    # whatever the footer-right field happens to hold.
    if page_numbers is False:
        out.footer_right = ""
    elif page_numbers is True and not out.footer_right:
        out.footer_right = "Page {page} of {pages}"
    return out


class _DocTemplate(BaseDocTemplate):
    """
    One frame per page plus the running header/footer.

    `total_pages` is filled by a first pass so "Page 3 of 7" can be correct —
    reportlab cannot know the count while it is still laying out.
    """

    def __init__(self, buf, furniture: PageFurniture, styles, total_pages: int = 0,
                 created: str | None = None, pagesize: tuple[float, float] | None = None,
                 **kw):
        # invariant=1 strips reportlab's random document id and its
        # "generated now" timestamp. With a creation date pinned to the
        # snapshot's own submitted_at, rendering the same frozen snapshot
        # twice produces BYTE-IDENTICAL output — so the stored SHA-256 can be
        # re-derived and the PDF proven to match the snapshot, rather than
        # only proven not to have been edited in place.
        kw.setdefault("invariant", 1)
        self._pagesize = pagesize or A4
        super().__init__(buf, pagesize=self._pagesize, **kw)
        self._created = created
        self.furniture = furniture
        self._styles = styles
        self.total_pages = total_pages
        margin_x, margin_top, margin_bottom = 20 * mm, 22 * mm, 20 * mm
        page_w, page_h = self._pagesize
        frame = Frame(
            margin_x, margin_bottom,
            page_w - 2 * margin_x, page_h - margin_top - margin_bottom,
            id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
        )
        self.addPageTemplates([
            PageTemplate(id="main", frames=[frame], onPage=self._furniture)
        ])

    def _furniture(self, canvas, doc) -> None:
        f = self.furniture
        page_w, page_h = self._pagesize
        canvas.saveState()
        page = canvas.getPageNumber()

        if f.watermark:
            canvas.saveState()
            canvas.setFont(BODY_FONT_BOLD, 58)
            canvas.setFillColor(colors.HexColor("#000000"))
            canvas.setFillAlpha(0.07)
            canvas.translate(page_w / 2, page_h / 2)
            canvas.rotate(38)
            canvas.drawCentredString(0, 0, f.watermark)
            canvas.restoreState()

        canvas.setFont(BODY_FONT, 8)
        canvas.setFillColor(colors.HexColor("#6b6b6b"))
        top_y = page_h - 14 * mm
        bottom_y = 12 * mm

        if f.header_left:
            canvas.drawString(20 * mm, top_y, f.header_left[:120])
        if f.header_right:
            canvas.drawRightString(page_w - 20 * mm, top_y, f.header_right[:120])
        if f.header_left or f.header_right:
            canvas.setStrokeColor(colors.HexColor("#e4e4e7"))
            canvas.line(20 * mm, top_y - 3 * mm, page_w - 20 * mm, top_y - 3 * mm)

        if f.footer_left:
            canvas.drawString(20 * mm, bottom_y, f.footer_left[:140])
        if f.footer_right:
            text = f.footer_right.replace("{page}", str(page)).replace(
                "{pages}", str(self.total_pages or page)
            )
            canvas.drawRightString(page_w - 20 * mm, bottom_y, text[:80])

        canvas.restoreState()


# ── public API ────────────────────────────────────────────────────────────────


@dataclass
class RenderedPDF:
    data: bytes
    checksum: str
    stats: RenderStats


def render_document(
    content: Any,
    *,
    answers: dict[str, Any] | None = None,
    furniture: PageFurniture | None = None,
    image_resolver: ImageResolver | None = None,
    title: str | None = None,
    author: str | None = None,
    created: str | None = None,
    page_settings: dict | None = None,
) -> RenderedPDF:
    """
    Render editor JSON to PDF bytes plus a SHA-256 of those bytes.

    Rendered twice: the first pass only counts pages so the footer can say
    "Page 1 of 7" instead of guessing. That doubles layout cost, which for a
    document of this size is cheaper than shipping a wrong page count.

    Pass `created` (an ISO timestamp) to make the output deterministic: the
    same input then yields the same bytes and therefore the same checksum.
    """
    ensure_fonts()
    # FR-6.6 — a caller that passes furniture explicitly keeps it; otherwise
    # the template's authored header/footer applies, falling back to nothing.
    furniture = furniture or resolve_furniture(page_settings)
    styles = _styles()

    def build_flow(frame_width: float) -> tuple[list, RenderStats]:
        stats = RenderStats()
        builder = _Builder(stats, answers, image_resolver, frame_width)
        return builder.build(content), stats

    pagesize = resolve_pagesize(page_settings)
    frame_width = pagesize[0] - 40 * mm

    try:
        # Pass 1 — page count only.
        probe_buf = io.BytesIO()
        probe = _DocTemplate(probe_buf, furniture, styles, created=created,
                             pagesize=pagesize)
        flow, _ = build_flow(frame_width)
        probe.build(list(flow))
        total_pages = probe.page

        # Pass 2 — the real document, now that the count is known.
        buf = io.BytesIO()
        final = _DocTemplate(buf, furniture, styles, total_pages=total_pages,
                             created=created, pagesize=pagesize)
        if title:
            final.title = title[:200]
        if author:
            final.author = author[:200]
        flow, stats = build_flow(frame_width)
        final.build(list(flow))
        stats.pages = final.page
        data = buf.getvalue()
    except PDFRenderError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise PDFRenderError(f"PDF rendering failed: {exc}") from exc

    if not data:
        raise PDFRenderError("PDF rendering produced no output.")

    if stats.missing_glyphs:
        logger.warning(
            "pdf_missing_glyphs",
            count=stats.missing_glyphs,
            chars=sorted(stats.missing_chars)[:20],
        )

    return RenderedPDF(
        data=data,
        checksum=hashlib.sha256(data).hexdigest(),
        stats=stats,
    )


def render_snapshot(
    snapshot: dict,
    *,
    reference: str | None = None,
    image_resolver: ImageResolver | None = None,
) -> RenderedPDF:
    """
    Render the FROZEN submission snapshot (FR-13.8).

    Reads `content` and `answers` from the snapshot dict ONLY. Nothing here
    looks at DocumentContent or the template, so a PDF produced a week after
    submission is the document that was submitted, not the document as it
    stands now.
    """
    if not isinstance(snapshot, dict) or not snapshot.get("schema"):
        raise PDFRenderError("This document has no frozen snapshot to render.")

    title = str(snapshot.get("title") or "Document")
    submitted_at = str(snapshot.get("submitted_at") or "")[:10]

    # What DocFlow derives on its own: the document's title, its reference
    # number and when it was submitted.
    derived = PageFurniture(
        header_left=title[:80],
        header_right=reference or "",
        footer_left=f"Submitted {submitted_at}" if submitted_at else "",
        footer_right="Page {page} of {pages}",
    )
    # FR-6.6 — whatever the template authored wins, per field. A snapshot
    # with no authored furniture renders byte-identically to before.
    furniture = resolve_furniture(snapshot.get("page_settings"), fallback=derived)
    return render_document(
        snapshot.get("content") or {},
        answers=snapshot.get("answers") or {},
        furniture=furniture,
        image_resolver=image_resolver,
        title=title,
        # Pinned to the submission time, not "now", so re-rendering the
        # snapshot reproduces the same bytes and the same checksum.
        created=str(snapshot.get("submitted_at") or "") or None,
        # Frozen with the rest of the submission. A snapshot taken before
        # this field existed has none, and renders A4 portrait as it always
        # did — its checksum is therefore unchanged.
        page_settings=snapshot.get("page_settings") or None,
    )
