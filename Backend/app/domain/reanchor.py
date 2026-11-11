"""
DocFlow — Re-anchoring a comment on a later version (AP-ANN-22, AP-ANN-23)

Task P3-13. E17, E30, T38.

When the owner uploads a revision, comments from the version it replaces
are carried onto it so the approver can see whether each one was dealt with.
The text they were anchored to may have moved, been reworded, or gone.

This module answers one question, purely: given the quote and its context,
and the text of each page of the new version, which page is it on now - if
any? It deliberately does NOT produce rectangles. Geometry needs the text
layer's layout, which only the viewer has, so the viewer draws the highlight
from the quote on the page this names.

Best-effort by specification. AP-ANN-23 treats "not found" as a correct
outcome, shown as "Location changed" - which is far better than a confident
highlight on the wrong sentence.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

_WS = re.compile(r"\s+")

#: Quotes shorter than this match by accident all over a document; without
#: context to disambiguate they are not trusted.
MIN_UNAMBIGUOUS = 12


@dataclass(frozen=True)
class Relocation:
    found: bool
    page_number: int | None = None


def _norm(text: str | None) -> str:
    """Whitespace-insensitive, case-insensitive. A revision routinely
    re-flows lines, and PDF text extraction disagrees with itself about
    spaces between runs."""
    return _WS.sub(" ", text or "").strip().lower()


def _page_order(original_page: int, total: int) -> list[int]:
    """Same page first, then outward. An edit usually pushes text a page
    later or pulls it one earlier, and the nearest match is the likeliest."""
    order = [original_page] if 1 <= original_page <= total else []
    for distance in range(1, total + 1):
        for candidate in (original_page + distance, original_page - distance):
            if 1 <= candidate <= total and candidate not in order:
                order.append(candidate)
    return order


def relocate(
    *,
    selected_text: str | None,
    text_prefix: str | None,
    text_suffix: str | None,
    original_page: int,
    pages: dict[int, str],
) -> Relocation:
    """Find where a quoted selection now lives. `pages` is 1-based."""
    quote = _norm(selected_text)
    if not quote or not pages:
        return Relocation(found=False)

    prefix, suffix = _norm(text_prefix), _norm(text_suffix)
    normalized = {n: _norm(t) for n, t in pages.items()}
    order = _page_order(original_page, max(normalized))

    # 1. The quote with its context: the strongest evidence it is the same
    #    passage and not another occurrence of the same words.
    if prefix or suffix:
        with_context = " ".join(p for p in (prefix, quote, suffix) if p)
        for number in order:
            if with_context in normalized.get(number, ""):
                return Relocation(found=True, page_number=number)

    # 2. The quote alone - trusted only if it is long enough to be
    #    distinctive AND occurs exactly once in the whole document. Two
    #    occurrences means we cannot say which one the comment was about.
    if len(quote) >= MIN_UNAMBIGUOUS:
        hits = [n for n in order if quote in normalized.get(n, "")]
        occurrences = sum(normalized[n].count(quote) for n in hits)
        if occurrences == 1:
            return Relocation(found=True, page_number=hits[0])

    return Relocation(found=False)
