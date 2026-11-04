"""
DocFlow — redact personal data before document text leaves the building (FR-10.7).

Every AI feature in this module sends some of a document's text to an external
model. The org switch (default off), the per-user opt-out and the per-import
opt-in all govern *whether* that happens; this governs *what* goes when it
does.

What it finds
-------------
Structured identifiers: email address, phone number, PAN, Aadhaar number,
GSTIN, IFSC code, payment card (Luhn-checked), IP address, passport number.

Contextual personal identifiers (FR-10.7):
  - Personal NAMES: matched via surrounding cues — honorifics (Mr/Mrs/Ms/Dr/
    Shri/Smt/Prof), "between <A> and <B>", parentage ("S/o", "D/o", "W/o"),
    signature blocks ("Signed by", "Name:", "Authorised Signatory"), and
    "<Capitalised Words>, residing at".
  - POSTAL ADDRESSES: capitalised run followed by Road/Street/Lane/Nagar/
    Avenue/Marg/Block/Sector/Phase, plus "<city> - <6-digit PIN>" and
    "PIN/Pincode <6 digits>".

Residual limitation (honestly documented):
  A bare name appearing with no surrounding contextual cue (for example,
  "Raman will sign tomorrow" or "hand this to Rahul") is NOT caught without
  a full named-entity recognition (NER) model, which would require sending
  the text to an external model — the exact thing this redactor exists to
  avoid. We do not claim 100% name coverage; we catch names in standard legal
  and contractual patterns where they are declared or signed. Dates, amounts,
  currency, and invoice numbers are deliberately preserved untouched.

How it replaces
---------------
Two modes, because two callers need different things:

  `redact()`        swaps each match for `[[EMAIL_1]]`, `[[NAME_1]]`, etc.,
                    and returns a mapping, so whatever the model writes back
                    can have the real values put back by `restore()`. Used
                    wherever the reply becomes document text.

  `mask_lengths()`  swaps each match for the same number of `#` characters.
                    Used by the blank detector, whose reply is a set of
                    character offsets into the text it was given: a mapping
                    that changed the length would shift every offset after it
                    and silently corrupt the "AI did not rewrite the document"
                    proof (FR-9.4). Nothing is restored, because nothing needs
                    to be — the reply carries no text.

The same value appearing twice gets the same placeholder, which is what makes
a document readable to the model: "pay [[NAME_1]]" and "contact [[NAME_1]]"
are visibly the same person.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

#: Order matters. The first pattern to claim a span keeps it, so the specific
#: formats (PAN, GSTIN, Aadhaar) are tried before the general digit runs that
#: would otherwise swallow them. NAME and ADDRESS go at the end so all specific
#: identifiers get first refusal.
_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # RFC-ish, deliberately not exhaustive: the goal is to catch what real
    # documents contain, not to validate addresses.
    ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")),
    # GSTIN: 2-digit state, 10-char PAN, entity digit, 'Z', checksum.
    ("GSTIN", re.compile(r"\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]\w\b")),
    # PAN: five letters, four digits, one letter.
    ("PAN", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b")),
    # IFSC: four letters, '0', five alphanumerics.
    ("IFSC", re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")),
    # Indian passport: one letter then seven digits.
    ("PASSPORT", re.compile(r"\b[A-PR-WY][0-9]{7}\b")),
    # Card numbers are Luhn-checked below before being accepted. Tried BEFORE
    # Aadhaar: this needs 13+ digits so it can never claim a 12-digit Aadhaar,
    # but Aadhaar's 12-digit shape *would* claim the first twelve digits of a
    # 16-digit card and leave the last four behind under the wrong label.
    ("CARD", re.compile(r"\b(?:\d[ -]?){12,18}\d\b")),
    # Aadhaar: twelve digits, optionally in groups of four. Must not start
    # with 0 or 1 by specification, which also keeps it off most amounts.
    ("AADHAAR", re.compile(r"\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b")),
    ("IP", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    # Phone numbers last among numbers: the loosest shape.
    ("PHONE", re.compile(
        r"(?<![\w.])(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?(?:\d[ -]?){9,13}\d"
        r"(?!\.?\d)(?![A-Za-z_])"
    )),
    # ── Contextual Names (FR-10.7) ───────────────────────────────────────────
    # Honorifics followed by capitalized words
    ("NAME", re.compile(r"\b(?:Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Shri\.?|Smt\.?|Prof\.?)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b")),
    # Parentage: S/o, D/o, W/o followed by capitalized words
    ("NAME", re.compile(r"\b(?:[SWD]/o|s/o|d/o|w/o)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b")),
    # Signature blocks: Signed by, Name:, Authorised Signatory
    ("NAME", re.compile(r"\b(?:Signed\s+by|Name\s*:|Authorised\s+Signatory\s*:?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b", re.IGNORECASE)),
    # Capitalized Words, residing at
    ("NAME", re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)(?=,\s+residing\s+at\b)")),
    # between <A> and <B> — contract parties. BOTH sides must be at least two
    # capitalised words: a one-word side is far more often a place or a
    # department than a person ("between Delhi and Mumbai", "between Finance
    # and Legal"), and this pattern is for personal names.
    ("NAME", re.compile(
        r"\bbetween\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+and\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b"
    )),
    # ── Contextual Addresses (FR-10.7) ───────────────────────────────────────
    # Capitalised run followed by a street-type word.
    #
    # Two deliberate restrictions, both from false positives this pattern
    # actually produced:
    #   * NO re.IGNORECASE. With it, "[A-Z]" matched lowercase as well and
    #     ordinary prose like "the road ahead" became an address.
    #   * The street word must be followed by a terminator — comma, full stop,
    #     semicolon, bracket, digit, or end of line. Without it, "The Road Map
    #     Review Committee" was redacted as an address, because "Road" was
    #     matched and whatever followed was ignored.
    # The cost of the terminator rule: "MG Road Chennai - 600042" loses the
    # "MG Road" part of the match. The PIN pattern below still redacts
    # "Chennai - 600042", so the address is not left fully in the clear.
    ("ADDRESS", re.compile(
        r"\b(?:\d+[\w/,\-]*\s+)?(?:[A-Z][\w.\-]*\s+){1,4}"
        r"(?:Road|Street|Lane|Nagar|Avenue|Marg|Block|Sector|Phase)"
        r"\b(?=\s*(?:[,.;:)\]]|\d|$))"
    )),
    # <City> - <6-digit PIN>
    ("ADDRESS", re.compile(r"\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s*[-–]\s*[1-9][0-9]{5}\b")),
    # PIN / Pincode <6 digits>
    ("ADDRESS", re.compile(r"\b(?:PIN|Pincode|PIN\s*Code)[:\s]*[1-9][0-9]{5}\b", re.IGNORECASE)),
]

#: A date like 2026-11-02, or a plain year, must never be read as an
#: identifier. Checked before a numeric match is accepted.
_DATE_LIKE = re.compile(r"^\s*\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\s*$")

_NUMERIC_KINDS = {"AADHAAR", "CARD", "PHONE"}


def _luhn_ok(digits: str) -> bool:
    """The check digit every payment card carries. Keeps order numbers out."""
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = ord(ch) - 48
        if i % 2:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def _plausible(kind: str, raw: str) -> bool:
    """Reject a match whose shape fits but whose content says otherwise."""
    if _DATE_LIKE.match(raw):
        return False
    if kind not in _NUMERIC_KINDS:
        return True
    digits = re.sub(r"\D", "", raw)
    if kind == "CARD":
        return 13 <= len(digits) <= 19 and _luhn_ok(digits)
    if kind == "AADHAAR":
        return len(digits) == 12
    if kind == "PHONE":
        # 10 to 14 digits. Shorter is an amount or a reference; longer is an
        # account number this pass is not trying to claim.
        return 10 <= len(digits) <= 14
    return True


@dataclass
class Redaction:
    """The text that may leave, and how to put the real values back."""

    text: str
    #: placeholder -> original value
    mapping: dict[str, str] = field(default_factory=dict)
    #: kind -> how many distinct values were replaced
    counts: dict[str, int] = field(default_factory=dict)

    @property
    def redacted_any(self) -> bool:
        return bool(self.mapping)

    def summary(self) -> str:
        """One line for the audit record, with no values in it."""
        if not self.counts:
            return "none"
        return ", ".join(f"{k.lower()}={v}" for k, v in sorted(self.counts.items()))


def _find_spans(text: str) -> list[tuple[int, int, str, str]]:
    """Non-overlapping `(start, end, kind, value)`, earliest and most specific."""
    claimed: list[tuple[int, int, str, str]] = []

    def overlaps(a: int, b: int) -> bool:
        return any(not (b <= s or a >= e) for s, e, _, _ in claimed)

    for kind, pattern in _PATTERNS:
        for m in pattern.finditer(text):
            if m.groups():
                for idx in range(1, len(m.groups()) + 1):
                    start, end = m.start(idx), m.end(idx)
                    raw = m.group(idx)
                    if not raw or not _plausible(kind, raw):
                        continue
                    if overlaps(start, end):
                        continue
                    claimed.append((start, end, kind, raw))
            else:
                start, end = m.start(), m.end()
                raw = m.group(0)
                if not _plausible(kind, raw):
                    continue
                if overlaps(start, end):
                    continue
                claimed.append((start, end, kind, raw))
    claimed.sort(key=lambda t: t[0])
    return claimed


def redact(text: str) -> Redaction:
    """
    Replace each identifier with a stable `[[KIND_n]]` placeholder.

    The same value always gets the same placeholder, so the model can still
    see that two mentions are the same person.
    """
    if not text:
        return Redaction(text="")

    spans = _find_spans(text)
    if not spans:
        return Redaction(text=text)

    by_value: dict[tuple[str, str], str] = {}
    counts: dict[str, int] = {}
    mapping: dict[str, str] = {}
    out: list[str] = []
    cursor = 0

    for start, end, kind, raw in spans:
        key = (kind, raw)
        placeholder = by_value.get(key)
        if placeholder is None:
            counts[kind] = counts.get(kind, 0) + 1
            placeholder = f"[[{kind}_{counts[kind]}]]"
            by_value[key] = placeholder
            mapping[placeholder] = raw
        out.append(text[cursor:start])
        out.append(placeholder)
        cursor = end

    out.append(text[cursor:])
    return Redaction(text="".join(out), mapping=mapping, counts=counts)


def mask_lengths(text: str) -> Redaction:
    """
    Replace each identifier with `#` of exactly the same length.

    Every character offset in the result refers to the same position as in the
    input, which is what the blank detector's offset-based reply and its
    no-rewrite proof depend on (FR-9.4).
    """
    if not text:
        return Redaction(text="")

    spans = _find_spans(text)
    if not spans:
        return Redaction(text=text)

    counts: dict[str, int] = {}
    seen: set[tuple[str, str]] = set()
    chars = list(text)
    for start, end, kind, raw in spans:
        if (kind, raw) not in seen:
            seen.add((kind, raw))
            counts[kind] = counts.get(kind, 0) + 1
        for i in range(start, end):
            chars[i] = "#"

    masked = "".join(chars)
    assert len(masked) == len(text), "mask_lengths must not change the length"
    # No mapping: there is nothing to restore, and handing back a mapping
    # would invite a caller to try.
    return Redaction(text=masked, mapping={}, counts=counts)


def restore(text: str, mapping: dict[str, str]) -> str:
    """
    Put the real values back into a model's reply.

    Longest placeholder first, so `[[EMAIL_1]]` is never partly matched by
    `[[EMAIL_11]]`'s prefix.
    """
    if not text or not mapping:
        return text
    out = text
    for placeholder in sorted(mapping, key=len, reverse=True):
        out = out.replace(placeholder, mapping[placeholder])
    return out


def restore_in(value: object, mapping: dict[str, str]) -> object:
    """`restore` applied through a parsed JSON reply, leaving the shape alone."""
    if not mapping:
        return value
    if isinstance(value, str):
        return restore(value, mapping)
    if isinstance(value, list):
        return [restore_in(v, mapping) for v in value]
    if isinstance(value, dict):
        return {k: restore_in(v, mapping) for k, v in value.items()}
    return value
