"""
DocFlow Backend — Editor content sanitiser (Documents module)

Spec §12 Security ("HTML sanitisation"), FR-9.8 and §32's "XSS in pasted HTML"
test case. Template and document bodies are authored in a rich-text editor and
stored as ProseMirror/TipTap JSON, then rendered back into the DOM on every
viewer's screen — so the body is untrusted input from every other user in the
organisation, not just its author.

Sanitising the JSON rather than an HTML string is both simpler and stricter:
the document is already a tree of named nodes and marks, so an allow-list of
node/mark names plus a per-attribute allow-list leaves no "clever markup" path
at all. Anything not on the list is dropped, and its children are kept where
that is safe (an unknown wrapper loses the wrapper, not the text).

This is defence in depth, not the only defence: the editor also renders through
ProseMirror's schema on the client. It runs on every write so that content
inserted by a direct API call is held to the same rules.
"""
from __future__ import annotations

import re
from typing import Any

# Node types the editors can produce (StarterKit + our placeholder node).
ALLOWED_NODES: dict[str, set[str]] = {
    "doc": set(),
    # textAlign/lineHeight/indent are the ribbon's paragraph formatting
    # (FR-6.1). Their values are checked below, not just their names.
    "paragraph": {"textAlign", "lineHeight", "indent"},
    "text": set(),
    "heading": {"level", "textAlign", "lineHeight", "indent"},
    "bulletList": set(),
    "orderedList": {"start", "type"},
    "listItem": set(),
    "taskList": set(),
    "taskItem": {"checked"},
    "blockquote": set(),
    "codeBlock": {"language"},
    "horizontalRule": set(),
    "hardBreak": set(),
    # Our structured blank (spec FR-7.1) — never raw "__" text.
    # `value` is deliberately absent: answers live in DocumentContent.answers
    # keyed by field key (spec §9) and are substituted at render time. A value
    # baked into the body would desynchronise the two and defeat FR-7.4's
    # "all occurrences update together".
    "placeholder": {"phId", "fieldKey", "label", "number"},
    # Tables (FR-6.1). ProseMirror's table schema; `colwidth` is a list, which
    # _clean_attrs would otherwise drop, so it is handled explicitly below.
    "table": set(),
    "tableRow": set(),
    "tableHeader": {"colspan", "rowspan", "colwidth"},
    "tableCell": {"colspan", "rowspan", "colwidth"},
    # Images (FR-6.1). `src` is deliberately NOT allowed: an image is stored as
    # the id of a FileAsset this organisation owns, and the viewer resolves it
    # to a short-lived presigned URL through the authorised files endpoint. So
    # no URL is stored in the document at all - no javascript:, no data:, no
    # remote host, and no off-site tracking pixel smuggled in as an image.
    "image": {"assetId", "alt", "title", "width", "align"},
}

# A stored image must name a FileAsset by uuid and nothing else.
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)

# Table cells carry colwidth as a list of ints; every other attribute is scalar.
_LIST_ATTRS = {("tableHeader", "colwidth"), ("tableCell", "colwidth")}
MAX_COLWIDTH_COLS = 64

ALLOWED_MARKS: dict[str, set[str]] = {
    "bold": set(),
    "italic": set(),
    "strike": set(),
    "underline": set(),
    "code": set(),
    "link": {"href", "target", "rel"},
    # FR-6.1 ribbon. Both render as a `style` attribute on a <span>, so the
    # values are pattern-matched below; anything else is dropped and the text
    # survives unstyled.
    "textStyle": {"color", "fontSize"},
    "highlight": {"color"},
}

# A colour must be a plain hex triplet or an rgb()/rgba() call. Nothing else
# — no `url(...)`, no `expression(...)`, no CSS variable, no second
# declaration smuggled in after a semicolon.
_COLOR_RE = re.compile(
    r"^(?:#(?:[0-9a-f]{3}|[0-9a-f]{6})"
    r"|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*"
    r"(?:,\s*(?:0|1|0?\.\d{1,3})\s*)?\))$",
    re.IGNORECASE,
)
#: A font size is a number and one of three units, within sane bounds.
_FONT_SIZE_RE = re.compile(r"^(?:[6-9]|[1-9]\d|1\d\d)(?:\.\d)?(?:px|pt)$|^(?:0?\.[5-9]|[1-5](?:\.\d)?)rem$",
                           re.IGNORECASE)
#: Line spacing: the four the ribbon offers, and nothing else.
_LINE_HEIGHTS = {"1", "1.15", "1.5", "2"}
MAX_INDENT = 8

# Only these URL schemes may appear in a link. Everything else — javascript:,
# data:, vbscript:, and any scheme we have not thought about — is dropped.
_SAFE_URL = re.compile(r"^(?:https?:|mailto:|tel:|/|#)", re.IGNORECASE)

# Guards against a hand-crafted payload exhausting memory or the stack.
MAX_DEPTH = 100
MAX_NODES = 50_000
MAX_TEXT = 2_000_000  # characters across the whole document


class ContentTooLargeError(ValueError):
    """Raised when a body exceeds the structural limits above."""


def _clean_attrs(name: str, attrs: Any, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(attrs, dict):
        return {}
    out: dict[str, Any] = {}
    for key, value in attrs.items():
        if key not in allowed:
            continue
        if (name, key) in _LIST_ATTRS:
            if not isinstance(value, list) or len(value) > MAX_COLWIDTH_COLS:
                continue
            widths = [v for v in value if isinstance(v, int) and 0 < v <= 10_000]
            if len(widths) != len(value):
                continue
            out[key] = widths
            continue
        if isinstance(value, (dict, list)):
            continue  # attributes are scalars; nested structures are not ours
        if name == "image" and key == "assetId":
            if not isinstance(value, str) or not _UUID_RE.match(value.strip()):
                continue
            value = value.strip()
        if name == "link" and key == "href":
            if not isinstance(value, str) or not _SAFE_URL.match(value.strip()):
                continue
            value = value.strip()
        if key == "color":
            if not isinstance(value, str) or not _COLOR_RE.match(value.strip()):
                continue
            value = value.strip()
        if key == "fontSize":
            if not isinstance(value, str) or not _FONT_SIZE_RE.match(value.strip()):
                continue
            value = value.strip()
        if key == "lineHeight":
            if not isinstance(value, str) or value.strip() not in _LINE_HEIGHTS:
                continue
            value = value.strip()
        if key == "indent":
            if isinstance(value, bool) or not isinstance(value, int):
                continue
            if not 0 <= value <= MAX_INDENT:
                continue
        if key == "textAlign":
            if value not in ("left", "center", "right", "justify"):
                continue
        if name == "image" and key == "align":
            if value not in ("left", "center", "right"):
                continue
        if name == "image" and key == "width":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            if not 16 <= value <= 2000:
                continue
        out[key] = value
    return out


def _clean_marks(marks: Any) -> list[dict[str, Any]]:
    if not isinstance(marks, list):
        return []
    out = []
    for mark in marks:
        if not isinstance(mark, dict):
            continue
        name = mark.get("type")
        if not isinstance(name, str) or name not in ALLOWED_MARKS:
            continue
        cleaned: dict[str, Any] = {"type": name}
        attrs = _clean_attrs(name, mark.get("attrs"), ALLOWED_MARKS[name])
        if name == "link":
            if "href" not in attrs:
                continue  # a link without a safe href is just text
            # Force safe rel on anything that opens a new tab.
            attrs.setdefault("target", "_blank")
            attrs["rel"] = "noopener noreferrer nofollow"
        if attrs:
            cleaned["attrs"] = attrs
        out.append(cleaned)
    return out


class _Counter:
    __slots__ = ("nodes", "chars")

    def __init__(self) -> None:
        self.nodes = 0
        self.chars = 0


def _clean_node(node: Any, depth: int, counter: _Counter) -> dict[str, Any] | None:
    """Returns the cleaned node, or None when it must be dropped entirely."""
    if depth > MAX_DEPTH:
        raise ContentTooLargeError("Document is nested too deeply.")
    if not isinstance(node, dict):
        return None

    counter.nodes += 1
    if counter.nodes > MAX_NODES:
        raise ContentTooLargeError("Document has too many nodes.")

    name = node.get("type")
    if not isinstance(name, str) or name not in ALLOWED_NODES:
        return None

    cleaned: dict[str, Any] = {"type": name}

    if name == "text":
        text = node.get("text")
        if not isinstance(text, str) or text == "":
            return None
        counter.chars += len(text)
        if counter.chars > MAX_TEXT:
            raise ContentTooLargeError("Document is too large.")
        cleaned["text"] = text
        marks = _clean_marks(node.get("marks"))
        if marks:
            cleaned["marks"] = marks
        return cleaned

    attrs = _clean_attrs(name, node.get("attrs"), ALLOWED_NODES[name])
    if name == "image" and "assetId" not in attrs:
        return None  # an image with no owned asset behind it is not an image
    if attrs:
        cleaned["attrs"] = attrs

    marks = _clean_marks(node.get("marks"))
    if marks:
        cleaned["marks"] = marks

    children = node.get("content")
    if isinstance(children, list):
        kept = [c for c in (_clean_node(ch, depth + 1, counter) for ch in children) if c]
        if kept:
            cleaned["content"] = kept

    return cleaned


def sanitize_editor_content(content: Any) -> dict[str, Any]:
    """
    Return a safe copy of an editor document. An empty or unrecognised body
    becomes an empty document rather than an error, so autosave of a
    half-initialised editor never fails.

    Raises ContentTooLargeError when the structural limits are exceeded.
    """
    empty = {"type": "doc", "content": [{"type": "paragraph"}]}
    if not isinstance(content, dict) or content.get("type") != "doc":
        return empty
    cleaned = _clean_node(content, 0, _Counter())
    if not cleaned or not cleaned.get("content"):
        return empty
    return cleaned


# ── page settings (FR-6.6) ────────────────────────────────────────────────────
#
# `page_settings` arrives as free-form JSON from the studio and used to be
# stored exactly as sent, then handed to the PDF renderer. Once a header or a
# footer can be *authored*, that JSON is text an author types and every reader
# of the PDF sees, so it needs the same treatment as the body: a strict
# allow-list, and a length the renderer can actually draw.
#
# ReportLab's canvas.drawString does not parse markup, so there is no tag
# injection to worry about here (unlike Paragraph, which does). What does need
# guarding is type, length and control characters — a 50,000-character "header"
# or an embedded newline would corrupt the page furniture rather than exploit
# it, and a non-string would raise mid-render.

PAGE_SIZES = ("A4", "Letter")
PAGE_ORIENTATIONS = ("portrait", "landscape")

#: The renderer truncates at 120/140 to keep furniture on one line; reject
#: earlier so what is stored is what gets drawn.
MAX_HEADER_CHARS = 120
MAX_FOOTER_CHARS = 140

_FURNITURE_FIELDS = {
    "header_left": MAX_HEADER_CHARS,
    "header_right": MAX_HEADER_CHARS,
    "footer_left": MAX_FOOTER_CHARS,
    "footer_right": MAX_FOOTER_CHARS,
}

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def _clean_furniture_text(value: Any, limit: int) -> str:
    """One line of header/footer text, or '' for anything unusable."""
    if not isinstance(value, str):
        return ""
    # Collapse every run of whitespace (newlines and tabs included) to a single
    # space: page furniture is one line by construction.
    text = _CONTROL_CHARS.sub(" ", value)
    text = " ".join(text.split())
    return text[:limit]


def sanitize_page_settings(raw: Any) -> dict[str, Any]:
    """
    Validate a template version's `page_settings`.

    Unknown keys are dropped rather than preserved. Everything the studio
    writes is listed here, and silently carrying unrecognised JSON into the
    PDF renderer is how free-form settings blobs turn into a surprise.
    """
    if not isinstance(raw, dict):
        return {}

    out: dict[str, Any] = {}

    # `page_size` is tolerated as an alias because the frontend reader accepts
    # it; without this, a dropped unknown key would silently reset the page
    # size of any template that ever stored it under the older name.
    size = raw.get("size") or raw.get("page_size")
    if isinstance(size, str):
        for allowed in PAGE_SIZES:
            if size.strip().lower() == allowed.lower():
                out["size"] = allowed
                break

    orientation = raw.get("orientation")
    if isinstance(orientation, str) and orientation.strip().lower() in PAGE_ORIENTATIONS:
        out["orientation"] = orientation.strip().lower()

    for field, limit in _FURNITURE_FIELDS.items():
        if field not in raw:
            continue
        text = _clean_furniture_text(raw.get(field), limit)
        # An empty string is meaningful — it means "draw nothing" and must
        # override an inherited default — so it is kept, not dropped.
        out[field] = text

    if "page_numbers" in raw:
        out["page_numbers"] = bool(raw.get("page_numbers"))

    return out


def content_to_text(content: Any) -> str:
    """
    Flatten an editor document to plain text — used for full-text search and for
    the minimal text sent to AI. Placeholders travel as {{field_key}} tokens so
    a model cannot confuse them with prose (FR-10.5).
    """
    parts: list[str] = []

    def walk(node: Any) -> None:
        if not isinstance(node, dict):
            return
        name = node.get("type")
        if name == "text" and isinstance(node.get("text"), str):
            parts.append(node["text"])
            return
        if name == "image":
            alt = (node.get("attrs") or {}).get("alt")
            parts.append(f"[image: {alt}]" if alt else "[image]")
            return
        if name == "placeholder":
            key = (node.get("attrs") or {}).get("fieldKey")
            parts.append(f"{{{{{key}}}}}" if key else "____")
            return
        for child in node.get("content") or []:
            walk(child)
        if name in ("paragraph", "heading", "listItem", "blockquote", "codeBlock", "tableRow"):
            parts.append("\n")
        elif name in ("tableCell", "tableHeader"):
            parts.append("\t")

    walk(content)
    return re.sub(r"\n{3,}", "\n\n", "".join(parts)).strip()
