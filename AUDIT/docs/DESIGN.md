# DESIGN.md — DocFlow Design System v2 ("Ice Pearl / Midnight Aurora")

> The source of truth for the frontend's look, tokens, components, motion and page templates.
> Read this before any UI change. Colors come from **CSS variables / Tailwind theme tokens only** —
> never hardcode hex in components (the only exceptions: third-party brand logos e.g. Google/Microsoft
> sign-in icons, and color-picker example-value placeholders).
> Theme model: light = `:root`, dark = `.dark` class on `<html>` (toggled from `uiStore` in `App.tsx`).
> Tailwind v4: tokens are bridged to utilities via `@theme inline` in `src/index.css`.

---

## 1. Principles
- **Depth, not flatness.** Surfaces are glass that float over a living background with layered shadows and a top sheen.
- **One system.** Every page uses the shared primitives and templates so the app feels designed as a whole.
- **Real data only.** Empty states are designed but never fabricate numbers, deltas or series.
- **Calm motion.** Transform/opacity only; fast; always honors `prefers-reduced-motion`.
- **Token-driven.** One token edit re-themes the app (legacy token names are aliased to v2 tokens).

## 2. Color tokens
Defined in `src/index.css`. Light under `:root`, dark under `.dark`. Key families:

| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | `#FAF8F2` | `#070B14` | body ground (LivingBackground has **no** bg-color) |
| `--foreground` | `#0B1B33` | `#E6EDF7` | primary text |
| `--card` | `rgba(255,255,255,.58)` | `rgba(18,27,46,.62)` | **glass** surfaces (used with backdrop-blur) |
| `--card-solid` | `#FFFFFF` | `#0E1626` | opaque cards (tables/forms) + legacy flat cards |
| `--popover` | `#FFFFFF` | `#0E1626` | menus/dropdowns/dialogs |
| `--primary` / `--primary-hover` | `#0369A1` / `#075985` | `#38BDF8` / `#7DD3FC` | main CTAs, active nav, links |
| `--primary-foreground` | `#FFFFFF` | `#06111F` | text on primary (use this, never `#fff`, for dark-mode contrast) |
| `--secondary` / `-foreground` | `#E8F4FD` / `#075985` | tinted / `#BAE6FD` | soft chips |
| `--muted` / `--muted-foreground` | `#F1F5F9` / `#5B6B82` | `#121B2E` / `#94A3B8` | subtle surfaces / secondary text |
| `--accent-violet` (+`-soft`) | `#7C3AED` | `#A78BFA` | **AI / Agent features only** |
| `--accent-amber` (+`-soft`) | `#F59E0B` | `#FBBF24` | **admin portal accent only** |
| `--destructive` (+`-soft`) | `#DC2626` | `#F87171` | destructive actions / rejected |
| `--success` / `--warning` | `#16A34A` / `#D97706` | `#4ADE80` / `#FBBF24` | approved / pending semantics |
| `--border` / `--border-strong` | `rgba(15,23,42,.08)` / `#CBD5E1` | `rgba(148,163,184,.14)` / `rgba(148,163,184,.28)` | hairlines / stronger edges |
| `--input` / `--input-border` | `#FFFFFF` / `#D5DEE9` | `rgba(15,23,42,.6)` / `rgba(148,163,184,.22)` | fields |
| `--ring` | `#06B6D4` | `#22D3EE` | focus ring |
| `--chart-1..5` | `#0369A1 #06B6D4 #6366F1 #F59E0B #10B981` | `#38BDF8 #22D3EE #818CF8 #FBBF24 #34D399` | charts (never raw hex in chart code) |
| `--sidebar*` | translucent white glass | translucent ink glass | sidebar/topbar surfaces |
| `--status-*` (+`-bg`) | see file | see file | status pills: text + soft-bg pairs for draft/pending/review/approved/rejected/revoked |

**Gradients / depth:** `--gradient-brand`, `--gradient-primary-btn`, `--gradient-text`, `--sheen`;
**shadows:** `--shadow-xs/sm/md/lg/glow`; **glass:** `--glass-blur`, `--glass-saturate`, `--glass-border`, `--glass-inner`.
**Radius:** `--radius` .875rem, `--radius-lg` 1.25rem, `--radius-pill` 999px (+ derived `-sm/-md/-xl`).

**Color rules:** primary only for main CTAs / active nav / links. Violet only for AI/Agent. Amber is the
admin accent. Red/green only for status + destructive. All text meets WCAG AA (4.5:1) in both themes.

**Legacy alias layer:** old names (`--bg-*`, `--text-*`, `--color-primary-*`, `--border-*`, `--color-success/warning/error-*`)
are aliased to v2 tokens so ~1,400 existing inline styles re-theme automatically. `--bg-elevated`/`--bg-card`
map to **`--card-solid`** (opaque) so flat cards stay crisp; `--glass-bg` maps to translucent `--card`.

## 3. Surface language (primitives — `src/components/ui/`)
- **GlassCard** — the core surface. `variant`: `default` | `interactive` (hover lift + brighter border) |
  `elevated` (shadow-lg) | `solid` (opaque `--card-solid` for tables/forms). `spotlight` adds a cursor-follow
  radial glow (desktop only). Built on `.glass-card` (blur+saturate, glass border, `::before` top sheen,
  shadow-md + inner highlight).
- **IconChip** — rounded tinted tile + lucide icon. `tone`: primary/cyan/violet/amber/success/danger/muted.
- **StatusBadge** — soft-bg + readable-text pill with a leading dot (pulsing for pending/review).
- **SegmentedControl** — pill group with a sliding thumb (framer `layoutId`).
- **Sparkline** — tiny gradient area chart (recharts) for KPIs.
- **Skeleton / SkeletonText** — shimmer placeholders (transform-based) — use instead of spinners for page loading.
- **EmptyState** — inline-SVG illustration (currentColor + tokens) + headline + sentence + CTA, soft float.
- **PageHeader** — breadcrumb + title (display serif for top-level pages) + description + actions + optional tabs.
- **Section** — titled content block (marks `data-section` for the page transition).
- **CommandPalette** — glass ⌘K palette (cmdk) with grouped navigation + "Search documents for …".
- **AuthBrandPanel** — the left panel for auth/onboarding (T8).
- **LivingBackground** — see §5. `AuraBackground` is kept as a thin alias of it.

Global CSS utilities: `.glass-card`, `.glass-solid`, `.glass-interactive`, `.btn/.btn-primary(gradient)/
.btn-secondary(glass)/.btn-ghost/.btn-danger`, `.input` (44px, focus glow), `.status-badge` + `.status-*`,
`.hairline` (gradient divider), `.skeleton`, `.gradient-text`, `.font-display/.font-heading/.font-mono/.tabular/.label-caps`.
A grain overlay (inline-SVG noise) sits once at `body::after` (0.035 light / 0.06 dark).

## 4. Typography
- **Display** (hero titles, big numbers): **Instrument Serif** (`--font-display`, `.font-display`).
- **Headings / UI**: **Plus Jakarta Sans** (`--font-heading`; applied to h1–h6 and chrome).
- **Body**: **Inter** (`--font-sans`, body default).
- **Code / IDs / table numbers**: **JetBrains Mono** (`--font-mono`, `.font-mono`).
- Scale: hero `clamp(1.75rem→2.4rem)`, h2 ~1.06rem, body .875rem, label .6875rem uppercase +0.06em.
- `.tabular` (tabular-nums) on every metric and table number. Headings letter-spacing −0.01em.
- `--gradient-text` on **at most one** word/phrase per page (e.g. the name in the dashboard greeting).
- Fonts load via Google Fonts CDN `@import` in `index.css` (no npm dep — see REDESIGN_V2_PLAN "Decisions made").

## 5. LivingBackground (one fixed layer, mounted once at each shell)
`position:fixed; inset:0; z-index:-1; pointer-events:none; aria-hidden`; **no background-color**.
- **Light "Ice Sheet":** 4-layer aura stack (gradient + multiply tint bands + white highlights) + 3 soft
  blobs (sky/cyan/indigo).
- **Dark "Midnight Aurora":** 3 screen-blend blobs (sky/indigo/teal) + faint vignette.
- Motion (transform/opacity only): blob drift (±40–80px, scale→1.12, 22–40s sine yoyo, phase-offset);
  floating motes (desktop); cursor parallax (`gsap.quickTo`, ≤12px, desktop).
- **Safety:** pauses on `document.hidden`; `prefers-reduced-motion` = static; low-power (`hardwareConcurrency ≤ 4`
  or width < 768) = 2 blobs, no motes, no parallax. `variant="auth"` = stronger wash for auth/onboarding.
Never place dense data directly on the background — always on a GlassCard/solid surface.

## 6. App shell
- **Employee** (`AppLayout`): 264px glass sidebar (collapsible→76px, persisted), gradient logo tile,
  `WORKSPACE`/`ADMINISTRATION` section labels, active pill (framer `layoutId`) with left glow + count
  badges (Approvals = real queue, Messages = real unread), bottom workspace card. Glass topbar: ⌘K search →
  CommandPalette, theme morph toggle, notifications, user menu. LivingBackground + PageTransition mounted here.
- **Admin** (`AdminLayout`): same system with the **amber accent** + an "ADMIN PORTAL" badge, Shield branding,
  glass sidebar/topbar, LivingBackground + PageTransition. "Employee View" switch link.

## 7. Motion (`src/lib/motion/`)
Tokens (`tokens.ts`): `EASE.standard/emphasized/inOut` (power2/3), `EASE_BEZIER` (0.22,1,0.36,1) for framer,
`DUR.micro .18 / base .35 / page .45 / max .7`, `fmTransition`, `fmReduced`.
Hooks: `usePageTransition`, `useStaggerIn`, `useCountUp`, `useAuraDrift`, `prefersReducedMotion`.
**PageTransition** (`components/layout/PageTransition.tsx`): enter animation on the routed content only
(sidebar/topbar/LivingBackground never re-animate). PageHeader reveals first, then `[data-section]` blocks
stagger (y16→0, scale .985→1). Direction-aware (deeper = from right, back = from left, sibling = vertical).
Enter-only (RR7 swaps the Outlet synchronously — see REDESIGN_V2_PLAN "Decisions made"); scroll resets to
top; focus moves to the page `h1`; route announced via `aria-live`. Reduced-motion = 0.15s opacity fade.
GSAP Flip is registered in `main.tsx` (ships with gsap). Nav pill / segmented thumb use framer `layoutId`
(equivalent glide, already robust) rather than Flip.

## 8. Page templates (T1–T8)
- **T1 Overview/Dashboard** — hero + quick-action bento + KPI row + charts/pipeline + activity. (DashboardPage, AdminDashboard, Analytics)
- **T2 List/Index** — PageHeader + toolbar + glass/solid data table or card grid + designed empty/skeleton. (Documents, Workflows, Drafts, admin CRUD)
- **T3 Detail** — PageHeader w/ status + tabs + main column + sticky right rail. (DocumentDetail)
- **T4 Inbox/Split** — list + detail pane + sticky action bar. (Approvals)
- **T5 Builder/Canvas** — toolbar + dot-grid canvas + inspector. (Workflow builder modal)
- **T6 Settings/Form** — left vertical tabs + grouped glass sections + sticky save bar. (Settings, DocumentCreate, OrgSettings)
- **T7 Admin CRUD** — T2 + amber accent + role/permission chips + confirm dialogs. (admin pages)
- **T8 Auth/Onboarding** — split: left `AuthBrandPanel` (serif headline + IconChip features + static preview card)
  over LivingBackground(auth) + right GlassCard form. (Login, Register, Onboarding, AdminLogin)

## 9. Accessibility
WCAG AA contrast in both themes; visible focus rings (`--ring`, 2px offset); reduced-motion respected
everywhere (backstop in CSS kills decorative loops); route changes move focus to the page heading and
announce via `aria-live`; decorative layers are `aria-hidden`.

## 10. Do / Don't
- **Do** build pages from PageHeader + Section + GlassCard + the shared primitives; use `--chart-*` for charts;
  use StatusBadge for any status; use EmptyState for every empty list/card/chart; use `.tabular` on numbers.
- **Don't** hardcode hex (except brand logos / color-picker placeholders); don't animate blur/filter/layout;
  don't put data on the bare background; don't invent numbers; don't use violet outside AI or amber outside admin.

## 11. How to use this when asked to change the design
1. Change **tokens** in `index.css` (`:root` + `.dark`) — the app re-themes via the `@theme` bridge + legacy aliases.
2. Build new UI from the **primitives**; follow the matching **template** (§8).
3. New motion → a hook in `src/lib/motion` with the shared **tokens**; always guard `prefersReducedMotion`.
4. Keep both themes complete and AA; verify with the manual checklist in `REDESIGN_CHECKLIST.md`.

## 13. Dashboard pattern (information ownership) — keep this when changing the dashboard
The dashboard follows a strict **information-ownership** rule: every fact appears **exactly once**, and all
counts come from the **single shared hook `useDashboardData`** so two widgets can never show different numbers.
Ownership map (change the one owner, never add a second copy):

| Information | The only widget that shows it |
|---|---|
| Per-status document counts (draft/submitted/pending/approved/rejected/sent_back) | **StatusPipeline** (snapshot, with a branch for rejected/returned) |
| Items waiting for *me* | **Needs your action** (the sidebar Approvals badge is allowed — it's navigation) |
| Progress of docs *I* submitted | **My documents in progress** |
| Period performance (rates, times, overdue, volume) | **KPI row** (no status counts here) |
| Volume over time | **Trend chart** |
| Latest documents / latest events | **Recent Documents** / **Activity** |
| Primary create actions | **Page header** only (role extras in a "+" menu) |

Rules: the greeting carries **no counts**; KPI numbers use Plus Jakarta + `.tabular` (serif only on the
greeting); every widget owns its skeleton + a "Couldn't load — Retry" state so one failed query can't blank
the page; fresh workspace (no docs + no workflow activity) shows **only** a Get-started checklist; never
fabricate numbers — missing data is a designed empty state or listed as needs-backend. Full spec + data
matrix: `archive/DASHBOARD_V3_PLAN.md`.

## 12. Kept Aceternity effects (future accents)
The Aceternity components under `src/components/ui/` (aurora-background, glowing-effect, card-spotlight,
tracing-beam, bento-grid, timeline, spotlight, canvas-reveal-effect, moving-border, etc.) are kept for
future hero/marketing accents. v2 uses its own GlassCard spotlight + LivingBackground for day-to-day depth.
