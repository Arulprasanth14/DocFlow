"""
Render the DocFlow logo mark to PNG for use in emails.

The mark is the one in the app header (Frontend/src/components/layout/
AppLayout.tsx): a rounded square with a 135deg gradient from the light-theme
primary (#2F6FD6) to the accent (#6256B8), holding a white document glyph
(the same 24x24 path the app draws). Email clients can't render the app's
inline SVG or CSS gradients reliably, so it is rasterised once here and
embedded in each email as an inline (CID) image.

    cd Backend && python -m scripts.generate_email_logo
"""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw

SIZE = 160          # final px (displayed at 40px in the email: crisp on 4x screens)
SS = 4              # supersampling factor for anti-aliasing
PRIMARY = (0x2F, 0x6F, 0xD6)
ACCENT = (0x62, 0x56, 0xB8)
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "app", "emails", "assets", "docflow-logo.png")


def _arc(cx, cy, r, a0, a1, n=12):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def main() -> None:
    n = SIZE * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))

    # 135deg gradient (top-left -> bottom-right)
    grad = Image.new("RGBA", (n, n))
    px = grad.load()
    for y in range(n):
        for x in range(n):
            t = (x + y) / (2 * (n - 1))
            px[x, y] = tuple(int(PRIMARY[i] + (ACCENT[i] - PRIMARY[i]) * t) for i in range(3)) + (255,)

    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, n - 1, n - 1), radius=int(n * 0.25), fill=255)
    img.paste(grad, (0, 0), mask)

    # Document glyph: the app's 24x24 path, drawn at 17/32 of the square.
    glyph = n * 17 / 32
    ox = oy = (n - glyph) / 2
    k = glyph / 24

    def P(x, y):
        return (ox + x * k, oy + y * k)

    pts = [P(14, 2), P(6, 2)]
    pts += [P(*q) for q in _arc(6, 4, 2, 270, 180)]          # top-left corner
    pts += [P(4, 20)]
    pts += [P(*q) for q in _arc(6, 20, 2, 180, 90)]          # bottom-left
    pts += [P(18, 22)]
    pts += [P(*q) for q in _arc(18, 20, 2, 90, 0)]           # bottom-right
    pts += [P(20, 8), P(14, 2)]
    d = ImageDraw.Draw(img)
    w = int(2.5 * k)
    d.line(pts, fill="white", width=w, joint="curve")
    d.line([P(14, 2), P(14, 8), P(20, 8)], fill="white", width=w, joint="curve")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.resize((SIZE, SIZE), Image.LANCZOS).save(OUT, optimize=True)
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
