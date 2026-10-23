# ARCHITECTURE — how DocFlow is built
> Purpose: system map, layering, data model and cross-cutting mechanics, verified against code.
> Read: before any API, business-logic, DB, auth/RBAC, background-job, or frontend-data change. Business rules live in `PROJECT_CONTEXT.md`.

## System diagram
```mermaid
flowchart LR
  FE[React SPA :5173] -- "/api/v1 (Bearer DocFlow JWT) + cookie" --> API[FastAPI :8000]
  FE -- "/ws/chat/{id}, /ws/notifications ?token=JWT" --> API
  FE -- "Firebase SDK sign-in" --> FB[(Firebase Auth)]
  API -- "verify ID token (firebase-admin)" --> FB
  API --> PG[(PostgreSQL)]
  API <--> RD[(Redis: cache, pub/sub, Celery broker)]
  API -- "presigned URLs (boto3)" --> S3[(MinIO / S3)]
  API -- "LLMProvider / EmbeddingProvider" --> AI[Gemini | OpenAI | Anthropic]
  API -- enqueue --> CW[Celery worker: default, ai, email queues]
  CB[Celery beat] --> CW
  CW --> PG
  CW -- "SMTP / Resend / console" --> MAIL[(Email)]
```
No Ollama code exists (despite earlier hints); providers are `gemini` (default), `openai`, `anthropic` in `app/ai/providers/`.

## Repo map
| Path | Responsibility |
|---|---|
| `Backend/app/main.py` | App factory, CORS, logging middleware, exception handlers, router registration (`/api/v1/*`), lifespan (Firebase init, Sentry, WS Redis subscriber, imports `subscribers.py`) |
| `app/routers/` | Thin HTTP adapters (auth, users, organizations, documents, files, workflows, workflow_templates_public, approvals, chat, ws_chat, ws_notifications, notifications, analytics, search, agent, admin, health) |
| `app/services/` | ALL business logic (one class per domain, constructed with `AsyncSession`) |
| `app/repositories/` | Org-scoped query layer for some domains (chat, dept, document, notification, org, role, user, workflow). Not every service uses one |
| `app/models/` | SQLAlchemy models; `BaseModel` = UUID pk, `created_at/updated_at`, `deleted_at` soft delete |
| `app/schemas/` | Pydantic request/response models (auth, chat, document, org, users, workflow_instances) |
| `app/domain/` | Pure logic: `enums.py` (statuses, `Permission`, `SYSTEM_ROLES`), `permissions.py` (`AuthUser`). `approval_logic.py`, `workflow_engine.py`, `sla.py` have no importers (legacy DAG engine, see Status) |
| `app/core/` | security (JWT/bcrypt), firebase, signing (RSA-PSS), storage (S3/MinIO), redis, websocket manager, events (EventBus), exceptions, email_sender/email_dispatch, celery_app, trust (OS cert store) |
| `app/ai/` | Provider-independent `LLMProvider`/`EmbeddingProvider`, `registry.py` (selects by env), `ingestion.py` (chunking), `retrieval.py` |
| `app/workers/` | Celery tasks: email (real), sla (real), notification (publishes to Redis), ai/cleanup (stubs) |
| `app/subscribers.py` | EventBus handlers = the ONLY place that creates notifications for chat/doc-status events |
| `app/emails/` | Jinja email templates + logo |
| `Backend/alembic/versions/` | 11 migrations, single linear chain, head `e5b2a9d1c3f7` |
| `Backend/tests/` | pytest-asyncio against a real local Postgres (12 test files + `conftest.py`, ~160 tests) |
| `Backend/scripts/` | seed_admin, diagnose_accounts, enable_pg_trgm, email checks, `init-db.sql` (uuid-ossp, vector, pg_trgm, btree_gin) |
| `Frontend/src/pages/<feature>/` | Route-level screens (auth, onboarding, dashboard, documents, drafts, approvals, workflows, search, analytics, chat, agent, settings, admin/*) |
| `Frontend/src/components/` | `layout/` (AppLayout, AdminLayout), `auth/ProtectedRoute`, `documents/`, `workflows/`, `approvals/`, `ui/` |
| `Frontend/src/hooks/` | TanStack Query hooks per domain + WebSocket hooks |
| `Frontend/src/lib/api/` | One typed module per backend domain over `client.ts` |
| `Frontend/src/store/` | Zustand: `authStore` (profile/org/permissions, persisted), `uiStore` (theme/sidebar, persisted), `notificationStore`, `toastStore` |
| `Frontend/src/contexts/AuthContext.tsx` | Firebase session owner |
| `Frontend/src/pages/approvals/UI Components/` | Unused shadcn-style kit, excluded from `tsc` (`tsconfig.app.json`) |

## Backend
**Layering:** router → service → (repository) → model. Routers validate input (Pydantic), inject `CurrentUser`/`DatabaseDep`, call a service, return a schema. Services raise `DocFlowException` subclasses (`core/exceptions.py`). `get_db` commits on success and rolls back on error; services also call `db.commit()` themselves (some, e.g. `start_workflow`, deliberately do NOT because the caller owns the transaction, check the docstring).

**Auth flow (hybrid Firebase → DocFlow JWT):**
1. Frontend signs in via Firebase SDK (`lib/auth/firebase.ts`; Google, Microsoft, email).
2. `AuthContext` → `lib/auth/syncProfile.ts::syncAndExchange` → `POST /auth/firebase-login` (Firebase ID token → `AuthService.firebase_login` → find/link/create user, create `Session` row, return DocFlow access token + profile + org membership + permissions; refresh token in HttpOnly cookie `docflow_refresh`, path `/api/v1/auth`).
3. Access token (RS256 if `JWT_PRIVATE_KEY` set, else HS256 w/ `SECRET_KEY`; `iss=docflow`, claims: sub, org_id, roles, permissions, is_superadmin, jti=session id) held in memory (`tokenStore`). Frontend retries once on 401 via `POST /auth/refresh`, then signs out.
4. `get_current_user` (`dependencies.py`) decodes JWT AND checks the `Session` row isn't revoked.
5. `POST /users/me/sync` uses `FirebaseCurrentUser` (raw Firebase token, no session) and exists only to create an org during onboarding.
6. `/auth/login` and `/auth/register` (bcrypt email+password, no Firebase) also exist. TODO(verify) whether the frontend still uses them.
7. WebSockets authenticate with `?token=<DocFlow JWT>` (`verify_jwt`).

**RBAC enforcement point:** route-level `require_permission("x:y")` / `require_role(...)` / `require_superadmin()` in `dependencies.py` (JWT permission snapshot) + service-level live checks for sensitive rules (trainee/self-approval in `ApprovalService`, `assert_can_manage_knowledge`, `_assert_can_edit` in `TemplateService`). Multi-tenancy: every repository/service query filters by `org_id` (from `AuthUser.org_id`). `AuthUser.is_superadmin` bypasses everything.

**Background jobs (Celery, Redis broker):** queues `default`, `ai`, `email`; `acks_late`, prefetch 1. Beat schedule in `core/celery_app.py`: `check-sla-breaches` (*/15 min), `cleanup-expired-documents` (03:00 UTC, stub), `refresh-stale-embeddings` (02:00 UTC, stub). Email: `dispatch_email` queues to Celery or sends inline; `EMAIL_SYNC_FALLBACK` sends inline if Redis/worker is down.

**Events/notifications:** services call `EventBus.publish(name, payload)` (synchronous, in-process); `subscribers.py` handlers spawn `asyncio.create_task` with a fresh DB session and call `NotificationService` (DB row + Redis publish → `ws_manager` → `/ws/notifications`). Don't call `notify()` directly for events already handled in `subscribers.py` (double notifications).

**File storage:** `core/storage.py` (boto3; MinIO if `STORAGE_BACKEND=minio`). Presigned flow in `routers/files.py` (`POST /files/upload-url`, `POST /files/confirm-upload`, `GET /files/download-url/...`); MIME allow-list + 50 MB cap; buckets `S3_BUCKET_*`. Metadata in `file_assets`, `document_versions`, `document_attachments`.

**Signatures:** `core/signing.py` RSA-PSS-SHA256 over canonical JSON (approver, version hash, decision, timestamp, step); keys from `DOCUMENT_SIGNING_*` env or ephemeral in dev. Public key at `GET /approvals/signing-key` (`routers/approvals.py:52`; the whole `/approvals` router requires `approvals:decide`, so trainees get 403 on every approvals API), verification via `verify_step_signature`.

**AI / RAG:** `AgentService` (`services/agent_service.py`) → `app/ai/registry.py` picks provider from `AI_PROVIDER`/`AI_EMBEDDING_PROVIDER`. Admin uploads knowledge → `ingestion.py` chunks + embeds → `agent_chunks` stores embeddings as **float arrays, not a pgvector column** (works without the extension); retrieval is computed app-side (`retrieval.py`) with `AI_RETRIEVAL_TOP_K` / `AI_RETRIEVAL_MIN_SIMILARITY`; chunks tagged with `embedding_model/dim` and ignored if mismatched. `AIDocumentService` powers `/documents/ai/suggest-type` and `/documents/ai/draft` (draft only). `models/ai.py` (`DocumentEmbedding`, `AIChatSession`, `AIProcessingLog`) and `workers/ai_tasks.py` are unimplemented stubs.

**Search:** `SearchService` over documents/workflows/members/messages (ILIKE + `pg_trgm` `similarity()`; `documents.search_vector` TSVECTOR/GIN column exists; `scripts/enable_pg_trgm.py`).

## Frontend
- **Routing:** `src/App.tsx`, React Router v7. Public `/login`, `/register`, `/admin/login`; `/onboarding` (`allowNoOrg`); app shell `/` → `AppLayout`: dashboard, profile, documents(/new,/:id), approvals/*, workflows/*, search, analytics/*, chat, drafts, agent, settings; `/admin` → `AdminLayout` guarded by `requireRole={['admin','hr']}` (`roles`, `agent-knowledge` admin-only). Pages are statically imported (no lazy loading).
- **Data fetching:** TanStack Query; defaults staleTime 2 min, retry 2, no refetch on focus. Pattern: `lib/api/<domain>.ts` (typed calls via `apiClient`) → `hooks/use<Domain>.ts` (query-key factory + `useQuery`/`useMutation`, `enabled` gated on auth store) → page.
- **API client:** `lib/api/client.ts`; base `VITE_API_URL` (default `/api/v1`), `credentials:'include'`, Bearer from `tokenStore`, 401 → refresh → retry once → Firebase sign-out. Errors become `ApiClientError(status, detail, requestId)` from backend `{error, status_code, request_id}`. FormData uploads via `postForm`. (Header comment in `client.ts` still says "Firebase ID token"; the code uses the DocFlow JWT.)
- **State:** server state = React Query; session/profile/permissions = `authStore` (persisted display data) + `AuthContext`; UI prefs = `uiStore` (`theme` toggles `data-theme` on `<html>`); toasts via `toastStore`/`ToastContainer`.
- **Forms/validation:** React Hook Form + Zod only on auth pages (Login, Register, Profile, AdminLogin) and `useForm` in a few admin pages (Departments, Members, OrganizationSettings). Other forms use local `useState`. Document forms render from backend `form_schema` via `DynamicFormRenderer`.
- **Styling:** Tailwind 4 (`@tailwindcss/vite`) + CSS custom-property tokens in `src/index.css`, many pages use inline `style={{}}` and global classes (e.g. `.spinner`); no consistent component library in use. Details deferred to `DESIGN.md`.
- **Real-time:** `useChatWebSocket`, `useNotificationWebSocket` (`lib/ws.ts` generic manager is unused per `App.tsx` note).

## Data model (SQLAlchemy models; table names)
- Identity/tenancy: `users`, `sessions`, `organizations`, `departments`, `teams`, `roles`, `permissions`, `role_permissions`, `organization_members` (user↔org↔role↔dept).
- Documents: `document_types` (form_schema), `document_templates`, `documents` (org, submitted_by, status, current_version_id, form_data, tsvector), `document_versions`, `file_assets`, `document_attachments`, `comments`, `mentions`.
- Workflow: `workflow_templates` → `workflow_stages` → `stage_approver_rules`, `workflow_stage_conditions`; `workflow_instances` (template snapshot, current_stage_id, status) → `approval_steps` (approver, decision, round_number, due_at, revoked_at, signature fields) → `esignatures`, `approval_revocations`; `delegations`. Legacy/unused: `workflow_step_instances`, `approval_decisions`.
- Comms: `conversations`, `conversation_participants`, `chat_messages`, `notifications`.
- Governance: `audit_logs`, `sla_events`.
- AI: `agent_knowledge_sources`, `agent_chunks`, `agent_conversations`, `agent_messages`; stubs `document_embeddings`, `ai_chat_sessions`, `ai_processing_logs`.
- Soft delete via `deleted_at` on `BaseModel` tables; queries must filter `deleted_at IS NULL` (see `document_repo.py`).

## Cross-cutting
- **Errors:** raise `NotFound/Forbidden/Conflict/Validation/Unauthorized/ServiceUnavailable/RateLimitException`; handler returns `{"error","status_code","request_id"}`. Unhandled → 500 same shape. Never raw `HTTPException`.
- **Logging:** structlog; `RequestLoggingMiddleware` sets `X-Request-ID`, logs user/org/duration. Sentry if `SENTRY_DSN`.
- **Config:** `app/config.py` (pydantic-settings, `.env`); `validate_production()` at startup. Env var names (no values): APP_ENV, SECRET_KEY, DATABASE_URL, REDIS_URL, JWT_PRIVATE_KEY/PUBLIC_KEY, DOCUMENT_SIGNING_PRIVATE_KEY/PUBLIC_KEY, FIREBASE_PROJECT_ID, FIREBASE_CREDENTIALS_JSON, FIREBASE_CHECK_REVOKED, STORAGE_BACKEND, MINIO_ENDPOINT, AWS_ACCESS_KEY_ID/SECRET, S3_BUCKET_*, AI_PROVIDER, AI_EMBEDDING_PROVIDER, GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, AI_MODEL, AI_EMBEDDING_MODEL, EMAIL_PROVIDER, EMAIL_DELIVERY_MODE, SMTP_*, RESEND_API_KEY, CELERY_BROKER_URL, CELERY_RESULT_BACKEND, SENTRY_DSN, CORS_ORIGINS, FRONTEND_URL, RATE_LIMIT_*, ADMIN_EMAIL/ADMIN_PASSWORD. Frontend: VITE_API_URL, VITE_WS_URL, VITE_APP_NAME, VITE_APP_ENV, VITE_ADMIN_BASE_PATH, VITE_FIREBASE_*.
- **Rate limiting:** `RATE_LIMIT_*` settings and `slowapi` are declared but no limiter is wired in `app/` (grep found none). TODO(verify).
- **CORS:** `CORS_ORIGINS` (default localhost:5173/3000), credentials on.

## How to use this when asked to…
- **Add an API endpoint end-to-end:** schema in `schemas/` → logic in a service method (org-scoped, raise `DocFlowException`s, audit via `AuditLog` if state-changing) → thin route with `require_permission(...)` and `response_model` → register in `main.py` only if it's a new router (mind route order: literals before `/{id}`) → `lib/api/<domain>.ts` function + type in `types/index.ts` → hook → page. Add a test in `Backend/tests/`.
- **Add a DB table/column:** ask first. Model in `models/` (+ import in `models/__init__.py`), `alembic revision --autogenerate`, review the file (down_revision must be the current head), `alembic upgrade head`, keep status-like columns VARCHAR (no native enums).
- **Add a page that calls the API:** `lib/api/*.ts` → `hooks/use*.ts` (key factory, `enabled` on auth) → `pages/<feature>/Page.tsx` → route in `App.tsx` (wrap with `ProtectedRoute` + `permission`/`requireRole` for UX) → nav entry in `AppLayout`/`AdminLayout`.
- **Change approval/workflow logic:** edit `approval_service.py` / `workflow_service.py` (+ `template_service.validate_definition` for template rules); keep event publishing + audit writes; re-read `PROJECT_CONTEXT.md` rules; run the approval/signature/workflow tests.
- **Touch auth/RBAC:** ask first. Files: `dependencies.py`, `core/security.py`, `core/firebase.py`, `services/auth_service.py`, `services/account_service.py`, `domain/enums.py`, `domain/permissions.py`, `AuthContext.tsx`, `ProtectedRoute.tsx`, `lib/api/client.ts`. JWT carries a permission snapshot, so role changes only apply after refresh/re-login except for the live-checked rules.
