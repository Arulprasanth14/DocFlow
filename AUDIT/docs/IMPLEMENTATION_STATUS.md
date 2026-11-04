# IMPLEMENTATION_STATUS — what exists, what's missing
> Purpose: per-module status based on code inspection (routes exist, UI wired, tests exist). Not a runtime verification.
> Read: when asked "what's done / what's next", before starting a feature, and update after every change.

**2026-11-06 — Workflow Module Phase 1: backend complete, frontend UI outstanding.**

*Versioning (P1-3, DM-01..04) — this is what resolves defect 2.* Saving a changed stage list now
writes a new immutable `workflow_template_versions` row with its `workflow_version_stages`, points
`workflow_templates.current_version_id` at it, and leaves every earlier version untouched. An
**identical** list is recognised as a no-op, because the builder re-sends `stages` on every save
and a typo fix must not mint a version. The legacy `workflow_stages` rows are kept in step so the
existing engine executes what the owner just saved; rows still referenced by an `approval_step` or
by `workflow_instances.current_stage_id` are soft-deleted rather than removed, so no approval loses
the definition it was recorded against. `GET /workflow-templates/{id}/versions` returns the
history, owner-only.

*Stage validation on the server (P1-4).* `_build_version_stages()` enforces the stage cap of 10
(WF-STG-03), stage names 2–80 unique case-insensitively, exactly one approver per stage (BR-03 —
parallel is out of scope per §2.1), the approver–department match (WF-STG-22), the due-within range
of 1 hour to 30 days with the value/unit the user chose preserved alongside the computed hours
(§5.5 field D), and the **Finance signing rule**: `require_signing` is FORCED by the server from
the department flag, so a tampered `requireSigning: false` cannot get through (WF-STG-20, E22).
Workflow names are 3–100 characters and unique per owner (§5.3).

*Signing-department inheritance (decision Q6).* `_department_requires_signature()` walks
`Department.parent_id` upward with a depth cap, so a sub-department of Finance cannot accept an
unsigned approval. Identification is by the boolean or the id — never a name match, which WF-STG-20
forbids.

*Sharing (P1-5, WF-OWN-02..11).* `workflow_shares` plus `WorkflowShareRepository` and five
endpoints: list / grant / revoke, and archive / restore. Granting is idempotent (WF-OWN-07) and
the response says `created` so the caller can tell "granted now" from "already had it"; the
partial unique index `uq_workflow_share_active` makes that a database guarantee rather than a
check-then-insert race. Revoking sets `revoked_at` and never deletes, so a revoked row keeps the
audit trail and does not block a later re-share. Sharing with yourself, a non-member or an
inactive user is 422; a workflow you do not own is 403; one private to someone else is **404, not
403**, so a refusal never confirms it exists. Audit events `workflow.shared` /
`workflow.share_revoked` / `workflow.deleted` are written in the same transaction as the change
(BR-10).
**Not yet done in Phase 1:** the chat message and the N14 notification that should accompany a
share. The grant itself is complete and authoritative — WF-OWN-02 is explicit that "sending a chat
message alone grants nothing" — so the announcement is additive and lands with the notification
work. `chat_message_sent` is returned as `false` today rather than implied.

*Read access is share-aware.* `_assert_can_read()` admits the owner, an org admin, any member of an
organization-visible workflow, and a **live grantee** (WF-OWN-05 gives a grantee the right to view
the full configuration). Everyone else gets 404. The owner-only checks run after it, so a grantee
who tries to edit, re-share or delete gets 403 — correct, because they can plainly already read it,
and answering 404 there would deny something visible to them.

*Lifecycle (P1-6).* Archive/restore is distinct from the older enable/disable and moves both
`status` and `is_active` together, so existing pickers honour it unchanged. **Delete is now guarded**
(WF-LC-04): it refuses with 409 while any non-terminal run exists, naming the count and pointing at
archive, and it revokes the workflow's shares on the way out.

*Lists (WF-LIST-01).* `GET /workflow-templates?scope=mine|shared|all` backs the two tabs, and a
private-but-shared workflow is now visible to its grantee — without that clause a share would grant
nothing.

*Tests.* 14 new across `test_workflow_shares.py` (11) and `test_workflow_ownership.py` (3):
versioning keeps v1 immutable, an identical list mints nothing, history is owner-only, share makes
a private workflow usable, sharing is idempotent, self/non-member/non-owner/unknown are rejected,
a grantee cannot re-share or edit or delete or see the panel, revoke is immediate and idempotent,
re-share after revoke works, archive/restore round-trips, and deleting revokes shares.
**Full suite: 186 passed** (172 baseline + 14). `ruff` clean on every touched file.

*Two notes for the owner.* The test suite revealed that `_is_org_admin` counts **`hr` as well as
`admin`**, so an HR user can already read any private workflow's full definition — the O-10
deviation recorded in `AUDIT/DECISIONS.md`. It is pre-existing and was left alone; the share tests
use a plain Worker as grantee so they test the real grantee path. Separately, `npm run build`
currently fails on one error that is not from this work: `src/components/ui/Skeleton.tsx` was
renamed to `skeleton.tsx` during the session by something outside these edits, while all four
importers still say `Skeleton`, giving TS1261. `npx tsc -b` reports that as the **only** error, so
the Phase 1 frontend additions typecheck; the canonical casing should be restored from git rather
than guessed at here.

*Outstanding in Phase 1:* the frontend UI — full-page builder with real drag reorder and the
preview step (P1-8/P1-9), the My/Shared tabs on `/workflows` (P1-10), and the share dialog (P1-11).
The API client for all of it is in place (`workflowSharingApi`).

**2026-11-06 — Workflow Module: P0-4 regression baseline, defect 2, Phase 1 migration.**
Plan: [`docs/DocFlow_Workflow_Implementation_Plan.md`](../../docs/DocFlow_Workflow_Implementation_Plan.md).
Decisions: [`AUDIT/DECISIONS.md`](../DECISIONS.md).

*Baseline (P0-4), recorded before any change:* `pytest` **172/172 passed** across 12 modules
(7m46s, local disposable Postgres) — account_flows 31, agent_rag 25, ai_provider_abstraction 23,
email_pipeline 22, workflow_ownership 16, firebase_login_resilience 14,
signatures_and_revocation 12, hr_permissions 10, chat_org_isolation 6, admin_access 6,
approval_authorization 5, org_creation_email 2. `ruff check app/` had **75 pre-existing errors**
(DoD only requires touched files clean). `npm run lint` passed (warnings only).
**`npm run build` was already BROKEN** — 10 pre-existing TS errors, so the previous claim that it
was green did not hold.

*Fixed — frontend build is green again.* `WorkflowTemplateSummary` in `lib/api/workflows.ts` was
missing `description`, `doc_type_id`, `created_by` and `visibility`, which the API does return and
`WorkflowsPage` does read (3 errors); unused `useNavigate`/`navigate`, lucide `User`, and
`AuthUser` imports (4); `PeriodParams` needed an index signature to be passed as axios params (2);
and `syncProfile.ts` used a TS parameter property, which `erasableSyntaxOnly` forbids — now the
native `Error(message, { cause })` (1). `tsc -b` + `vite build` pass.

*Fixed — defect 2: the builder silently discarded stage edits.* `WorkflowTemplateUpdate` had no
`stages` field, so Pydantic dropped the stage list the builder sends on every save; the server
wrote none of it and returned 200, while the UI said a new version had been created. `stages` is
now declared, an **identical** list is accepted as a no-op (so renaming still works), and a
**changed** list returns **422** with an actionable message. It cannot yet be saved: `approval_steps.stage_id`
and `workflow_instances.current_stage_id` both reference `workflow_stages.id` with **no ON DELETE**,
so rewriting stages in place would either violate those FKs or orphan the audit trail of approvals
already recorded against them. Versioning (P1-3) is what lifts the 422. Two regression tests added
to `test_workflow_ownership.py`.

*Fixed — the test suite was not repeatable (new defect 14).* `conftest._setup_schema` called
`Base.metadata.drop_all`, which cannot sort `documents` / `file_assets` / `template_versions`
(mutually dependent FKs declared with `use_alter`) and raised `CircularDependencyError` the moment
the database was not empty — so the suite ran exactly once per fresh database and every later run
errored at setup. It now drops and recreates the `public` schema instead.

*Phase 1 migration `b7c8d9e0f1a2` — written and verified, NOT applied to the configured database.*
Adds `workflow_template_versions`, `workflow_version_stages`, `workflow_shares`, plus
`users.manager_id`, `departments.requires_signature`, and `workflow_templates.status` /
`.require_full_reapproval` / `.current_version_id`. **Additive only**: 4 ADD COLUMN (all nullable
or NOT NULL with a server_default), 3 CREATE TABLE, 6 CREATE INDEX, 2 FK constraints — no DROP,
RENAME or DELETE. `alembic heads` is the single head `b7c8d9e0f1a2`. Verified on a scratch database
by applying the whole history from empty, then downgrade → re-upgrade with legacy rows present: the
backfill mapped `manager_of_requester` → `submitter_manager` (48 h shown as "2 days") and
`specific_user` (5 h, signing preserved), and left a `role_in_department` template on the legacy
path with `current_version_id` NULL rather than coercing it.
**`DATABASE_URL` points at a remote database, so nothing was applied there — that run is the
owner's call.** The §8 Finance seed (`departments.requires_signature = true`) is deliberately NOT
in the migration: it changes existing data and makes more stages demand a signature, so it is
listed as an explicit admin action instead.

*After these changes:* `pytest` **174 passed** (172 baseline + 2 new), `ruff` clean on every
touched file, `npm run build` and `npm run lint` pass.

**Last updated:** 2026-11-02 (**Documents Module — thirteen partial lines completed**). All 112 FR lines of the v2 specification are traced in [`DOCUMENTS_MODULE_HANDOVER.md`](DOCUMENTS_MODULE_HANDOVER.md), with the acceptance-criteria walkthrough, deployment checklist, the “PDF stuck on Preparing” runbook and the deferred list.
**Honest completion: 101/112 fully done (90%), 5 partial, 1 not verifiable here, 5 deferred.** By priority: Must 85/91, Should 16/17, Could 0/4.
Completed 2026-11-01: **FR-1.4** row virtualisation, **FR-1.5** full-text search (migration `e3f4a5b6c7d8` — **written, NOT yet applied**), **FR-1.7** OpenAPI codegen (`npm run gen:api`), **FR-2.4** the dashed “+” card, **FR-3.2** resumable upload, **FR-6.6** authored headers/footers, **FR-9.6** streamed import progress (SSE), **FR-9.7** compare-with-original.
Completed 2026-11-02: **FR-10.1** floating AI selection menu + ghost text (`POST /ai/complete`, opt-in, off by default), **FR-10.7** **PII redaction** (`services/pii_redactor.py`, all seven prompt sites; length-preserving mask for the blank detector so FR-9.4's offset proof still holds), **FR-12.1** the draft is created by the first answer rather than by opening a template (`GET /templates/{id}/fill-schema`), **FR-13.2** searchable workflow combobox. **FR-15.4** gained a repeatable automated a11y audit (jsx-a11y in `.oxlintrc.json`) with all fourteen real findings fixed.
Still partial and why: **FR-9.1** (`.doc` and OCR need an unapproved dependency), **FR-9.9** (bucket default-encryption flag is a deployment action), **FR-10.7** (names and postal addresses need NER), **FR-15.4** (screen-reader pass needs a human), **FR-15.5** (LCP/INP need a deployed build). Separately, **FR-1.6** is not partial but not verifiable here.
Also fixed earlier: a `declare module '@tiptap/core'` augmentation in `BlockFormat.ts` that could not resolve, which was failing `tsc -b` — and therefore `npm run build` — on eight errors.

**2026-11-04 — review-and-fix pass.** Fixed, each verified first: a `NameError`
in `template_repo._visibility_clause` (an unqualified, untyped `column("dept_id")`
→ `_template_dept_col()`, qualified and UUID-typed, checked with the ORM column
absent *and* present and inside a join against `documents`); two PII regex false
positives ("The Road Map Review Committee" → ADDRESS, "between Delhi and Mumbai"
→ NAME); the streaming rewrite endpoint (GET with document text in the query
string → POST; audit row moved into `try/finally` because `GeneratorExit` on a
client disconnect was losing it; a provider without `stream()` now falls back
instead of raising `AttributeError`); `convert_doc` missing a private
`-env:UserInstallation` profile (concurrent Celery workers raced over
LibreOffice's shared profile), plus a 25 MB `.doc` cap and `MAX_OCR_PAGES=15`;
a repeating-section name colliding with a field key (both occupy one flat
`answers` slot, which silently disabled required answers inside the section —
now refused at authoring time); and **four `tsc` errors in `EditorToolbar.tsx`
that were breaking `npm run build`** — streaming was wired into the dialog's
props with three identifiers never declared. Streaming is now wired properly,
with the plain mutation as the fallback.
Also: the false `mc ilm` lifecycle advice removed (verified `mc ilm rule add`
has no incomplete-multipart flag); the MinIO KMS key moved from
`docker-compose.yml` into gitignored `Backend/.env`; `@tiptap/core` declared at
3.32.0 (already installed, nothing fetched); seven unused imports removed;
`AUDIT/docs` pruned (3 files deleted, 2 archived with links fixed, the stale
`CLAUDE.md` warning replaced, `LANDING_PAGE_SYSTEM.md` added to the routing
table).
Not done, and why: migration `f5a6b7c8d9e0` is **not applied** (blocked by the
sandbox's shared-resource rule — the command is in the handover); the MinIO KMS
key is **not rotated** (your decision, and safe to do now because the bucket's
only two objects predate auto-encryption and are unencrypted).

**Not claimed:** WCAG 2.2 AA is not proven (no screen-reader or axe pass), LCP/INP were never measured, FR-1.6 (p95 at 100k) is untested, and the single-PUT upload path was fixed by the project owner after the last verification run, so it is not re-verified here — the resumable path added on 2026-11-01 sits alongside it and does not change it.

**Prev:** 2026-10-27 (**Documents Module — Phase 1 turn 2 + Phase 2 backend scaffold**: `UploadDropzone` (state machine + real byte progress) + `/documents/new/upload`; `/documents/new/blank` (shared-element + instant draft); submission wizard `/documents/:id/submit` (Stepper, autosaved details via `useAutosave`, `ConflictDialog` §24.3, workflow reuse, idempotent submit); shared Stepper/SaveIndicator/ConflictDialog. **Phase 2 backend:** Template/TemplateVersion/TemplateField/PlaceholderOccurrence models + migration `a7b8c9d0e1f2` (ADDITIVE, **NOT yet applied** — review first). `vite build` green; backend mappers configure clean. `SplitPane` deferred (react-resizable-panels v4 API). See `DOCUMENTS_MODULE_PLAN.md`.)

**Prev:** 2026-10-27 turn 1 (Phase 1 Foundation: autosave/lock + wizard fields + list sort/indexes migration `f1a2b3c4d5e6` [APPLIED]; premium `/documents` list; `/documents/new` hub; deps @tiptap 3.32.0, react-resizable-panels 4.15.0, @dnd-kit/core 6.3.1, @dnd-kit/sortable 10.0.0, idb 8.0.4)

**Prev:** 2026-10-26 (UI redesign **v2** + **Dashboard v3** content/IA fix: single `useDashboardData` hook, information-ownership layout, pipeline branch, period KPIs, inline approve/reject, fresh-workspace checklist; `vite build` passes; app NOT executed/manually verified)

Legend: **Done** = implemented end-to-end in code · **In progress** = partial/stubbed parts · **Planned** = enum/schema/stub only. "Tests" = files in `Backend/tests/` that touch it. Whether tests currently pass: TODO(verify) (not run).

| Module | Status | Key files | Tests | Known gaps / next steps |
|---|---|---|---|---|
| Auth (Firebase → DocFlow JWT, sessions, refresh) | Done | `routers/auth.py`, `services/auth_service.py`, `core/security.py`, `core/firebase.py`, `contexts/AuthContext.tsx`, `lib/api/client.ts` | `test_firebase_login_resilience`, `test_account_flows` | Email/password `/auth/login`,`/register` still exist, TODO(verify) frontend use; no rate limiting wired; stale header comment in `client.ts` |
| Accounts / onboarding / join requests | Done | `services/account_service.py`, `join_request_service.py`, `user_sync_service.py`, `OnboardingPage.tsx` | `test_account_flows`, `test_org_creation_email` | — |
| Orgs, departments, teams, members | Done | `routers/organizations.py`, `org_service.py`, `pages/admin/*` | `test_hr_permissions`, `test_admin_access` | Role mutation endpoints intentionally rejected (fixed 4 roles) |
| RBAC (4 fixed roles + superadmin) | Done | `domain/enums.py`, `domain/permissions.py`, `dependencies.py` | `test_hr_permissions`, `test_admin_access` | JWT permission snapshot can be stale ≤2h |
| Document types & dynamic forms | Done | `routers/documents.py` (`types_router`), `document_service.py`, `DynamicFormRenderer.tsx`, `DocumentTypesAdminPage.tsx` | none dedicated | `default_workflow_template_id` on type not implemented (old note); no template-per-type default |
| Documents (CRUD, versions, comments, attachments, restore) | Done | `routers/documents.py`, `document_service.py`, `document_repo.py`, `pages/documents/*`, `VersionHistoryModal`, `CommentDrawer` | indirect via workflow tests | Retention is no longer a stub — `purge_empty_drafts` (24 h) and `send_retention_notices` (7 days before the 90-day purge) are scheduled and verified against the live DB; both honour `DRAFT_RETENTION_DRY_RUN`, still `true`. `ready/archived/expired` statuses still unused |
| Drafts | Done | `pages/drafts/DraftsPage.tsx` | none | — |
| Template Studio (editor, placeholders, field config, publish) | Done | `template_studio_service.py`, `pages/templates/TemplateEditorPage.tsx`, `components/editor/*` | none (no tests by instruction) | Ribbon complete incl. Layout→PDF. No font-family picker (by decision); no editor UI for header/footer text (FR-6.6); conditional/repeating sections deferred (FR-7.10) |
| Document import (DOCX/PDF → blanks) | Done | `services/document_importer.py`, `blank_detector.py`, `import_service.py`, `workers/import_tasks.py`, `pages/templates/ImportTemplatePage.tsx` | none | Async via `import_jobs` + Celery, 3 s polling. DOCX keeps headings/lists/tables; PDF is text-only and labelled so. LLM pass is opt-in, default off. No OCR, no DOC/ODT/RTF, no streaming, no side-by-side original |
| Submission wizard + validation | Done | `pages/documents/SubmitWizard.tsx`, `services/document_validation.py`, `POST /documents/{id}/submit-check` | none | One server-side validator is the authority; the wizard mirrors it and 422s carry `fields: [{field, code, message}]` which `ValidationSummary` renders with “Fix this” links. Workflow list is a `<select>`, not searchable (FR-13.2) |
| Snapshot PDF / DOCX export | Done | `services/pdf_renderer.py`, `docx_renderer.py`, `workers/pdf_tasks.py` | none | Deterministic render (`invariant=1` + pinned `created`), so the stored SHA-256 proves the PDF matches the frozen snapshot. Page size/orientation read from the snapshot. Fonts: Noto Sans, SIL OFL 1.1, no CJK/Arabic/Devanagari/Tamil. Runbook for “stuck on Preparing” in the handover |
| AI assistance (Documents) | Done | `services/ai_assist_service.py`, `routers/ai_assist.py`, `components/ai/*` | none | Org switch **defaults off**, per-user opt-out, quota + audit (`ai_interactions`), nothing auto-applied. No streaming (FR-10.3), no ghost text or selection-menu presets (FR-10.1), **no PII redaction (FR-10.7) — known limitation** |
| Files / storage (presigned) | Done (needs MinIO) | `routers/files.py`, `core/storage.py` | none | Uses raw `HTTPException`. Antivirus + macro stripping wired (`services/antivirus.py`, `AV_SCANNER`); labels are honest (“File checked” / “Virus scan not enabled”). The upload bug was fixed by the project owner — **do not revert**; this path is not re-verified by the Documents sprint |
| Workflow templates (admin) | Done | `template_service.py`, `workflow_templates_public.py`, `admin.py`, `WorkflowTemplatesAdminPage`, `WorkflowBuilderModal` | `test_workflow_ownership` | `dynamic_by_amount_threshold` rule not implemented; `parallel`/`conditional` stage types and `WorkflowStageCondition` evaluation in `advance_stage` not seen, TODO(verify); `reapproval_on_revision` use TODO(verify) |
| Workflow engine (instances) | Done (sequential + min-approvals gate) | `workflow_service.py`, `routers/workflows.py` | `test_workflow_ownership`, `test_approval_authorization` | Legacy DAG engine (`domain/workflow_engine.py`, `approval_logic.py`, `sla.py`, tables `workflow_step_instances`, `approval_decisions`) unused, candidates for removal (needs approval + migration) |
| Approvals, delegation, signatures, revoke/recall, finalize | Done | `approval_service.py`, `routers/approvals.py`, `core/signing.py`, `ApprovalsPage.tsx`, `ApprovalHistoryPanel` | `test_approval_authorization`, `test_signatures_and_revocation` | Delegation not obviously tested; production signing keys must be set via env |
| Chat (DM + workflow-context, WebSocket) | Done | `chat_service.py`, `routers/chat.py`, `ws_chat.py`, `ChatPage.tsx`, `WorkflowChatPanel` | `test_chat_org_isolation` | Real-time paths not tested |
| Notifications (in-app + WS) | Done | `notification_service.py`, `subscribers.py`, `ws_notifications.py`, `useNotifications*` | indirect | Only for events handled in `subscribers.py`; SMS/push not present |
| Email | Done | `core/email_sender.py`, `email_dispatch.py`, `workers/email_tasks.py`, `emails/` | `test_email_pipeline` | Provider config per env; deliverability scripts in `Backend/scripts` |
| SLA & escalation | Done (backend) | `workers/sla_tasks.py`, `models/sla.py`, beat schedule | none | Needs worker+beat running; no tests; UI surfacing TODO(verify) |
| Analytics | Done | `analytics_service.py`, `routers/analytics.py`, `AnalyticsPage.tsx`, `DashboardPage.tsx` | none | Old notes said stubbed metrics; current service has workflow/approval metrics and bottlenecks, accuracy TODO(verify); `Dashboard` hardcoded tiles TODO(verify) |
| Search | Done | `search_service.py`, `routers/search.py`, `SearchPage.tsx` | none | Old notes said "not started", now implemented |
| AI Agent (RAG) + knowledge admin | Done | `agent_service.py`, `app/ai/*`, `routers/agent.py`, `AgentPage`, `AgentKnowledgePage` | `test_agent_rag`, `test_ai_provider_abstraction` | Float-array embeddings, app-side cosine (scales poorly); pgvector not used |
| AI-assisted document drafting | Done | `ai_document_service.py`, `/documents/ai/*` | none | Draft-only by design |
| Celery AI/cleanup tasks (OCR, embedding, retention) | Planned | `workers/ai_tasks.py`, `cleanup_tasks.py`, `models/ai.py` | none | Stubs returning constants; `pytesseract` etc. in requirements but unused |
| Admin portal & audit logs | Done | `routers/admin.py`, `AdminLayout`, `AdminDashboardPage`, `AdminLoginPage` | `test_admin_access` | — |
| Observability / health | Done | `middleware/logging.py`, `routers/health.py`, Sentry | none | OTEL settings unused, TODO(verify) |
| Rate limiting | Planned | `config.py` `RATE_LIMIT_*`, `slowapi` in requirements | none | No limiter wired in `app/` |
| Frontend tests | Planned | — | none | No runner in `package.json` (Vitest is the natural fit) |
| Frontend redesign **v2** ("Ice Pearl / Midnight Aurora") | **Foundation + shells + motion + hero pages done; remaining pages foundation-reskinned** (`vite build` passes; `tsc -b` only the 5 pre-existing files) | v2 tokens/gradients/glass/grain + typography (Instrument Serif/Plus Jakarta/Inter/JetBrains Mono via CDN) in `src/index.css`; primitives `src/components/ui/{GlassCard,IconChip,StatusBadge,Skeleton,SegmentedControl,Sparkline,EmptyState,PageHeader,Section,CommandPalette,LivingBackground}` + `components/auth/AuthBrandPanel`; motion `src/lib/motion/tokens.ts` + `components/layout/PageTransition`; shells `AppLayout`/`AdminLayout`; pages Dashboard/Login/Register/Profile/Settings/Drafts/Agent + `approvals-theme.css` unified. Docs: `DESIGN.md` v2, `archive/REDESIGN_V2_PLAN.md`, `REDESIGN_CHECKLIST.md`. | — | **v2 status.** Full treatment: foundation (B–F,H,I), Dashboard, Auth split, Profile, Settings, Drafts, Agent, Approvals-theme. **Remaining pages foundation-reskinned** (inherit tokens/type/LivingBackground/transitions) and need the deeper PageHeader/EmptyState/template pass: Documents list/detail/create, Workflows, Search, Analytics, Chat, Onboarding, AdminLogin, AdminDashboard + admin CRUD. Phase 9 deletion HELD. See `REDESIGN_CHECKLIST.md`. |
| Docker/deploy | In progress | `Backend/docker-compose.yml`, `Dockerfile`, `docker-entrypoint.sh` | — | Compose is dev-only; beat command needs `django_celery_beat` (not installed); prod build/deploy not defined, TODO(verify) |

## Repo hygiene notes
- Uncommitted working-tree changes touch nearly every backend/frontend file (per `git status` at session start). Don't assume `HEAD` matches the working tree.
- `Backend/.env` and a Firebase service-account JSON sit in `Backend/` (git-ignored, not tracked). Never read them into output.
- `Frontend/dist/`, `.ruff_cache/`, `.pytest_cache/` are build/cache artifacts.

## Update protocol (agents)
1. After any change, edit the affected row(s): status, key files, tests, gaps. Add a row for new modules.
2. Keep cells short; move long explanations into the relevant doc and link.
3. Set **Last updated** to today's date and what you verified (ran tests? built? manual?).
4. Never mark "Done" for something you did not read in code; use `TODO(verify)`.
5. If you fix a non-obvious bug, add an entry to `DEBUGGING_LESSONS.md`.

## How to use this when asked to…
- **"What's left / what next?"** Read the Known gaps column; pick Planned/In-progress rows; confirm with the user before schema/dependency/RBAC work.
- **Start a feature:** check the module row for files and tests to extend instead of duplicating; then follow `ARCHITECTURE.md` how-tos.
- **Report progress:** quote this table (with date) rather than recalling from memory.
