# CLAUDE.md — DocFlow agent entry point
> Purpose: first file an AI agent reads. Routes you to the right doc and states the rules you must not break.
> Read: at the start of EVERY task, before touching code.

**DocFlow** = multi-tenant (organization-scoped) enterprise document workflow & approval platform.
Backend: FastAPI + async SQLAlchemy + PostgreSQL (pgvector image) + Redis + Celery + MinIO/S3 + Firebase Auth (exchanged for DocFlow JWT) + pluggable AI (Gemini/OpenAI/Anthropic).
Frontend: React 19 + TypeScript + Vite + Tailwind 4 + TanStack Query + Zustand + React Hook Form/Zod (auth forms only).
Repo: `Backend/` (Python), `Frontend/` (Vite SPA), `AUDIT/` (these docs + older audit notes, see warning below).

## Commands (verified from repo files; run from the stated folder)
| Task | Command |
|---|---|
| Backend venv | `Backend/.venv` exists (Windows: `.venv\Scripts\<tool>.exe`) |
| Backend deps | `pip install -r requirements.txt` |
| Migrate | `cd Backend; .venv\Scripts\alembic.exe upgrade head` (check: `alembic current` vs `alembic heads`) |
| New migration | `alembic revision --autogenerate -m "msg"` (file name pattern in `alembic/versions/`: `YYYYMMDD_HHMM_<rev>_<slug>.py`) |
| Run API | `uvicorn app.main:app --reload --host 0.0.0.0 --port 8000` (docs at `/api/docs` when not production) |
| Celery worker | `celery -A app.core.celery_app worker --loglevel=info -Q default,ai,email` |
| Celery beat | `celery -A app.core.celery_app beat --loglevel=info` (see TODO below) |
| Infra | `cd Backend; docker compose up -d` (postgres, pgbouncer, redis, minio, mailpit, adminer, flower) |
| Backend tests | `cd Backend; pytest` (needs a local disposable Postgres, `TEST_DATABASE_URL`, see `tests/conftest.py`) |
| Backend lint | `ruff check app/` ; types: `mypy` (TODO(verify): no mypy/ruff config file found) |
| Frontend dev | `cd Frontend; npm run dev` (port 5173, proxies `/api` and `/ws` → 127.0.0.1:8000) |
| Frontend build/typecheck | `npm run build` (= `tsc -b && vite build`) |
| Frontend lint | `npm run lint` (oxlint) |
| Frontend tests | none configured (no test runner in `package.json`) |

TODO(verify): package manager — both `package-lock.json` and `pnpm-lock.yaml` exist. TODO(verify): docker-compose `celery-beat` uses `django_celery_beat` scheduler, which is NOT in `requirements.txt`; schedule is defined in `app/core/celery_app.py` (`beat_schedule`).

## Routing table — read these FIRST
| Task | Read |
|---|---|
| UI / frontend change | `docs/DESIGN.md` (placeholder, app is being redesigned) + `docs/CODING_RULES.md` §Frontend |
| API / business logic / DB change | `docs/ARCHITECTURE.md` + `docs/CODING_RULES.md` §Backend |
| Bug / error / "it broke" | `docs/DEBUGGING_LESSONS.md` first |
| "What's done / what's next" | `docs/IMPLEMENTATION_STATUS.md` |
| Landing page (build record + its own design system) | `docs/LANDING_PAGE_SYSTEM.md` |
| Roles, permissions, workflow/approval rules, doc lifecycle | `docs/PROJECT_CONTEXT.md` |
| Auth / RBAC | `docs/ARCHITECTURE.md` §Auth + `docs/PROJECT_CONTEXT.md` §Roles |

## Non-negotiable rules
1. **NEVER run any git command** (commit, add, push, checkout, stash, reset, branch, merge, rebase, …) without the user's explicit permission. Read-only inspection is NOT exempt unless the user said so.
2. Before editing, state which files you will touch and why. Make minimal, scoped changes. No drive-by refactors.
3. Do NOT add dependencies, change the DB schema (models/migrations), or alter auth/RBAC (`SYSTEM_ROLES`, `require_permission`, token flow) without asking first.
4. After finishing a change, update `docs/IMPLEMENTATION_STATUS.md`; also `docs/DEBUGGING_LESSONS.md` if a non-obvious bug was solved.
5. Never print, log, commit or copy secret values (`Backend/.env`, `Frontend/.env`, Firebase service-account JSON in `Backend/`). Env var NAMES only.
6. Do not invent facts. If unverified, write `TODO(verify): …` and ask.

## Definition of done
- [ ] Backend: `ruff check app/` clean for touched files; relevant `pytest` tests pass (add/adjust tests for rule changes).
- [ ] Frontend: `npm run build` passes (TS strict types) and `npm run lint` clean.
- [ ] Migration applied and `alembic heads` is a single head (if schema changed, with user approval).
- [ ] Manual check of the changed flow (API call or UI) with the right role(s); 401/403 paths considered.
- [ ] Org isolation preserved (every query scoped by `org_id`).
- [ ] `docs/IMPLEMENTATION_STATUS.md` (and `DEBUGGING_LESSONS.md` if relevant) updated.

## Warning: older notes in `AUDIT/`
Plans for finished work live in `AUDIT/docs/archive/` and describe history, not current behaviour. The code and the rest of `AUDIT/docs/*` win.
