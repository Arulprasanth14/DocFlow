"""
DocFlow — Page-aware text diff (AP-RES-03), task P4-4

When an owner resubmits, the approver's first question is "what actually
changed?". This answers it per page, so the answer is navigable: a changed
pages list, and for each one the lines added and removed.

Page-aware rather than whole-document on purpose. A document-wide diff of a
re-flowed PDF is mostly noise - insert a sentence on page 2 and every
subsequent line looks moved - and an approver cannot act on noise. Comparing
page N against page N keeps the output small and local, and when the page
count changes the pages past the shortest common length are reported as
added or removed outright rather than mis-aligned against each other.

Text-only, and honest about it (AP-RES-03's "comparison unavailable"
fallback): a scanned revision has no text layer, so there is nothing to
compare and the caller is told so rather than shown an empty diff that looks
like "no changes".
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

#: Longer than this and the diff stops being readable; the page is reported
#: as changed with a count instead of every line.
MAX_LINES_PER_PAGE = 400
MAX_CHANGED_LINES_SHOWN = 40

#: Below this ratio two pages are treated as unrelated rather than diffed
#: line by line, which keeps a wholly rewritten page from rendering as
#: hundreds of pairwise edits.
REWRITTEN_BELOW = 0.35


@dataclass
class PageDiff:
    page_number: int
    #: 'unchanged' | 'changed' | 'rewritten' | 'added' | 'removed'
    status: str
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    similarity: float = 1.0
    truncated: bool = False


@dataclass
class DocumentDiff:
    available: bool
    reason: str | None = None
    pages: list[PageDiff] = field(default_factory=list)
    changed_pages: list[int] = field(default_factory=list)
    added_pages: list[int] = field(default_factory=list)
    removed_pages: list[int] = field(default_factory=list)


def _lines(text: str) -> list[str]:
    """Normalized, non-blank lines.

    Whitespace inside a line is collapsed because PDF extraction is
    inconsistent about spacing between runs, and a diff that reports a
    changed number of spaces as a change is a diff nobody reads twice.
    """
    out: list[str] = []
    for raw in (text or "").splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if line:
            out.append(line)
    return out


def diff_pages(
    before: dict[int, str] | None, after: dict[int, str] | None
) -> DocumentDiff:
    """Compare two versions' extracted text, page by page."""
    if before is None or after is None:
        return DocumentDiff(
            available=False,
            reason=(
                "One of these versions has no readable text, so the two "
                "cannot be compared. Open them side by side instead."
            ),
        )
    if not before and not after:
        return DocumentDiff(
            available=False,
            reason="Neither version has readable text to compare.",
        )

    numbers = sorted(set(before) | set(after))
    pages: list[PageDiff] = []
    changed: list[int] = []
    added_pages: list[int] = []
    removed_pages: list[int] = []

    for number in numbers:
        old_text, new_text = before.get(number), after.get(number)
        if old_text is None:
            pages.append(PageDiff(number, "added", similarity=0.0))
            added_pages.append(number)
            continue
        if new_text is None:
            pages.append(PageDiff(number, "removed", similarity=0.0))
            removed_pages.append(number)
            continue

        old_lines, new_lines = _lines(old_text), _lines(new_text)
        if old_lines == new_lines:
            pages.append(PageDiff(number, "unchanged"))
            continue

        matcher = SequenceMatcher(None, old_lines, new_lines, autojunk=False)
        ratio = matcher.ratio()
        changed.append(number)

        truncated = (
            len(old_lines) > MAX_LINES_PER_PAGE
            or len(new_lines) > MAX_LINES_PER_PAGE
        )
        if ratio < REWRITTEN_BELOW:
            # Wholly different: say so instead of emitting a line-by-line
            # diff of two unrelated pages.
            pages.append(PageDiff(
                number, "rewritten", similarity=round(ratio, 3),
                truncated=truncated,
            ))
            continue

        removed_lines: list[str] = []
        added_lines: list[str] = []
        if not truncated:
            for tag, i1, i2, j1, j2 in matcher.get_opcodes():
                if tag in ("replace", "delete"):
                    removed_lines.extend(old_lines[i1:i2])
                if tag in ("replace", "insert"):
                    added_lines.extend(new_lines[j1:j2])
            if (
                len(removed_lines) > MAX_CHANGED_LINES_SHOWN
                or len(added_lines) > MAX_CHANGED_LINES_SHOWN
            ):
                truncated = True
                removed_lines = removed_lines[:MAX_CHANGED_LINES_SHOWN]
                added_lines = added_lines[:MAX_CHANGED_LINES_SHOWN]

        pages.append(PageDiff(
            number, "changed", added=added_lines, removed=removed_lines,
            similarity=round(ratio, 3), truncated=truncated,
        ))

    return DocumentDiff(
        available=True, pages=pages, changed_pages=changed,
        added_pages=added_pages, removed_pages=removed_pages,
    )
