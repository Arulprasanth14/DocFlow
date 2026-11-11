"""
DocFlow — Annotation anchor validation (section 6.5.2)

Task P3-6. AP-ANN-01, AP-ANN-02, E24.

An anchor is a page number plus a list of rectangles, each expressed as
fractions of the **unrotated** page. Validated on the way in because a bad
anchor is not recoverable later: by the time the viewer tries to draw it the
original selection is gone, and a rectangle with `x = 1500` (pixels, from a
client that got the units wrong) silently paints nothing and looks like a
lost comment.

Normalized rather than pixels so the same anchor lands in the right place at
any zoom, on any screen, and after the page is rotated. Unrotated because the
viewer's rotation is a view setting: two approvers looking at the same page
at different rotations must agree about where a highlight is.
"""
from __future__ import annotations

#: A selection spanning many lines is many rectangles. The cap is generous
#: for real text but stops a client posting a megabyte of geometry per
#: comment, which would make the comments panel unopenable (AP-ANN-10, E24).
MAX_RECTS = 200

#: Rectangles smaller than this in both directions cannot be clicked and are
#: almost always a rounding artefact from a zero-width selection.
MIN_SIDE = 0.0005


class AnchorError(ValueError):
    """An anchor that cannot be drawn. The message is shown to the user."""


def validate_anchor(
    *,
    anchor_type: str,
    page_number: int,
    rects: list | None,
) -> list[dict]:
    """Check and normalize an anchor, returning the rects to store.

    Returns cleaned rectangles (floats, only the four keys, clamped to the
    page) rather than the caller's objects: whatever extra fields a client
    sends are dropped here instead of being persisted into JSONB where they
    would outlive the client version that invented them.
    """
    if anchor_type not in ("text", "area"):
        raise AnchorError(
            "An anchor must be either a text selection or an area."
        )
    if not isinstance(page_number, int) or page_number < 1:
        raise AnchorError("A comment must be anchored to a page (page 1 or later).")

    if not rects:
        raise AnchorError(
            "A comment must be anchored to a place on the page."
        )
    if not isinstance(rects, list):
        raise AnchorError("The anchor geometry is not in the expected shape.")
    if len(rects) > MAX_RECTS:
        raise AnchorError(
            f"That selection covers too many separate areas "
            f"({len(rects)}; the limit is {MAX_RECTS}). Select a smaller range."
        )

    cleaned: list[dict] = []
    for index, raw in enumerate(rects):
        if not isinstance(raw, dict):
            raise AnchorError("The anchor geometry is not in the expected shape.")
        try:
            x = float(raw["x"])
            y = float(raw["y"])
            w = float(raw["w"])
            h = float(raw["h"])
        except (KeyError, TypeError, ValueError) as exc:
            raise AnchorError(
                "Each highlighted area needs an x, y, width and height."
            ) from exc

        # The units check. A client working in pixels sends numbers like
        # 820.5, which would store fine and then draw nowhere — so it is
        # refused with a message that names the actual mistake rather than
        # being silently clamped into a meaningless corner of the page.
        for name, value in (("x", x), ("y", y), ("w", w), ("h", h)):
            if value < -0.01 or value > 1.01:
                raise AnchorError(
                    f"Anchor {name} is {value:g}, which is outside the page. "
                    "Highlight positions are fractions of the page between "
                    "0 and 1, not pixels."
                )
        if w <= 0 or h <= 0:
            raise AnchorError("A highlighted area cannot have zero size.")

        # Clamp the small float error that normalising in the browser leaves
        # behind, and trim anything hanging over the edge.
        x = min(max(x, 0.0), 1.0)
        y = min(max(y, 0.0), 1.0)
        w = min(w, 1.0 - x)
        h = min(h, 1.0 - y)
        if w < MIN_SIDE and h < MIN_SIDE:
            raise AnchorError(
                "That highlight is too small to be shown. Try selecting again."
            )

        cleaned.append({
            "x": round(x, 6), "y": round(y, 6),
            "w": round(w, 6), "h": round(h, 6),
        })
        if index + 1 > MAX_RECTS:  # pragma: no cover - guarded above
            break

    return cleaned
