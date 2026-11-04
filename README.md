# DocFlow

**Enterprise document workflow & approval platform.** Multi-tenant, organization-scoped:
an organization creates documents from configurable types with dynamic forms, routes them
through admin-configured multi-stage approval workflows, and keeps a cryptographically
signed, auditable trail of every decision.

Built as an internship project. FastAPI + React, PostgreSQL + Redis + Celery, Firebase for
identity, pluggable AI providers.

---

## Table of contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Configuration](#configuration)
- [Roles & permissions](#roles--permissions)
- [Document lifecycle](#document-lifecycle)
- [Testing](#testing)
- [Documentation map](#documentation-map)
- [Contributing rules](#contributing-rules)

---

## What it does

| Capability | Detail |
|---|---|
| **Multi-tenancy** | Every row is scoped by `org_id`. Organizations are created by their first user, who becomes Main Administrator; everyone else joins by invite or by an admin-reviewed join request. |
| **Configurable document types** | Admin-defined categories, each with a JSON `form_schema` rendered dynamically in the UI. Adding a type needs no code change. |
| **Multi-stage approval workflows** | Reusable templates of ordered stages. The template is frozen as a snapshot onto each workflow instance at start, so editing a template never rewrites history. |
| **Rule-based approver resolution** | Per stage: `specific_user`, `role_in_department`, `manager_of_requester`. Trainees are stripped from resolved approvers and rejected at template-validation time. |
| **Signed decisions** | Every approval/rejection is signed RSA-PSS-SHA256 (`app/core/signing.py`). Stages may additionally require an explicit signature payload. |
| **Revocation, recall & finalize** | An approver can revoke their own decision; once the document has moved on, that becomes a *recall request* resolved by admin/HR. Approved workflows are explicitly finalized. Step rows are never deleted — only flagged. |
| **Delegation** | An approver can let another user decide their steps for a period. |
| **SLA tracking** | `sla_hours` per stage sets `due_at`; a Celery beat job sweeps for breaches every 15 minutes and notifies. |
| **Per-document chat** | A `workflow_context` conversation is auto-created when an approver requests changes, so the requester and approver can resolve it in place. |
| **Org-scoped RAG "Agent"** | Retrieval over admin-managed legal knowledge, using pgvector. |
| **AI-assisted drafting** | Generates document drafts only — never auto-submits. Pluggable across Gemini / OpenAI / Anthropic. |
| **Analytics** | Role-scoped: admin/HR see organization-wide figures, workers their own plus department, trainees their own. The applied scope is returned in the payload so the UI can label it honestly. |

---

## Architecture

```
                      +-----------------------------+
   Browser            |  React 19 SPA (Vite)        |
   ------------------->|  TanStack Query - Zustand   |
                      +------------+----------------+
                                   |  1. Firebase SDK sign-in
                      +------------v--------+
                      |   Firebase Auth     |  Google - Microsoft - Email
                      +------------+--------+
                                   |  2. Firebase ID token
                      +------------v---------------------------------+
                      |  FastAPI  (/api/v1)                          |
                      |                                              |
                      |  routers/       thin HTTP adapters           |
                      |  services/      business logic + authz       |
                      |  domain/        pure rules (enums, perms)    |
                      |  repositories/  data access (org-scoped)     |
                      +---+----------+----------+----------+---------+
                          |          |          |          |
                  +-------v--+  +----v---+ +----v----+ +---v----------+
                  |PostgreSQL|  | Redis  | |MinIO/S3 | | AI providers |
                  |+ pgvector|  | cache  | | files   | | Gemini/OpenAI|
                  | pgbouncer|  | pubsub | |         | | /Anthropic   |
                  +----------+  +----+---+ +---------+ +--------------+
                                     |
                              +------v------------------+
                              | Celery worker + beat    |
                              | queues: default/ai/email|
                              +-------------------------+
```

**Auth flow (hybrid Firebase to DocFlow JWT):**

1. The frontend signs in with the Firebase SDK and receives a Firebase ID token.
2. `POST /auth/firebase-login` verifies that token server-side, finds/links/creates the
   DocFlow user, creates a `Session` row, and returns a **DocFlow** access token plus the
   user's profile, org membership and permission list.
3. The access token (RS256 when `JWT_PRIVATE_KEY` is set, HS256 otherwise) is held **in
   memory only** — never `localStorage` — and carries a snapshot of `roles` + `permissions`
   plus `jti` = session id, used for instant revocation.
4. The refresh token lives in an HttpOnly, `SameSite=Strict` cookie scoped to
   `/api/v1/auth`. The API client retries once on 401 via `POST /auth/refresh`.
5. WebSockets authenticate with `?token=<DocFlow JWT>`.

**Enforcement:** route-level `require_permission(...)` / `require_role(...)` dependencies,
plus service-level live-from-DB re-checks for the rules that must never go stale (trainee
cannot approve, self-approval, Agent knowledge management). The frontend's `ProtectedRoute`
is UX only — **the backend is the enforcement point.**

---

## Tech stack

### Backend (`Backend/`)

| | |
|---|---|
| Runtime | Python 3.12 |
| Framework | FastAPI 0.115, Uvicorn |
| ORM / DB | SQLAlchemy 2.0 (async), asyncpg, PostgreSQL with pgvector, pgbouncer |
| Migrations | Alembic 1.13 |
| Validation | Pydantic 2.8, pydantic-settings |
| Background jobs | Celery 5.4 (+ beat) over Redis |
| Cache / pub-sub | Redis 5.1 (hiredis) |
| Object storage | MinIO (dev) / S3 via boto3 |
| Identity | firebase-admin 6.5 |
| Logging | structlog |
| Tests | pytest, pytest-asyncio, pytest-cov |

### Frontend (`Frontend/`)

| | |
|---|---|
| Framework | React 19, TypeScript, Vite 8 |
| Styling | Tailwind CSS 4 |
| Server state | TanStack Query 5 (staleTime 2 min, retry 2, no refetch on focus) |
| Client state | Zustand 5 (`authStore`, `uiStore`, `notificationStore`, `toastStore`) |
| Routing | React Router 7 |
| Forms | React Hook Form + Zod (auth pages and a few admin pages) |
| Motion | Framer Motion / `motion` |
| Identity | Firebase JS SDK 12 |
| Lint | oxlint |

---

## Repository layout

```
DocFlow/
├── Backend/                   FastAPI application
│   ├── app/
│   │   ├── main.py            app factory, CORS, exception handlers
│   │   ├── config.py          pydantic-settings (all env vars)
│   │   ├── dependencies.py    DI: DB session, current user, permission guards
│   │   ├── database.py        async engine + session factory
│   │   ├── routers/           HTTP adapters (auth, documents, workflows, approvals, ...)
│   │   ├── services/          business logic — the real authorization layer
│   │   ├── repositories/      data access, every query scoped by org_id
│   │   ├── domain/            pure logic: enums, Permission, SYSTEM_ROLES, AuthUser
│   │   ├── models/            SQLAlchemy ORM models
│   │   ├── schemas/           Pydantic request/response contracts
│   │   ├── core/              security, firebase, storage, signing, redis, websocket
│   │   ├── ai/                provider abstraction + ingestion + retrieval
│   │   ├── workers/           Celery tasks
│   │   └── emails/            templates
│   ├── alembic/versions/      migrations (YYYYMMDD_HHMM_<rev>_<slug>.py)
│   ├── tests/                 pytest suite
│   ├── docker-compose.yml     postgres, pgbouncer, redis, minio, mailpit, adminer, flower
│   └── requirements.txt
│
├── Frontend/                  React SPA
│   └── src/
│       ├── pages/<feature>/   route-level screens
│       ├── components/        layout, auth, documents, workflows, approvals, ui
│       ├── lib/api/           typed API calls via apiClient
│       ├── hooks/             query-key factories + useQuery/useMutation
│       ├── store/             Zustand stores
│       └── contexts/          AuthContext (Firebase session owner)
│
├── AUDIT/                     living documentation — read before changing code
│   ├── CLAUDE.md              rules + routing table
│   └── docs/                  ARCHITECTURE, DESIGN, CODING_RULES, PROJECT_CONTEXT,
│                              IMPLEMENTATION_STATUS, DEBUGGING_LESSONS
├── scripts/
└── CLAUDE.md                  agent entry point
```

---

## Prerequisites

- **Python 3.12** (a virtualenv already exists at `Backend/.venv`)
- **Node.js** — not pinned in the repo; Vite 8 requires Node 20.19+ or 22.12+
- **Docker + Docker Compose** for the local infrastructure
- A **Firebase project** with Authentication enabled (Google / Microsoft / Email-Password)
  and a service-account credential

> **Note:** both `package-lock.json` and `pnpm-lock.yaml` exist in `Frontend/`. Pick one
> package manager and delete the other lockfile before the next dependency change.

---

## Quick start

### 1. Infrastructure

```bash
cd Backend
docker compose up -d
```

Brings up PostgreSQL (pgvector image), pgbouncer, Redis, MinIO, Mailpit (SMTP sink),
Adminer and Flower.

### 2. Backend

```bash
cd Backend
cp .env.example .env            # then fill in the values — see Configuration
pip install -r requirements.txt
```

Apply migrations, then run the API:

```bash
# Windows
.venv\Scripts\alembic.exe upgrade head
# macOS / Linux
alembic upgrade head

uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

API docs at <http://localhost:8000/api/docs> (disabled when `APP_ENV=production`).

### 3. Background workers

In separate terminals, from `Backend/`:

```bash
celery -A app.core.celery_app worker --loglevel=info -Q default,ai,email
celery -A app.core.celery_app beat   --loglevel=info
```

### 4. Frontend

```bash
cd Frontend
npm install
npm run dev
```

Runs on <http://localhost:5173> and proxies `/api` and `/ws` to `127.0.0.1:8000`, which
keeps requests same-origin so the `SameSite=Strict` refresh cookie is sent.

### 5. First run

Sign in with Google/Microsoft/email. A user with no organization lands on `/onboarding`,
where they either **create an organization** (becoming its Main Administrator, with one
default document type and one default workflow seeded) or **request to join** an existing
one by name, which an admin or HR user then accepts or rejects.

---

## Commands

Run from the folder shown.

| Task | Folder | Command |
|---|---|---|
| Install backend deps | `Backend/` | `pip install -r requirements.txt` |
| Apply migrations | `Backend/` | `alembic upgrade head` |
| Check migration state | `Backend/` | `alembic current` vs `alembic heads` (must be a single head) |
| New migration | `Backend/` | `alembic revision --autogenerate -m "msg"` |
| Run API | `Backend/` | `uvicorn app.main:app --reload --host 0.0.0.0 --port 8000` |
| Celery worker | `Backend/` | `celery -A app.core.celery_app worker --loglevel=info -Q default,ai,email` |
| Celery beat | `Backend/` | `celery -A app.core.celery_app beat --loglevel=info` |
| Infrastructure | `Backend/` | `docker compose up -d` |
| Backend tests | `Backend/` | `pytest` |
| Backend lint | `Backend/` | `ruff check app/` |
| Frontend dev server | `Frontend/` | `npm run dev` |
| Frontend build + typecheck | `Frontend/` | `npm run build` (= `tsc -b && vite build`) |
| Frontend lint | `Frontend/` | `npm run lint` |
| Regenerate API types | `Frontend/` | `npm run gen:api` |

---

## Configuration

Copy `Backend/.env.example` to `Backend/.env`. **Never commit `.env` or the Firebase
service-account JSON.** Variable **names** only below — look up the values in your own
Firebase console, cloud provider and secret store.

### Backend (`Backend/.env`)

| Group | Variables |
|---|---|
| App | `APP_ENV` `APP_DEBUG` `APP_VERSION` `LOG_LEVEL` `CORS_ORIGINS` |
| Security | `SECRET_KEY` `JWT_PRIVATE_KEY` `JWT_PUBLIC_KEY` `JWT_ALGORITHM` `ACCESS_TOKEN_EXPIRE_MINUTES` `REFRESH_TOKEN_EXPIRE_DAYS` |
| Database | `DATABASE_URL` `DATABASE_POOL_SIZE` `DATABASE_MAX_OVERFLOW` |
| Redis / Celery | `REDIS_URL` `REDIS_MAX_CONNECTIONS` `CELERY_BROKER_URL` `CELERY_RESULT_BACKEND` `CELERY_WORKER_CONCURRENCY` |
| Firebase | `FIREBASE_PROJECT_ID` `FIREBASE_CREDENTIALS_JSON` (file path, raw JSON, or base64) |
| Storage | `STORAGE_BACKEND` `MINIO_ENDPOINT` `AWS_ACCESS_KEY_ID` `AWS_SECRET_ACCESS_KEY` `AWS_REGION` `S3_BUCKET_DOCUMENTS` `S3_BUCKET_TEMPLATES` `S3_BUCKET_PREVIEWS` `S3_BUCKET_EXPORTS` `S3_BUCKET_OCR_INPUT` |
| Email | `EMAIL_FROM` `EMAIL_FROM_NAME` `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASSWORD` `SMTP_TLS` `RESEND_API_KEY` |
| AI | `AI_PRIMARY_MODEL` `AI_FALLBACK_MODEL` `AI_EMBEDDING_MODEL` `OPENAI_API_KEY` `ANTHROPIC_API_KEY` |
| Observability | `SENTRY_DSN` `OTEL_SERVICE_NAME` `OTEL_EXPORTER_OTLP_ENDPOINT` |
| Rate limits | `RATE_LIMIT_GLOBAL` `RATE_LIMIT_AUTH` `RATE_LIMIT_UPLOADS` `RATE_LIMIT_AI_CHAT` — **declared but not yet enforced in code** |

In production, `config.py` asserts that `JWT_PRIVATE_KEY` is a real key and that
`SECRET_KEY` is at least 32 characters. Without real RSA keys the app falls back to HS256
signed with `SECRET_KEY` — acceptable for local development only.

### Frontend (`Frontend/.env`)

```
VITE_API_URL  VITE_WS_URL  VITE_APP_NAME  VITE_APP_ENV  VITE_ADMIN_BASE_PATH
VITE_FIREBASE_API_KEY  VITE_FIREBASE_AUTH_DOMAIN  VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET  VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID  VITE_FIREBASE_MEASUREMENT_ID
```

---

## Roles & permissions

Exactly **four** organization roles, seeded identically into every organization. There is
no custom-role builder — the role set is intentionally fixed
(`Backend/app/domain/enums.py::SYSTEM_ROLES`), and every mutating role endpoint rejects all
callers. A separate platform-level `is_superadmin` flag bypasses all checks.

"Approver" is **not** a role: an approver is whoever a stage's `StageApproverRule` resolves
to for a given document.

| Permission | admin | hr | worker | trainee |
|---|:-:|:-:|:-:|:-:|
| `documents:` create / read / edit / submit / comment | ✓ | ✓ | ✓ | ✓ |
| `documents:cancel` | ✓ | ✓ | ✓ | – |
| `documents:delete` | ✓ | – | – | – |
| `workflows:read` | ✓ | ✓ | ✓ | ✓ |
| `workflows:admin` | ✓ | – | – | – |
| `approvals:decide` / `approvals:delegate` | ✓ | ✓ | ✓ | – |
| `chat:read` / `chat:send` / `uploads:create` | ✓ | ✓ | ✓ | ✓ |
| `analytics:read` | ✓ | ✓ | ✓ (own scope) | ✓ (own scope) |
| `analytics:export` / `admin:audit` | ✓ | – | – | – |
| `admin:users` / `admin:orgs` / `admin:doc_types` / `admin:workflow_templates` | ✓ | ✓ | – | – |
| `admin:roles` | ✓ | ✓ (read-only in practice) | – | – |
| `members:invite_standard` (worker / trainee) | ✓ | ✓ | – | – |
| `members:invite_hr` / `members:delete` / `agent:knowledge_manage` | ✓ | – | – | – |

26 permission codes in total. The JWT embeds a permission snapshot valid for up to
`ACCESS_TOKEN_EXPIRE_MINUTES`, so a role change takes effect on the next token refresh —
except for the rules that are deliberately re-read live from the database.

**Adding a permission** means: add it to the `Permission` enum, add it to `SYSTEM_ROLES`,
write a data migration for existing organizations, attach `require_permission(...)` to the
routes, and gate the UI with `hasPermission`. Ask before doing any of this.

---

## Document lifecycle

```
draft --submit--> submitted --> pending --------> approved --finalize--> finalized
                                  |                   |
                                  +--> rejected       +--> revoked / recall
                                  |
                                  +--> sent_back --revise & resume--> pending
                                                   (same stage, earlier
                                                    approvals untouched)

pending --cancel (owner only)--> cancelled
```

Only `draft` documents can be submitted. Revise-and-resume is allowed only from
`sent_back` / `submitted`. A stage passes when counted approvals reach
`min_approvals_required`; when the last stage passes, the instance becomes `approved` and
awaits an explicit finalize.

---

## Testing

```bash
cd Backend
pytest                              # needs a disposable local Postgres via TEST_DATABASE_URL
pytest tests/test_account_flows.py -v
pytest --cov=app
```

`tests/conftest.py` builds a real database and provides `admin`, `hr`, `worker` and
`trainee` fixtures with signed tokens, so authorization rules are exercised end to end
through HTTP.

Current suite (159 tests): account & organization flows, HR permission boundaries, admin
access, approval authorization, signatures & revocation, workflow ownership, chat org
isolation, Agent RAG, AI provider abstraction, email pipeline, Firebase login resilience.

No frontend test runner is configured yet; `npm run build` is the type-level gate.

---

## Documentation map

The `AUDIT/` folder is the living documentation and takes precedence over this README for
implementation detail. Start at [`AUDIT/CLAUDE.md`](AUDIT/CLAUDE.md).

| Looking for | Read |
|---|---|
| Product, roles, workflow & approval rules, lifecycle | `AUDIT/docs/PROJECT_CONTEXT.md` |
| Layering, auth flow, data fetching, API conventions | `AUDIT/docs/ARCHITECTURE.md` |
| Backend & frontend coding conventions | `AUDIT/docs/CODING_RULES.md` |
| Design system and UI tokens | `AUDIT/docs/DESIGN.md` |
| What's done, what's next, known gaps | `AUDIT/docs/IMPLEMENTATION_STATUS.md` |
| Bugs already solved and why | `AUDIT/docs/DEBUGGING_LESSONS.md` |

Plans for completed work live in `AUDIT/docs/archive/` and describe **history, not current
behaviour**. The code wins.

---

## Contributing rules

These are non-negotiable in this repository (full list in [`AUDIT/CLAUDE.md`](AUDIT/CLAUDE.md)):

1. **Never run a git command without explicit permission** — including read-only inspection.
2. State which files you will touch and why before editing. Minimal, scoped changes; no
   drive-by refactors.
3. **Ask first** before adding a dependency, changing the DB schema, or altering auth/RBAC
   (`SYSTEM_ROLES`, `require_permission`, the token flow).
4. Update `AUDIT/docs/IMPLEMENTATION_STATUS.md` after finishing a change, and
   `DEBUGGING_LESSONS.md` if a non-obvious bug was solved.
5. Never print, log or commit secrets. Environment variable **names** only.
6. Don't invent facts. If something is unverified, write `TODO(verify): ...` and ask.

### Definition of done

- [ ] `ruff check app/` clean for touched files; relevant `pytest` tests pass
- [ ] `npm run build` passes (TypeScript strict) and `npm run lint` is clean
- [ ] Migration applied and `alembic heads` shows a single head
- [ ] The changed flow checked manually with the right role(s); 401/403 paths considered
- [ ] Organization isolation preserved — every query scoped by `org_id`
- [ ] `AUDIT/docs/IMPLEMENTATION_STATUS.md` updated
