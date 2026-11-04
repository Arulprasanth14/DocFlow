# REDESIGN_CHECKLIST — v2 "Ice Pearl / Midnight Aurora"
> What shipped per phase + what to check manually. System: `DESIGN.md`. Plan/gap analysis: `archive/REDESIGN_V2_PLAN.md`.
> Build: `npx vite build` passes; `tsc -b` has only the 5 pre-existing-error files (listed at the end).
> Phase 9 (dead-code deletion) is **HELD** — do not delete; re-evaluate at the very end.

## Phase status
- [x] **A — Gap analysis + route audit** → `archive/REDESIGN_V2_PLAN.md`.
- [x] **B — Colour system v2** → `index.css` (`:root` Ice Pearl, `.dark` Midnight Aurora, gradients, shadows,
      glass vars, legacy aliases retargeted to `--card-solid` for crisp flat cards).
- [x] **C — Depth primitives** → `GlassCard` (variants + cursor spotlight), `IconChip`, `StatusBadge`,
      `Skeleton`, `SegmentedControl`, `Sparkline`, `EmptyState`, `.glass-card`/`.btn*`(gradient)/`.input`(44px)/
      `.hairline`/grain overlay.
- [x] **D — Typography** → Instrument Serif (display), Plus Jakarta Sans (headings), Inter (body),
      JetBrains Mono (numbers); `.font-display/.font-heading/.font-mono/.tabular/.label-caps`; CDN load.
- [x] **E — LivingBackground** → 4-layer light / aurora dark, blobs + motes + drift + parallax, visibility/
      reduced-motion/low-power gating. Mounted once in `AppLayout` + `AdminLayout`. `AuraBackground` = alias.
- [x] **F — App shell v2** → `AppLayout` (section labels, active pill + left glow, real Approvals/Messages
      badges, persisted collapse, ⌘K `CommandPalette`, theme morph) + `AdminLayout` (amber accent, glass,
      ADMIN badge, fixed invalid topbar bg).
- [x] **H — Motion core** → `lib/motion/tokens.ts` + `PageTransition` (enter, direction-aware, scroll/focus/
      aria-live) wrapping both shells' Outlets. Flip registered in `main.tsx`.
- [~] **G — Pages** (see per-page table below).
- [x] **I — Docs** → `DESIGN.md` v2, `archive/REDESIGN_V2_PLAN.md`, this checklist, `IMPLEMENTATION_STATUS.md`,
      `DEBUGGING_LESSONS.md`.

## Per-page status (Phase G)
**Full v2 treatment (PageHeader/GlassCard/EmptyState/new structure):**
- [x] Dashboard (T1) — hero greeting (serif + gradient name), KPI row (count-up + sparkline/ring + ghost
      lines), quick-action bento, Document Status donut, Documents Trend bar (segmented window), My Tasks,
      Workflow pipeline, Recent Documents table, Activity timeline. Real data only.
- [x] Login + Register (T8) — split layout, `AuthBrandPanel` + `LivingBackground(auth)`, glass form.
- [x] Profile (T3-ish) — PageHeader + gradient cover banner + glass sections.
- [x] Settings (T6) — PageHeader + glass left-tabs; local heavy blur removed (shell owns the aura).
- [x] Drafts (T2) — PageHeader + GlassCard/IconChip cards + EmptyState + skeleton loading.
- [x] Agent — violet AI accent (IconChip + "AI" badge).
- [x] Approvals (T2/T4) — full rebuild on v2: `PageHeader`, `GlassCard` table, shared `StatusBadge` + `IconChip`,
      `EmptyState`, loading skeleton/error-retry; **removed the fabricated stat cards** ("Awaiting Others: 14",
      "+44/+4", fake "+12%" trends); rows now open the real document. `approvals-theme.css` already collapsed to
      inherit global tokens. All approve/reject/delegate/signature/history logic preserved.

**Foundation-reskinned (inherit v2 tokens, type, LivingBackground, grain, gradient buttons, crisp opaque
cards, page transitions; deeper PageHeader/EmptyState/template pass still pending):**
- [ ] Documents list (T2), Document detail (T3), Document create (T6)
- [ ] Workflows list + builder (T2/T5), Search, Analytics, Messages/Chat, Onboarding (T8)
- [ ] Admin: AdminLogin (T8), AdminDashboard (T1), Members, Departments, Doc Types, Roles,
      Workflow Templates, Organization, Agent Knowledge (T7)

## Decisions made (brief Rule 9 — safest default, kept going)
1. **Fonts via Google Fonts CDN `@import`**, not `@fontsource` npm packages — zero new deps, matches the
   existing Inter load. Swap to fontsource later if offline bundling is needed (token names stay).
2. **GSAP Flip registered** in `main.tsx` (ships with gsap). The nav pill + segmented thumb use framer
   `layoutId` (equivalent glide, already robust) instead of Flip.
3. **LivingBackground supersedes AuraBackground**; `AuraBackground` kept as a thin alias so old imports work.
4. **PageTransition is enter-only** (+0.12s feel): React Router v7 swaps the Outlet synchronously, so a
   reliable cross-fade exit isn't available — this is the brief's own Phase H #4 fallback.
5. **Legacy `--bg-elevated`/`--bg-card` → `--card-solid` (opaque)**, `--glass-bg` → translucent `--card`.
   Prevents the ~1,400 existing flat inline cards from turning into washed-out see-through boxes; only
   `GlassCard`/`.glass-card` are translucent.
6. **`approvals-theme.css` collapsed** to inherit global tokens (it previously redefined the whole palette).
7. **Grain overlay** lives once at `body::after` (0.035 light / 0.06 dark), covering the whole UI.
8. **Phase 9 deletion HELD** per brief Rule 5 — the Aceternity effects are retained for v2 accents.
9. **Dashboard v3 — no time-range control / KPI deltas built.** The data (windowed aggregates, previous-period
   comparison) does not exist on `/analytics/dashboard`. Static date chip removed; control NOT faked. Needs-backend.
10. **Dashboard "can approve" = not a trainee** (approver is dynamic, not a role). Trainees see *Returned to you*.
11. **Dashboard counts via one hook** `useDashboardData`: status counts from `/analytics/report` `by_status`,
    KPIs from `/analytics/dashboard`. Step-level progress, inline return-reason, and member-count completion are
    needs-backend (shown only where the data really exists).

## Manual-check list (both light & dark; `npm run dev`)
- [ ] Theme toggle: whole app crossfades cleanly; morphing sun/moon; no washed-out/translucent flat cards.
- [ ] LivingBackground visible around/through cards (light aura; dark aurora); motes drift; cursor parallax
      on desktop; **reduced-motion** makes it fully static; low-power (≤4 cores / <768px) drops motes+parallax.
- [ ] Shell: active pill slides with left glow; Approvals/Messages badges show real counts; collapse persists;
      ⌘K opens the command palette; section labels present.
- [ ] Page transitions: content (not shell) animates; deeper = from right, back = from left; focus lands on
      the page title; no flash before paint.
- [ ] Dashboard: count-up on KPIs; sparkline/ring render; donut + trend chart legible both themes; empty
      states designed (no fake numbers); pipeline + tables + timeline.
- [ ] Auth: split layout at ≥920px, form-only below; brand panel + aura; RHF+Zod validation intact.
- [ ] Profile/Settings/Drafts/Agent: headers, glass sections, empty/skeleton states; Agent reads violet.
- [ ] Approvals: now matches the app theme (no black primary / pure-white cards); decide/approve/reject work.
- [ ] Foundation-reskinned pages: colors/type/background/buttons all themed; no dark-on-dark; actions work.
- [ ] `npx vite build` succeeds; `tsc -b` shows only the 5 pre-existing files.

## Dashboard v3 (content / IA fix) — manual checks
Spec: `archive/DASHBOARD_V3_PLAN.md`. Shared hook: `src/hooks/useDashboardData.ts`. Page: `src/pages/dashboard/DashboardPage.tsx`.
- [ ] **Per role** (trainee / worker / hr / admin): trainee sees *Returned to you* (not *Needs your action*);
      only admin sees New Workflow; admin+hr see Invite Team ("+" menu); KPI scope chip reads mine/team/workspace.
- [ ] **Fresh workspace** (no documents + no workflow activity): ONLY the Get-started checklist shows (ring n/3),
      nothing else; items become CTAs only where permitted; it disappears once a document exists.
- [ ] **Workspace with data:** Needs-your-action is the biggest card; inline **Approve/Reject** open the reason
      dialog and hit the real decision endpoint; signature-required stages toast + route to /approvals.
- [ ] **No duplication:** status counts appear ONLY in the pipeline; greeting has no counts; no KPI shows a status count.
- [ ] Pipeline reads as a flow with a **branch** (Rejected/Returned forked from review), chips link to
      `/documents?status=…`, "Pending/In review" label has no blue selection box.
- [ ] Trend: empty → "Trends appear once documents are processed" (no toggle); with data → gradient area chart.
- [ ] KPI: "Approval rate" shows `—` at 0 decided; numbers are sans-serif tabular (no serif "0"→"O"); cards clickable; no fake deltas/sparklines.
- [ ] Each widget has its own skeleton + "Couldn't load — Retry"; killing one request doesn't blank the page.
- [ ] Light AND dark finished; ≥1024px two-col rows, <1024px stacked, <640px pipeline vertical; reduced-motion static.

## Pre-existing build errors (NOT part of this redesign; left untouched per brief Rule 7)
- `src/lib/api/analytics.ts` (2 type errors) · `src/lib/auth/syncProfile.ts` (erasableSyntaxOnly)
- `src/pages/workflows/WorkflowsPage.tsx` (unused `navigate`; `WorkflowTemplateSummary` missing fields)
- `src/contexts/AuthContext.tsx` (unused `AuthUser`) · `src/components/workflows/WorkflowBuilderModal.tsx` (unused `User`)
