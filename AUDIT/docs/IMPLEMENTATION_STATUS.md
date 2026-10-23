# IMPLEMENTATION_STATUS — what exists, what's missing
> Purpose: per-module status based on code inspection (routes exist, UI wired, tests exist). Not a runtime verification.
> Read: when asked "what's done / what's next", before starting a feature, and update after every change.

**Last updated:** 2026-10-23 (initial agent-context pass; code read only, tests/app NOT executed)

Legend: **Done** = implemented end-to-end in code · **In progress** = partial/stubbed parts · **Planned** = enum/schema/stub only. "Tests" = files in `Backend/tests/` that touch it. Whether tests currently pass: TODO(verify) (not run).

| Module | Status | Key files | Tests | Known gaps / next steps |
|---|---|---|---|---|
| Auth (Firebase → DocFlow JWT, sessions, refresh) | Done | `routers/auth.py`, `services/auth_service.py`, `core/security.py`, `core/firebase.py`, `contexts/AuthContext.tsx`, `lib/api/client.ts` | `test_firebase_login_resilience`, `test_account_flows` | Email/password `/auth/login`,`/register` still exist, TODO(verify) frontend use; no rate limiting wired; stale header comment in `client.ts` |
| Accounts / onboarding / join requests | Done | `services/account_service.py`, `join_request_service.py`, `user_sync_service.py`, `OnboardingPage.tsx` | `test_account_flows`, `test_org_creation_email` | — |
| Orgs, departments, teams, members | Done | `routers/organizations.py`, `org_service.py`, `pages/admin/*` | `test_hr_permissions`, `test_admin_access` | Role mutation endpoints intentionally rejected (fixed 4 roles) |
| RBAC (4 fixed roles + superadmin) | Done | `domain/enums.py`, `domain/permissions.py`, `dependencies.py` | `test_hr_permissions`, `test_admin_access` | JWT permission snapshot can be stale ≤2h |
| Document types & dynamic forms | Done | `routers/documents.py` (`types_router`), `document_service.py`, `DynamicFormRenderer.tsx`, `DocumentTypesAdminPage.tsx` | none dedicated | `default_workflow_template_id` on type not implemented (old note); no template-per-type default |
| Documents (CRUD, versions, comments, attachments, restore) | Done | `routers/documents.py`, `document_service.py`, `document_repo.py`, `pages/documents/*`, `VersionHistoryModal`, `CommentDrawer` | indirect via workflow tests | Comments/attachments/restore not covered by tests; `ready/archived/expired` statuses unused; retention cleanup task is a stub |
| Drafts | Done | `pages/drafts/DraftsPage.tsx` | none | — |
| Files / storage (presigned) | Done (needs MinIO) | `routers/files.py`, `core/storage.py` | none | Uses raw `HTTPException`; real upload against MinIO unverified |
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
| Frontend redesign | Planned | `docs/DESIGN.md` is a skeleton | — | Whole UI to be redesigned; dark/light theme exists in `uiStore`/`index.css`; unused shadcn kit in `pages/approvals/UI Components` |
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
