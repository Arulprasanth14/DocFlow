# DocFlow Landing Page — Complete Build Record & Design System

> Everything used to build `Frontend/src/pages/landing/`: the stack, the architecture, the
> design tokens, the motion system, the 3D rig, the cursor, the responsive engine, the
> bugs and their root causes. Written so it can be pasted into a fresh Claude session as a
> complete design + implementation brief.
>
> 57 files · ~11,700 lines · 5 phases · verified across 7 viewports × 2 themes.

---

## 1. Stack — what we used and why

| Layer | Tool | Version | Why this one |
|---|---|---|---|
| UI | React | 19 | Project baseline; `lazy` + `Suspense` for route/3D splitting |
| Language | TypeScript (strict) | 5.x | Strict mode on; landing folder kept at 0 errors |
| Build | Vite | 8 | Fast HMR; route-level code splitting |
| Styling | Tailwind CSS | v4 | `@theme inline` bridge to the app's CSS variables |
| Animation | **GSAP** | 3.15 | ScrollTrigger, SplitText, Flip. **Only** animation lib — no framer-motion |
| Smooth scroll | Lenis | latest | Driven by `gsap.ticker`, wired into `ScrollTrigger.update` |
| 3D | three.js | 0.186 | |
| 3D React | @react-three/fiber | 9 | `<Canvas>`, `useFrame` |
| 3D helpers | @react-three/drei | 10 | `Environment`, `Lightformer`, `ContactShadows`, `Sparkles`, `RoundedBox`, `Html`, `PerformanceMonitor` |
| Icons | lucide-react, @tabler/icons-react | — | |
| State | Zustand (app theme) + `useSyncExternalStore` (landing) | — | See §3 |
| Charts | recharts | — | Analytics section only |
| Verification | Playwright (Chromium) | devDep | Scripted 7×2 matrix harness |

**Zero new dependencies were installed.** Everything above was already in `package.json`.
The only non-landing file touched in the whole build was `src/App.tsx` (3 lines, route split).

---

## 2. Art direction — "Glass, Paper, Light"

The whole visual language in one paragraph: a pearl-white (or deep-navy) page, white/slate
**glass panels** floating over soft **aurora glows**, separated by **torn-paper edges**,
with a cyan→blue→indigo accent used sparingly and an original paper mascot (**Docky**).

### Hard rules that drove every decision

1. **One focal point per viewport.** Never two competing hero objects.
2. **8px spacing grid.** Everything is a multiple of 8 (via `--lp-space-*`).
3. **Three elevation levels only** (`lp-elev-1/2/3`). No fourth shadow.
4. **No flat solid boxes.** Every surface is glass: translucent + `backdrop-blur` + 1px
   hairline gradient border + faint inner highlight.
5. **Shadows are never pure black.** Light mode = blue-grey tint; dark = deep navy tint.
6. **Max 3 hues per viewport.** Neutrals + ONE accent family. Semantic colour (green/amber/red)
   is allowed *only* on status chips and stamps.
7. **Nothing below 12px.** Anywhere. Including inside scaled stages (see §5.4).
8. **Gradient text on exactly ONE word per headline.** Instrument Serif italic.
9. **Grain overlay at 2–3%** over the page.
10. **Light theme is fully light; dark is fully dark.** Never a dark band inside light mode.

### Typography

| Role | Token | Size | Tracking | Leading |
|---|---|---|---|---|
| Display (h1) | `--lp-text-display` | `clamp(2.5rem, 6vw, 4.5rem)` | `-0.03em` | 1.05 |
| H2 | `--lp-text-h2` | `clamp(1.875rem, 3.5vw, 3rem)` | `-0.03em` | 1.08 |
| H3 | `--lp-text-h3` | `clamp(1.25rem, 2vw, 1.75rem)` | `-0.02em` | 1.15 |
| Body | `--lp-text-body` | `clamp(1.0625rem, 1.2vw, 1.125rem)` | normal | **1.65** |
| Label | `--lp-text-label` | `0.9375rem` (15px) | — | 1.45 |
| Eyebrow | `--lp-text-eyebrow` | `0.8125rem` (13px) | `0.08em` upper | 1.4 |

Body is 17–18px, not 16px — that single choice is most of the "premium" feel.
**No mono micro-labels anywhere** (they were all stripped out in Phase 4).

### Motion tokens

```css
--lp-ease-out: cubic-bezier(0.16, 1, 0.3, 1);   /* expo.out */
--lp-dur-fast: 0.22s;  --lp-dur-base: 0.45s;  --lp-dur-slow: 0.8s;
```

Rules: entrance stagger **60–90ms**; durations **0.4–0.9s**; `expo.out`/`power3.out` only;
at least **one scroll-linked (scrubbed) moment** per section; every interactive element has
hover + focus-visible + active (+ disabled).

---

## 3. Architecture — the five systems

Everything non-visual lives in one of five systems. This is the part worth reusing.

### 3.1 Theme token bridge — `lib/tokens.ts`

The landing invents **no colours**. It reads the app's "Ice" theme tokens at runtime and
exposes them to JS (for WebGL and SVG, which can't read CSS variables).

```ts
// Normalise any CSS colour (oklch, hsl, rgb, named) to #rrggbb via a canvas round-trip,
// because three.js only accepts hex/rgb.
function normalise(cssColor: string): string {
  ctx.fillStyle = '#000';
  ctx.fillStyle = cssColor;        // browser parses it for us
  return ctx.fillStyle;            // always comes back as #rrggbb
}
```

- `useThemeTokenSnapshot()` is a `useSyncExternalStore` singleton that re-reads
  `getComputedStyle(document.documentElement)` on theme change via a `MutationObserver`
  on the `class` attribute.
- **Theme change never remounts the canvas** — materials and lights just get new colours.
- Derived `--lp-*` variables are built with `color-mix(in srgb, …)` from app tokens, never
  hard-coded.

### 3.2 Layout mode store — `hooks/useLayoutMode.ts`

**One** decision, shared by ScrollTrigger pinning and FitStage. This was the fix for the
single worst bug in the project (three subsystems deciding layout independently).

```ts
export function computeLayoutMode(width: number, height: number): LayoutMode {
  if (width < 768) return 'mobile';    // single column, swipe carousels, 3D static
  if (width < 1024) return 'tablet';   // same content, stacked, unpinned
  if (width < 1280 || height < 700) return 'compact';  // unpinned, compact scenes
  return 'wide';                       // full pinned scrollytelling
}
// canPin = mode === 'wide'
```

- Debounced 120ms on `resize` / `orientationchange` / `visualViewport`.
- Writes `data-layout="wide|compact|tablet|mobile"` onto `.landing-scope` so CSS can react.
- Calls `requestAnimationFrame(() => ScrollTrigger.refresh())` on mode change.
- Exposes `layoutStore.measure()` for imperative reads inside GSAP setup code.
- **Height matters as much as width** — a 1920×600 window is `compact`, not `wide`.

### 3.3 FitStage — `components/FitStage.tsx`

Pinned scrollytelling scenes are laid out at a fixed *design size* (e.g. 1200×680) and
scaled to fit. Three rules, learned the hard way:

1. **Available height comes from the viewport**, never from the component's own box
   (measuring a box whose size you also set = ResizeObserver feedback loop).
2. **Content height is measured at design width**, so the scale is honest.
3. **Pinning requires BOTH** `layoutStore.canPin` AND `scale >= 0.75`.
   Below 0.75 the scene unpins and becomes a stacked layout — text never goes tiny.

```tsx
scale = Math.min(availW / designW, availH / designH)
// availH = 100svh − navbar − safe padding
style={{ width: designWidth, transform: `scale(${scale})`, '--lp-scale': scale }}
data-lp-stage={pinned && scale < 1 ? 'scaled' : undefined}
```

It publishes `--lp-scale` so CSS can **counter-scale** the type floor:

```css
[data-lp-stage='scaled'] :is(.text-\[0\.8125rem\], .text-xs, .lp-stage-fine) {
  font-size: max(0.8125rem, calc(0.8125rem / var(--lp-scale, 1)));
}
```

`overflow: visible` while pinned, so nothing can ever be clipped.

### 3.4 Placement engine — `lib/placeInRect.ts` + `hooks/usePlaceInRect.ts`

**No element in the landing page has a hard-coded pixel coordinate.** Scattered items
(Problem chaos cards, hero orbit chips, floating badges) are placed at runtime:

- Seeded PRNG (Lehmer / Park–Miller) → deterministic layout for a given size + seed.
- Items start in a preferred quadrant, then **collision relaxation** pushes them apart with a
  **decaying push** (`12 * (1 - iter/max) + 2`) so the system settles instead of oscillating.
- `avoid: Rect[]` zones keep items off headings, CTAs and the mascot.
- Everything is clamped inside the container with padding.
- **Verification pass**: if anything still overlaps, or an item is bigger than the box, it
  returns `ok: false, strategy: 'grid'` and falls back to `tidyGrid()` — a tidy,
  guaranteed-non-overlapping grid. An honest grid beats a messy pile.
- `usePlaceInRect` measures each item's **real rendered box** via `[data-place-id]` and
  observes the container *and every item* with one `ResizeObserver`.

### 3.5 Landing store — `store.ts`

A `useSyncExternalStore` singleton holding scroll progress and the active section. The
navbar active pill, the scroll progress bar and the lifecycle tracker all read from **this
one store** — no component computes scroll position itself.

---

## 4. The custom cursor — `CustomCursor.tsx` + `custom-cursor.css`

The signature feature. Not a dot-and-ring clone.

**Anatomy:** (1) 8px accent core dot, near-instant follow. (2) 40px glass ring with trailing
inertia, hairline gradient border, backdrop blur. (3) A label chip shaped as a rounded
rectangle with a **folded top-right corner** — the Docky paper motif, via
`clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%)`.

**Mechanics**
```ts
gsap.set([ringWrap, coreWrap], { xPercent: -50, yPercent: -50 });
const coreX = gsap.quickTo(core, 'x', { duration: 0.08 });
const ringX = gsap.quickTo(ring, 'x', { duration: 0.35, ease: 'power3.out' });
```
- `translate3d` only, rAF-driven, `position: fixed`, `pointer-events: none`, top z-index.
- Velocity **squash-and-stretch** on the ring (up to 1.3× along the movement angle, decays at rest).
- Idle **breathing** after 3s.
- **One persistent ring that morphs** via `data-state` + CSS transitions — not a ring per state.
- Centring uses a 0×0 grid box with `place-items: center`, **not** a CSS translate (GSAP would
  overwrite a CSS transform).

**States** — via event delegation with `closest('[data-cursor]')`:

| State | Behaviour |
|---|---|
| `link` | ring → 64px, accent tint |
| `cta` | ring fills with accent gradient, `↗` label, element becomes **magnetic** (pulls up to 12px) |
| `card` | ring morphs to a 48px rounded square (r 14px), label "View" |
| `stamp` | stamp glyph; on click: "thunk" press + ink ripple + 6–10 paper-bit particles |
| `drag` | label "Drag" with arrows |
| `canvas` | 34px, hint "Move" (over the 3D hero) |
| `text` | ring hides, core becomes a 2px vertical bar the height of the hovered line |
| `native` | real cursor returns (inputs, textarea, select, contenteditable) |

**Safety rules that matter**
- `cursor: none` is applied **only after** the cursor has mounted and positioned itself
  (`data-cursor-active="true"` on `.landing-scope`), so a crash never leaves the user with no
  pointer. Fully removed on unmount/route change.
- Enabled only when `matchMedia('(hover: hover) and (pointer: fine)')` matches — hidden on touch.
- `prefers-reduced-motion`: no stretch, breathing, particles or magnetism; plain follow remains.
- Keyboard focus rings completely unaffected.

**Component API** is just data attributes — `lib/cursor.ts` exports `cursorProps(kind, label?)`,
so no component contains cursor logic:

```tsx
<button {...cursorProps('cta')}>Get started</button>
<article {...cursorProps('card', 'Open')}>…</article>
```

---

## 5. Responsive engine — the rules

- **`svh`/`dvh` everywhere, never `vh`.** Hero is `min-height: min(100svh, 920px)`.
- **No `height: 100vh` container ever holds content.**
- All type and spacing via `clamp()` with `vw` + `svh`; section padding scales with the viewport.
- Mockups: `aspect-ratio` + `width: min(100%, maxPx)` — never fixed heights.
- **No truncation or ellipsis on informational text.** `line-clamp` was removed everywhere; text wraps.
- `overflow-wrap: break-word` on `.landing-scope` (**not** `anywhere` — see §8.3).
- Anchors use `scroll-margin-top = navbarHeight + 16px`, and Lenis `scrollTo` uses the same offset.
- A section's own content must fit in its own viewport. Pinned-scene content lives *inside* the
  pin; overflow content (e.g. the four Problem pain cards) goes **after** the pin in normal flow.

**Test matrix — every phase, both themes:**
`390×844` · `768×1024` · `1024×600` · `1280×720` · `1366×768` · `1440×900` · `1920×1080`

---

## 6. 3D system

### 6.1 One canvas, merged — `components/3d/HeroCanvas.tsx`

Originally three WebGL contexts (wave field, paper stack, final CTA). Merged to **two total**:
the hero (wave + paper share one camera) and the final CTA.

```tsx
<Canvas
  dpr={dpr}                                  // from the performance tier
  camera={{ position: [0, 0.9, 9], fov: 42, near: 0.1, far: 80 }}
  gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
  style={{ pointerEvents: 'none' }} data-cursor="canvas"
>
```

### 6.2 Lighting recipe — procedural, nothing downloaded

```tsx
<Environment frames={1} resolution={128}>
  <Lightformer form="rect" color="#eaf4ff" position={[-5, 5, 4]}  scale={[8, 8, 1]} />  {/* cool key  */}
  <Lightformer form="rect" color="#fff1dd" position={[6, -2, 2]}  scale={[6, 6, 1]} />  {/* warm rim  */}
  <Lightformer form="rect" color="#ffffff" position={[0, 7, 0]}   scale={[12, 2, 1]} /> {/* top strip */}
</Environment>
```
`frames={1}` bakes the environment once. No CDN presets, no HDRI fetch, no runtime downloads.

**Critical rule: lights stay near-white.** Intensities change per theme, colours don't.
Tinting a light with a *text* token makes it an almost-black light in light mode — which is
exactly how the "dark block in the light hero" bug happened (§8.2).

### 6.3 Materials

- **Paper sheets**: 6 `RoundedBox` in a fanned cascade, `MeshPhysicalMaterial`
  (`roughness 0.35`, `clearcoat 1`, `clearcoatRoughness 0.2`, `sheen 0.5`, subtle iridescence).
  Pointer tilt damped, max 6–8°; scroll drives lift / fly-through.
- **Glass cards** (max 3–4): drei `MeshTransmissionMaterial` on high tier, plain translucent
  `MeshPhysicalMaterial` below. Card text is DOM via drei `<Html transform>` so it uses app fonts.
- **Grounding**: `ContactShadows` tinted from tokens; `Sparkles` as ambient motes (high tier only).
- **Wave field** (`FlowWave.tsx`): a custom-shader `<points>` grid of particle hills ported from a
  reference implementation, with its full-screen opaque composite and post chain **removed** so
  the canvas stays transparent. Dark = additive blending; light = normal blending, soft blue-ink
  points, no bloom.

### 6.4 Post-processing

| Theme | Effects |
|---|---|
| Dark | one `Bloom` (mipmapBlur, moderate intensity, high luminance threshold) + faint Vignette/Noise |
| Light | **no bloom** — only very faint Noise |

Rule: if a post effect breaks canvas transparency over the page, **drop it**.

### 6.5 Performance tiers — `hooks/usePerformanceTier.ts`

Tiered **without any network check**, using `navigator.hardwareConcurrency`,
`navigator.deviceMemory`, `pointer: coarse` and viewport width. The tier controls DPR cap,
particle count (high 120×360 / medium 80×240 / low 48×144), glass-object count and post effects.
drei `PerformanceMonitor` lowers DPR live on frame drops.

### 6.6 Hard 3D rules

- **Never put per-frame values in React state.** A shared mutable ref is written by GSAP /
  pointer handlers and read inside `useFrame` with `MathUtils.damp`.
- `frameloop="demand"` when off-screen; dispose everything when far off-screen.
- Lazy-loaded and code-split so it loads **after first paint** — the `<h1>` is the LCP element,
  never the canvas.
- Static SVG/CSS fallback when WebGL is missing, reduced motion is on, or the context is lost.

---

## 7. Content systems

### 7.1 Torn paper — `TornDivider.tsx`

A **generated** SVG, not an asset. Seeded multi-octave noise (`lib/noise.ts`) produces a
6–18px ragged edge with occasional notches; 3 seed variants. Four stacked layers:

1. rim light (`--lp-torn-rim`, transparent in light mode)
2. paper-fibre band (`--lp-paper-fiber`, 3–5px lighter) with a turbulence filter
3. hairline (`--lp-paper-edge`)
4. silhouette with `feDropShadow` using `--lp-torn-shadow`

Optional scroll-scrubbed reveal (one per viewport). **All paint goes through the `style` prop,
never presentation attributes** — see §8.1.

### 7.2 Illustration set — `illustrations/`

Eight original SVGs in one consistent style: soft isometric paper-and-glass, 1.5px rounded
strokes, token gradient fills, contact shadow, tiny sparkle details.

`IsoDocStack` · `IsoStamp` · `IsoVault` · `IsoNetwork` · `IsoShieldBuilding` ·
`IsoChatBubbles` · `IsoSignature` · `IsoInsights`

Each is theme-aware through CSS variables, carries 3–5 small GSAP micro-animations (paused
off-screen), sits in the section it explains, never collides with text, and is marked
`aria-hidden="true" focusable="false"`. All 16 in-SVG `<text>` micro-labels were removed —
they could not satisfy the 12px floor at every scale.

### 7.3 Docky — the mascot

A 2D SVG rig (`Docky.tsx`) with separate groups for body, fold, eyes, brows, mouth, arms, legs
and accessory. Expressions crossfade; idle breathing + blink every 4–6s. Accessories: pen,
stamp, glasses, badge, key, cap, sign. Expression must match the moment — happy in hero and
Approved, worried **only** in Problem, thinking in Pending.

**A 3D Docky was built and then rejected** by the spec's own quality gate (he read as a
toy-like angry slab). The polished 2D SVG is layered beside the canvas instead. `Docky3D.tsx`
remains in the tree, unused.

### 7.4 Truthfulness — `facts.ts`

Every claim on the page traces to `facts.ts`. Rules enforced:
- Confirmed facts only as claims; planned features get an "In progress" / "Coming soon" chip.
- Sample numbers carry a visible **"Sample data"** label.
- No invented specifics, no "zero / 100% / never / guaranteed", no algorithm names, no certifications.

Two overclaims were caught and fixed during the build: a multi-tenancy line reworded to
*"Every query is scoped to the organization, so each tenant's documents, members and templates
stay isolated."*, and a CTA footnote claiming **"Multi-tenant row isolation"** (implying
Postgres RLS, which doesn't exist) changed to **"Isolated workspace per organization"**.

---

## 8. The bugs — root causes worth remembering

These are the non-obvious ones. Each cost real time.

### 8.1 Chrome does not resolve `var()` inside SVG presentation attributes
`fill="var(--lp-paper-fiber)"` silently falls back to **black**. Every torn divider rendered as
a black band. **Fix:** all SVG paint must go through the `style` prop
(`style={{ fill: 'var(--x)' }}`, `style={{ floodColor: 'var(--x)' }}`).

### 8.2 A text token used as a light colour
`HeroScene3D` had `<directionalLight color={tokens.foreground} />`. In light mode that's
`#0B1B33` — an almost-black light, rendering the hero subject as a dark block on a light page.
**This was the headline "dark section in light mode" bug.** Grepping the DOM for dark
backgrounds can never find it, because a canvas paints pixels, not elements. **Fix:** near-white
lights; theme colour belongs on materials.

### 8.3 `hsl(var(--token) / alpha)` with hex tokens
The app's tokens are hex (`#0B1B33`), not HSL channel triplets, so `hsl(var(--x) / 0.4)` is
**invalid and the whole declaration is dropped**. Found in 11 places — every aurora glow and
torn shadow was silently rendering nothing. **Fix:** `color-mix(in srgb, var(--x) 40%, transparent)`.

### 8.4 `overflow-wrap: anywhere` collapses flex children
Setting it on `.landing-scope` changed min-content width and broke words mid-syllable
("Archi tectu re RFC"). **Fix:** `break-word` globally, with an opt-in `.lp-break-all` class
for genuinely long strings.

### 8.5 `gsap.from()` leaves its end state implicit
`gsap.from(el, { scale: 0.86 })` that is interrupted strands the element at `scale: 0.86` —
which shrank orbit-card text to 11.18px and broke the 12px floor non-deterministically.
**Fix:** always `gsap.fromTo()` with an explicit end state + `clearProps`.

### 8.6 `MeshBasicMaterial` ignores alpha
Feeding it `tokens.border` (`rgba(15,23,42,0.08)`) normalised to near-black, producing black
bars across the paper stack. **Fix:** only pass solid colours to basic materials.

### 8.7 ResizeObserver feedback loops
Never measure a box whose size you also set. FitStage measures the **viewport** for available
height and the **content** for needed height — never its own scaled wrapper.

### 8.8 Dead code that looked alive
`useLayoutMode` existed but was imported by nobody, so three mechanisms decided layout
independently. At 1024×600 ScrollTrigger pinned a clipped wrapper while FitStage had already
decided not to pin. **Fix:** the singleton store in §3.2.

### 8.9 Verification harness false positives (if you build one)
- `transparent` reads as `rgba(0,0,0,0)` — add an alpha check before calling it dark.
- SVG text needs `getScreenCTM()`, not CSS transform parsing, to get its rendered size.
- Animation *start* states get measured if you don't wait — settle before asserting.
- Writing `localStorage` to set the theme triggered the Zustand `migrate()` which force-resets
  theme to light. Toggle the class instead, and apply it last.
- `networkidle` never settles against Vite's HMR websocket — use `domcontentloaded` +
  `waitForSelector`.

---

## 9. Section inventory

| # | Section | Signature technique |
|---|---|---|
| 1 | Navbar | glass + blur, hide-on-scroll-down, **measured** sliding pill indicator, morphing theme toggle, magnetic CTA |
| 2 | Hero | merged WebGL canvas, SplitText line-mask reveal, Instrument Serif accent word with self-drawing underline, magnetic CTA + conic border-beam, runtime-placed orbit cards |
| 3 | Marquee | 48s loop, pause on hover/focus-within, CSS `mask-image` edge fade |
| 4 | Problem | chaos→order scrubbed timeline, `placeInRect` scatter, pain cards *after* the pin |
| 5 | Journey | Draft → Submitted → Pending → Decision → Archived; Docky rides a self-drawing rail |
| 6 | Document types | Template Studio mock in a glass device frame |
| 7 | Roles | peer-to-peer routing vs fixed ladder comparison |
| 8 | Approvals | interactive Approve / Send back / Revoke demo, `data-cursor="stamp"` |
| 9 | Signatures | audit trail; planned features chipped |
| 10 | AI assistant | chat mock, policy-safe copy |
| 11 | Analytics | recharts, draw-on-entry, "Sample data" label |
| 12 | Multi-tenancy | organization isolation |
| 13 | Comparison | table |
| 14 | Trust | cards built from confirmed facts only |
| 15 | FAQ | grid-rows `1fr`/`0fr` accordion, rotating chevron |
| 16 | Final CTA | second WebGL scene, magnetic button |
| 17 | Footer | |

**Interaction kit used throughout:** magnetic buttons + gradient sheen sweep + press scale 0.97;
3D card tilt (max 8°, `perspective: 1000px`) with cursor-following spotlight, inner glare and
lift shadow; count-up chips; sliding tab indicators via GSAP Flip or measured transforms;
crossfade + small translate on content swap.

---

## 10. Accessibility & performance

- Semantic landmarks; **one `<h1>`**; all 13 sections carry `aria-labelledby` pointing at their
  own heading id.
- Both canvases sit inside `aria-hidden` wrappers; the hero has a `sr-only` text description of
  the scene.
- All 8 illustrations: `aria-hidden="true" focusable="false"`.
- Tabs, accordion and the approvals demo are fully keyboard-operable; the canvas never traps focus.
- AA contrast verified in both themes; `prefers-reduced-motion` honoured everywhere (simple fades).
- Route-level code splitting in `App.tsx` with a theme-coloured, shift-free `Suspense` fallback
  (no CLS). The 3D chunks split again inside the landing, so three.js is off the critical path.

---

## 11. Process that actually worked

1. **Phase 0 — report only.** Root-cause the existing bugs *to file and line*, produce a theme
   mapping table (Landing role | App token | Light | Dark), a design spec, and a list of any
   proposed resources with licences. **No code.** Stop for approval.
2. **Phase 1 — foundation.** Theme purity, layout store, FitStage, placeInRect, fluid tokens,
   TornDivider, CustomCursor. Nothing visual yet.
3. **Phase 2 — vertical slice.** Navbar + Hero + Marquee + Problem to *final* quality.
   Review here, before the quality bar gets copied 13 more times.
4. **Phase 3 / 4** — roll the approved treatment through the remaining sections + illustrations.
5. **Phase 5** — final CTA, a11y, performance, full matrix.

**Gate after every phase.** Screenshots at 1366×768 and 1920×1080 (plus 390×844 for mobile
phases) in **both themes** of everything touched. Fix what the screenshots show *before*
reporting. The vertical slice is the single highest-value rule here — it caught the toy-like
3D Docky and the dark-light bug before they could be duplicated.

---

## 12. Final verified state

```
combos: 14 (7 sizes × 2 themes) | total fails: 0 | console errors: 0
modes: 390x844=mobile  768x1024=tablet  1024x600=compact
       1280x720/1366x768/1440x900/1920x1080=wide
horizontal scroll: none | text under 12px: none | FitStage clipping: none
FitStage scales: 1.000 and 0.841 (both above the 0.75 floor)
theme purity: max 4 off-theme 16px blocks (fail threshold 40)
custom cursor layer: present at every size
```

- `oxlint src/pages/landing src/App.tsx` — clean except one pre-existing exhaustive-deps warning
  in `FlowWave.tsx:120`.
- `tsc` — **0 errors in `src/pages/landing/`**.
- `npm run build` still exits 2 because of **9 pre-existing app-side TS errors**
  (`WorkflowsPage` ×4, `analytics.ts` ×2, `syncProfile`, `AuthContext`, `WorkflowBuilderModal`),
  which were deliberately left out of scope. `vite build` therefore never runs, so no production
  bundle or Lighthouse number exists yet.

### Known open item
The hero orbit cards currently resolve to the **tidy-grid fallback** rather than a true scatter —
non-overlapping and neat, but not an "orbit". Fix is either 3 cards instead of 4, or a wider
scene column.

---

## 13. Reuse checklist

Dropping this system into another project:

- [ ] Point `lib/tokens.ts` at the new theme's variables; keep the canvas normalise trick.
- [ ] Re-derive all `--lp-*` colours with `color-mix()` from the host tokens — invent nothing.
- [ ] Keep the layout-mode store as the **single** source of pin decisions.
- [ ] Keep the 0.75 scale floor. It is what prevents tiny text.
- [ ] Keep `cursor: none` gated behind successful cursor mount.
- [ ] Keep lights near-white; put theme colour on materials.
- [ ] Use `gsap.fromTo` + `clearProps`, never `gsap.from`, for anything that affects layout or size.
- [ ] Style SVG paint via the `style` prop, never presentation attributes.
- [ ] Run the 7×2 matrix before calling any phase done.
