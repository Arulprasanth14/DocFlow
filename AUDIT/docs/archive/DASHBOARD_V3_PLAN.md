# DASHBOARD_V3_PLAN — content / IA / logic fix

> Dashboard rebuilt around **information ownership** (every fact appears exactly once, all counts from one
> shared hook `useDashboardData`). UI only; existing endpoints only; no fake numbers. Statuses/roles verified
> from code (`src/types/index.ts::DocumentStatus`, `PROJECT_CONTEXT.md`).

## Verified enums / roles
- **DocumentStatus** (real): `draft, submitted, pending, approved, rejected, sent_back, archived, expired, cancelled`.
  Pipeline uses: main track `Draft → Submitted → In review (pending) → Approved`; branch outcomes `Rejected`,
  `Returned (sent_back)`. There is **no** document `revoked` status (revocation is an approval-step concept).
- **Roles**: `admin, hr, worker, trainee` (+ `is_superadmin` bypass). "Approver" is not a role — trainees are
  stripped from approvers, so "can approve" ≈ **not a trainee**.
- **Permissions**: `workflows:admin` (admin only) → New Workflow; `members:invite_standard` (admin, hr) → Invite Team.

## A. Data availability matrix
| Widget / field | Existing source | Status |
|---|---|---|
| Greeting (time-of-day, name) | `user.name` + clock | ✓ |
| Needs your action (name, type, submitter, waiting-since, overdue, inline Approve/Reject/View) | `useMyApprovalQueue` → `ApprovalStep{document_title,document_id,submitter_name,created_at,due_at,stage_name}` + `useDecide` (approved/rejected + note); confirm/reason via `ConfirmDialog` | ✓ |
| My documents in progress (list) | `useDocuments({submitted_by:me})` filtered to `submitted/pending/sent_back` | ✓ (basic) |
| — step progress "2 of 4", current approver, time-in-stage | — | **NOT AVAILABLE** → needs backend: `steps_total/steps_done/current_approver_name/stage_entered_at` on the list item |
| Resume draft | `useDocuments({submitted_by:me, status:draft})` | ✓ |
| Returned to you / needs changes | `useDocuments({submitted_by:me})` filtered to `rejected/sent_back` | ✓ (reason text NOT in list payload → needs backend for inline reason) |
| KPI Approval rate | `stats.documents_approved / (approved+rejected)` | ✓ (`-` when denom 0) |
| KPI Avg turnaround | `stats.avg_approval_time_hours` | ✓ |
| KPI Overdue items | `report.approvals.overdue_now` | ✓ |
| KPI Documents processed | `stats.documents_approved + documents_rejected` | ✓ |
| KPI deltas vs previous period | — | **NOT AVAILABLE** → needs backend: previous-period figures on `/analytics/dashboard` |
| Bottleneck / slowest stage (manager) | `report.bottlenecks[0]` | ✓ (org/dept scope only) |
| Metric scope label (mine / team / workspace) | `report.scope` (`own`/`own_and_department`/`organization`) | ✓ |
| StatusPipeline counts (per status) | `report.breakdowns.by_status` (Bucket[]) | ✓ |
| Trend (volume over time) | `stats.trend_data` `[{date,count}]` | ✓ |
| Page-level time range (7d/30d/12m) driving KPIs/trend/activity | — | **NOT AVAILABLE** → needs backend: windowed aggregates + per-window series. Static date chip REMOVED; control NOT added (would imply filtering that doesn't happen). |
| Recent Activity | `useNotifications({limit})` | ✓ |
| Recent Documents | `useDocuments({sort:'-updated_at'})` | ✓ |
| Fresh-workspace detection | `recentDocs.total===0 && report.workflows.instances_started===0` | ✓ |
| Get-started: workflow step done | `report.workflows.instances_started>0` | ✓ |
| Get-started: invite-team done | `report`/member count — partial | ✓-ish (completion only verifiable for admins via org stats) |

## B. Role matrix (widgets per role)
| Widget | trainee | worker | hr | admin |
|---|:--:|:--:|:--:|:--:|
| Needs your action | — (sees *Returned to you*) | ✓ | ✓ | ✓ |
| My documents in progress + Resume draft | ✓ | ✓ | ✓ | ✓ |
| Returned to you | ✓ (primary) | ✓ (if not approver view) | ✓ | ✓ |
| KPI row (period metrics) | own scope | own scope | own_and_department | organization |
| Bottleneck KPI | — | — | ✓ | ✓ |
| StatusPipeline | ✓ (own scope) | ✓ | ✓ | ✓ |
| Trend / Activity / Recent Documents | ✓ | ✓ | ✓ | ✓ |
| Header: New Workflow (`workflows:admin`) | — | — | — | ✓ |
| Header: Invite Team (`members:invite_standard`) | — | — | ✓ | ✓ |

## C. Bugs fixed
1. Documents Trend blank (toggle, no chart/empty) → EmptyState when no data (toggle hidden), area chart when data.
2. "Completed 0%" misleading → renamed **Approval rate**, `-` when denominator 0, tooltip definition.
3. Pipeline wrong (Rejected inline after Approved) → **StatusPipeline** flow with a **branch** (Rejected/Returned forked from review).
4. Blue highlight on "Pending" → it was the browser text-selecting the selectable pipeline label. Fixed with
   `user-select:none` on pipeline chips + a themed `::selection` style. (Not a leaked class.)
5. Palm-tree/beach icon bottom-right → **not in the repo** (grep: only "route tree"/"Network") → it is a
   **browser extension** overlay. Ignored.
6. Ambiguous KPI scope → every KPI shows its scope (mine/team/workspace) from `report.scope`.
7. Per-card Week/Month/Year on trend + static date chip → date chip REMOVED; a real page-level window control is
   **needs-backend** (no windowed data/deltas), so not added rather than faked.
8. Low-contrast helper text + fake dotted sparklines in KPI cards → removed; body-small ≥12px, AA contrast.
9. KPI numbers in serif ("0"→"O") → Plus Jakarta Sans + tabular-nums; serif kept only on the greeting.
10. New Workflow / Invite Team shown to everyone → gated on `workflows:admin` / `members:invite_standard`.

## D. Final layout
Header → (fresh: Get-started checklist only) → Row A (Needs your action 2/3 + My documents in progress 1/3) →
Row B (KPI row, period metrics, clickable, no fake deltas) → Row C (StatusPipeline, full width, branch) →
Row D (Trend 2/3 + Recent Activity 1/3) → Row E (Recent Documents table). Per-widget skeleton + retry; one
failing query never blanks the page.

## Decisions made (this task)
- **No page-level time-range control / KPI deltas** built — the data (windowed aggregates, previous-period
  comparison) does not exist. Static date chip removed. Listed as needs-backend. (Rule 3 > brief item 7.)
- **"Can approve" = not a trainee** (approver is dynamic, not a role). Trainees get *Returned to you* instead of
  *Needs your action*.
- StatusPipeline counts come from `/analytics/report` `breakdowns.by_status` (the only real per-status snapshot);
  KPIs from `/analytics/dashboard`. Both via the single `useDashboardData` hook so numbers can't disagree.
- Inline approve may hit a signature-required stage (422) → surfaced as a toast directing to /approvals (the full
  signature UI lives there); dashboard does not reimplement signing.
- Step-level progress, inline return-reason text, and member-count completion are needs-backend; shown only where real.
