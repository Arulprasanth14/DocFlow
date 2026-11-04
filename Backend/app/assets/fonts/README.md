# Fonts bundled for PDF rendering

**Noto Sans** (Regular / Bold / Italic / BoldItalic), from the official
[notofonts](https://github.com/notofonts/latin-greek-cyrillic) release.

- **Licence:** SIL Open Font License 1.1 — see `OFL.txt` in this directory.
  Permissive and fine for commercial use. The font files themselves remain
  under OFL; PDFs that embed them carry no attribution requirement.
- **Why bundled rather than a system font:** the PDF renderer must produce
  byte-identical output on a developer's Windows machine and in the container,
  and an embedded font is the only way to guarantee that. reportlab's own
  bundled Vera family was rejected: it has 283 glyphs and cannot draw ₹,
  Greek or Cyrillic.
- **Coverage:** 2,965 glyphs — Latin, Latin Extended, Greek, Cyrillic, ₹ and
  other currency symbols, smart quotes, dashes, arrows, maths.
- **NOT covered:** CJK, Arabic, Devanagari, Tamil and other Indic scripts.
  `pdf_renderer.py` substitutes a visible marker for anything unrenderable and
  records it, rather than emitting a silent blank. If a deployment needs those
  scripts, add the matching Noto family here and register it as a fallback.
