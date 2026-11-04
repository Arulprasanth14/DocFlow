"""
DocFlow — deterministic blank detection (spec FR-9.2, first pass).

This runs on every import and sends nothing anywhere. It finds the blanks that
can be found by looking at the characters: runs of underscores or dots, empty
brackets, and `{{token}}` style markers. Each detection carries the character
offsets it occupies in the extracted plain text, so the caller can replace
exactly that span and prove the rest of the document was untouched (FR-9.4).

The LLM pass is a separate, opt-in step for the blanks this cannot see — the
ones that are only implied by context. Keeping the two apart is what makes the
cheap pass explainable: every detection here can be traced to a rule, and the
rule is named in `reason`.

Field keys are derived from the label that precedes the blank, which is how
most forms read ("Name of Employee: ______"). Where there is no usable label
the key falls back to field_1, field_2, ... rather than inventing wording.
"""
from __future__ import annotations

import re
import unicodedata

#: Confidence labels shared with the AI pass so the review UI colours match.
HIGH = "high"
MEDIUM = "medium"
LOW = "low"

#: A blank written as a run of fill characters.
_FILL_RE = re.compile(r"(_{3,}|\.{4,}|…{2,}|-{5,})")
#: An empty bracket pair, optionally containing only whitespace or a dash.
_BRACKET_RE = re.compile(r"[\[\(]\s*[-_–—]?\s*[\]\)]")
#: An explicit token the author already wrote, e.g. {{client_name}}.
_TOKEN_RE = re.compile(r"\{\{\s*([A-Za-z0-9_][A-Za-z0-9_ .-]{0,60})\s*\}\}")

#: The words immediately before a blank usually name it. Anchored at the end
#: and deliberately NOT greedy to the left: `search` returns the earliest
#: position a match can start, so a pattern that could begin at the start of
#: the sentence would name the blank with the whole sentence. The last words
#: are taken afterwards, in `_label_before`.
_LABEL_RE = re.compile(r"([A-Za-z][A-Za-z0-9 /&'()\.,-]{1,60}?)\s*[:\-–]\s*$")
#: "___ (Employee Name)" — the author named the blank right after it.
_LABEL_AFTER_RE = re.compile(r"^\s*[\(\[]([A-Za-z][^)\]]{1,58})[\)\]]")
#: A label never runs back past the end of the previous sentence.
_SENTENCE_END_RE = re.compile(r"[.;!?]\s")
#: At most this many words in a label; more is a sentence, not a question name.
_LABEL_MAX_WORDS = 6
#: ...or the sentence may read "... the name of the Employee ______".
_TRAILING_WORDS_RE = re.compile(r"([A-Za-z][A-Za-z ]{2,40})\s*$")

_STOPWORDS = {
    "the", "a", "an", "of", "to", "for", "and", "or", "by", "in", "on", "at",
    "is", "are", "be", "this", "that", "with", "as", "shall", "hereby", "between",
    "made", "dated", "undersigned", "herein", "said", "its", "their",
}

#: label keyword -> field type. Longest match wins, so "date of birth" beats "date".
_TYPE_HINTS: tuple[tuple[str, str], ...] = (
    ("email address", "email"),
    ("e-mail", "email"),
    ("email", "email"),
    ("mobile number", "phone"),
    ("phone number", "phone"),
    ("contact number", "phone"),
    ("telephone", "phone"),
    ("mobile", "phone"),
    ("phone", "phone"),
    ("date of birth", "date"),
    ("start date", "date"),
    ("end date", "date"),
    ("effective date", "date"),
    ("expiry date", "date"),
    ("dated", "date"),
    ("date", "date"),
    ("amount", "currency"),
    ("salary", "currency"),
    ("fee", "currency"),
    ("price", "currency"),
    ("cost", "currency"),
    ("rent", "currency"),
    ("rupees", "currency"),
    ("inr", "currency"),
    ("quantity", "number"),
    ("number of", "number"),
    ("count", "number"),
    ("age", "number"),
    ("percentage", "number"),
    ("address", "textarea"),
    ("description", "textarea"),
    ("remarks", "textarea"),
    ("comments", "textarea"),
    ("reason", "textarea"),
    ("terms", "textarea"),
)


def _slug(text: str, fallback: str) -> str:
    """A stable, readable key: 'Name of Employee' -> 'name_of_employee'."""
    norm = unicodedata.normalize("NFKD", text)
    norm = "".join(c for c in norm if not unicodedata.combining(c))
    words = [w for w in re.split(r"[^A-Za-z0-9]+", norm.lower()) if w]
    while words and words[0] in _STOPWORDS:
        words.pop(0)
    while words and words[-1] in _STOPWORDS:
        words.pop()
    key = "_".join(words)[:48].strip("_")
    return key or fallback


def _infer_type(label: str) -> str:
    low = label.lower()
    for needle, kind in _TYPE_HINTS:
        if needle in low:
            return kind
    return "text"


def _label_before(text: str, start: int) -> tuple[str, str]:
    """
    Look back from a blank for the words that name it.

    Returns (label, confidence). A "Label:" immediately before the blank is a
    strong signal; trailing prose is a weaker one; nothing found is weakest.
    """
    window = text[max(0, start - 90):start]
    # A label never spans a line break. Without this the lookback happily
    # swallows the end of the previous paragraph and produces labels like
    # "MENT AGREEMENT agreement made".
    # Drop trailing separators FIRST. A blank in a table cell is preceded by
    # the cell boundary and the paragraph break of the cell before it, so
    # cutting at the last newline straight away would discard the row label
    # ("Basic | ____") and leave nothing to name the question with.
    window = window.rstrip()
    cut = window.rfind("\n")
    if cut != -1:
        window = window[cut + 1:]
    # A tab is a cell boundary, not a line break; keep what precedes it.
    window = window.replace("\t", " ").strip()

    # A label never runs back past the end of the previous sentence, or the
    # question becomes a quotation of the paragraph before it.
    last_stop = None
    for sm in _SENTENCE_END_RE.finditer(window):
        last_stop = sm.end()
    if last_stop is not None:
        window = window[last_stop:]

    m = _LABEL_RE.search(window)
    if m:
        label = " ".join(m.group(1).split())
        # "Monthly Salary (INR)" -> "Monthly Salary": the qualifier
        # belongs in help text, not in the question title.
        label = re.sub(r"\s*\([^)]*\)\s*$", "", label).strip(" ,.-")
        label = _trim_label(label)
        if label and label.lower() not in _STOPWORDS:
            return label, HIGH

    m = _TRAILING_WORDS_RE.search(window)
    if m:
        words = [w for w in m.group(1).split() if w.lower() not in _STOPWORDS]
        if words:
            return " ".join(words[-4:]), MEDIUM

    return "", LOW


def _label_after(text: str, end: int) -> str:
    """
    A parenthetical straight after a blank is the author naming it.

    "Signed by ___ (Employee Name)" is about the employee's name, not about
    signing, and it is the same question as "Employee Name: ___" earlier in
    the document — which is how the two become one linked field (FR-7.4).
    """
    m = _LABEL_AFTER_RE.match(text[end:end + 70])
    if not m:
        return ""
    label = " ".join(m.group(1).split()).strip(" ,.:-")
    # A unit or a hint, not a name.
    if not label or label.lower() in _STOPWORDS or len(label.split()) > _LABEL_MAX_WORDS:
        return ""
    return _trim_label(label)


#: Words that join two things. In a long label the question is whatever
#: follows the LAST of them: "made between ACME Ltd and Employee Name" is
#: asking for the employee's name, not for the pair.
_JOINERS = {"and", "or", "with", "from", "&"}


def _trim_label(label: str) -> str:
    """Keep the last few meaningful words; drop leading glue and joiners."""
    words = label.split()
    if len(words) > _LABEL_MAX_WORDS:
        words = words[-_LABEL_MAX_WORDS:]

    # Only for labels long enough to really be two things joined together.
    # "Terms and conditions" is three words and stays whole.
    if len(words) > 3:
        last_join = max(
            (i for i, w in enumerate(words)
             if w.lower().strip(",") in _JOINERS or w.endswith(",")),
            default=-1,
        )
        if -1 < last_join < len(words) - 1:
            words = words[last_join + 1:]

    while len(words) > 1 and words[0].lower() in _STOPWORDS:
        words.pop(0)
    while words and words[-1].lower() in _STOPWORDS:
        words.pop()
    return " ".join(words).strip(" ,.-")


def _titlecase(label: str) -> str:
    if not label:
        return label
    # Leave an already-capitalised label alone; only fix all-lowercase ones.
    return label if label[:1].isupper() else label[:1].upper() + label[1:]


def detect(text: str, *, limit: int = 200) -> list[dict]:
    """
    Every blank the rules can see, in document order.

    Each detection is:
      start, end        character offsets into `text` (the span to replace)
      original          the exact substring being replaced
      key, label, type  the proposed question
      confidence        high | medium | low
      reason            which rule fired, shown in the review UI
      source            'rule' (the LLM pass marks its own 'ai')
    """
    found: list[dict] = []
    taken: list[tuple[int, int]] = []

    def overlaps(a: int, b: int) -> bool:
        return any(a < end and b > start for start, end in taken)

    def add(start: int, end: int, label: str, confidence: str, reason: str,
            key_hint: str = "", type_hint: str = "") -> None:
        if overlaps(start, end):
            return
        taken.append((start, end))
        found.append({
            "start": start,
            "end": end,
            "original": text[start:end],
            "label": _titlecase(label) if label else "",
            "key": key_hint,
            "type": type_hint,
            "confidence": confidence,
            "reason": reason,
            "source": "rule",
        })

    # Explicit tokens first: the author already said what they want, so these
    # take precedence over anything a fill-run rule would claim.
    for m in _TOKEN_RE.finditer(text):
        raw = m.group(1).strip()
        label = raw.replace("_", " ").replace(".", " ").strip()
        add(
            m.start(), m.end(), label, HIGH,
            "Written as a {{token}} in the document",
            key_hint=_slug(raw, ""), type_hint=_infer_type(label),
        )

    for regex, reason in (
        (_FILL_RE, "A run of fill characters"),
        (_BRACKET_RE, "An empty bracket pair"),
    ):
        for m in regex.finditer(text):
            after = _label_after(text, m.end())
            if after:
                label, conf = after, HIGH
                reason_text = reason + ", named by the text just after it"
            else:
                label, conf = _label_before(text, m.start())
                reason_text = reason
            add(m.start(), m.end(), label, conf, reason_text,
                type_hint=_infer_type(label))

    found.sort(key=lambda d: d["start"])

    # Assign keys only now, in document order, so field_1..field_n read in the
    # order a person meets them. Identical labels deliberately share a key —
    # that is what makes "Client name" on page 1 and page 4 one question
    # (FR-7.4 linked placeholders).
    by_label: dict[str, str] = {}
    used: set[str] = set()
    anon = 0
    for det in found:
        if det["key"]:
            base = det["key"]
        elif det["label"]:
            norm = det["label"].strip().lower()
            if norm in by_label:
                det["key"] = by_label[norm]
                continue
            base = _slug(det["label"], "")
        else:
            base = ""

        if not base:
            anon += 1
            base = f"field_{anon}"

        key = base
        suffix = 2
        while key in used and (not det["label"] or key != by_label.get(det["label"].strip().lower())):
            key = f"{base}_{suffix}"
            suffix += 1
        used.add(key)
        det["key"] = key
        if det["label"]:
            by_label.setdefault(det["label"].strip().lower(), key)

    for det in found:
        if not det["label"]:
            det["label"] = det["key"].replace("_", " ").capitalize()
        if not det["type"]:
            det["type"] = _infer_type(det["label"])

    return found[:limit]
