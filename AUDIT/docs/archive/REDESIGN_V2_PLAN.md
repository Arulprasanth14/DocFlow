# REDESIGN_V2_PLAN — "Ice Pearl / Midnight Aurora" visual redesign v2

> v1 ("Ice") re-skinned tokens only and came out flat. v2 adds real depth, a living background,
> a richer surface language, new typography, a motion/page-transition system, and page templates.
> System of record once shipped: `DESIGN.md` (v2). Status tracker: `REDESIGN_CHECKLIST.md`.
> Reference images (primary source of truth): the light "SaaS Dashboard" + dark "Dark Mode Dashboard".

---

## PHASE A — Gap analysis (reference images vs current app)

What the reference images have that the current build lacks:

| Area | Reference images | Current app (v1) | Gap to close |
|---|---|---|---|
| **Depth / surface** | Soft layered shadows, white glass cards floating over a tinted ground, inner highlight sheen | Near-opaque flat cards, single flat shadow | GlassCard primitive: blur + saturate, glass border, top sheen, layered shadow, hover lift |
| **Background** | Visible aura wash (cream→sky gradient, soft blobs) around/through cards; dark = deep navy aurora | `AuraBackground` only behind dashboard header, 2 faint blobs | `LivingBackground`: 4-layer aura + 3 blobs + motes + drift + parallax, mounted once at shell |
| **Stat cards** | Icon chip (tinted rounded tile), big tabular number, delta chip (↑+12%), mini sparkline | Generic bordered boxes, plain number, no sparkline/delta | KPI card with IconChip + count-up + delta + sparkline |
| **Charts** | Donut "Document Status" + legend w/ counts & %, stacked bar "Documents Trend", gradient fills | Single tiny area strip | recharts donut + stacked bar + gradient area, `--chart-*` tokens, segmented controls |
| **Typography** | Big friendly greeting, strong hierarchy, tabular numbers | Flat 28px Inter heading, `👋` emoji, no display face | Instrument Serif display, Plus Jakarta headings, JetBrains mono numbers, type scale |
| **Sidebar** | Gradient logo tile, count badges (My Tasks 7, Notifications 3), active pill, workspace card at bottom | Logo tile + active pill + workspace card (ok base), flat | Section labels, sliding pill (Flip), left glow, collapse w/ tooltips, hover micro-motion |
| **Topbar** | Wide search w/ ⌘K chip, bell w/ live dot, avatar+name+role chevron | Present but flat | Glass, breadcrumb, theme morph toggle, command-palette dropdown, shimmer sweep |
| **Greeting / hero** | "Good morning/evening, Arul!" time-aware, date pill, Upload CTA | "Welcome back 👋", New Document btn | Time-of-day serif greeting, gradient-text name, live summary, date pill, glow CTA |
| **Empty states** | (n/a — images are full) | Bare centered text | `EmptyState` with inline-SVG illustration, headline, CTA, soft float |
| **Tables** | Sticky header, row hover, type/status pills, avatars, sortable headers, row actions (•••) | Mixed; some flat | Shared `DataTable` styling: sticky header, hover glow, status pills, mono IDs |
| **Motion** | (static images) | framer-motion modals + a few GSAP hooks | Motion tokens, PageTransition (direction-aware), Flip pills/tabs, count-up, pulse |
| **Micro-detail** | Hairline dividers, grain, consistent radii, soft focus rings | Flat grey dividers, no grain | Gradient hairline dividers, SVG grain overlay, elevation scale, themed scrollbars |

Full gap list lives here; execution closes it phase by phase (B→C→D→E→F→H→G→I).

---

## Route / page audit (verified from `src/App.tsx`)

| Route | File | Template |
|---|---|---|
| `/dashboard` | `pages/dashboard/DashboardPage.tsx` | **T1** Overview |
| `/documents` | `pages/documents/DocumentListPage.tsx` | **T2** List |
| `/documents/new` | `pages/documents/DocumentCreatePage.tsx` | **T6** Form |
| `/documents/:id` | `pages/documents/DocumentDetailPage.tsx` | **T3** Detail |
| `/approvals/*` | `pages/approvals/ApprovalsPage.tsx` | **T4** Inbox/Split |
| `/workflows/*` | `pages/workflows/WorkflowsPage.tsx` | **T2** cards + **T5** builder modal |
| `/search` | `pages/search/SearchPage.tsx` | Command-style (T2 variant) |
| `/analytics/*` | `pages/analytics/AnalyticsPage.tsx` | **T1** analytics (KPI + charts) |
| `/chat` | `pages/chat/ChatPage.tsx` | Two-pane messages |
| `/drafts` | `pages/drafts/DraftsPage.tsx` | **T2** draft cards |
| `/agent` | `pages/agent/AgentPage.tsx` | Violet AI hero + chat |
| `/settings` | `pages/settings/SettingsPage.tsx` | **T6** Settings |
| `/profile` | `pages/auth/ProfilePage.tsx` | Cover + tabs |
| `/onboarding` | `pages/onboarding/OnboardingPage.tsx` | **T8** stepper |
| `/login` | `pages/auth/LoginPage.tsx` | **T8** Auth split |
| `/register` | `pages/auth/RegisterPage.tsx` | **T8** Auth split |
| `/admin/login` | `pages/admin/AdminLoginPage.tsx` | **T8** admin (amber) |
| `/admin/dashboard` | `pages/admin/AdminDashboardPage.tsx` | **T1** admin |
| `/admin/organization` | `pages/admin/OrganizationSettingsPage.tsx` | **T6/T7** |
| `/admin/departments` | `pages/admin/DepartmentsPage.tsx` | **T7** CRUD |
| `/admin/roles` | `pages/admin/RolesPage.tsx` | **T7** permission matrix |
| `/admin/members` | `pages/admin/MembersPage.tsx` | **T7** CRUD |
| `/admin/document-types` | `pages/admin/DocumentTypesAdminPage.tsx` | **T7** CRUD |
| `/admin/workflow-templates` | `pages/admin/WorkflowTemplatesAdminPage.tsx` | **T7** CRUD |
| `/admin/agent-knowledge` | `pages/admin/AgentKnowledgePage.tsx` | **T7/T2** |

Shells: `components/layout/AppLayout.tsx` (employee), `components/layout/AdminLayout.tsx` (admin, amber accent).

---

## Execution order (no stopping between phases)
**B** tokens → **C** primitives → **D** typography → **E** background → **F** shell →
**H** motion core + PageTransition → **G** pages (Dashboard first) → **I** docs.

Phase 9 (dead-code deletion) is **held** — re-evaluate only at the very end and show the list first.

## Decisions made
_(running log — brief Rule 9: pick the safest default and continue)_

1. **Fonts via Google Fonts CDN `@import`, not `@fontsource` npm packages.** The brief pre-approved the
   fontsource packages, but the project already loads Inter via a Google Fonts `@import` in `index.css`.
   Loading Instrument Serif + Plus Jakarta Sans + Inter + JetBrains Mono the same way adds **zero new
   dependencies** (brief Rule 8 "safest option with no new dependency") and matches the existing pattern.
   If offline-bundled fonts are later required, swap to the fontsource packages — the token names stay.
2. **GSAP Flip** is registered from the `gsap` package (ships with it) — no new dependency.
3. **`LivingBackground` supersedes `AuraBackground`.** `AuraBackground` is kept as a thin re-export/alias
   so existing imports (Dashboard) don't break during migration, then pages move to `LivingBackground`.
4. _(further decisions appended as they arise during C–I)_
