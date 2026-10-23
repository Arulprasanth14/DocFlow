# CODING_RULES — conventions observed in the real code
> Purpose: how code is written here (naming, placement, errors, validation, migrations, tests), plus a "never do" list from patterns the code already relies on.
> Read: before writing or modifying any code. Layout is in `ARCHITECTURE.md`; domain rules in `PROJECT_CONTEXT.md`.

## Backend (`Backend/app`)
**Placement**
| Code | Goes in |
|---|---|
| Business rules, permission-sensitive checks, transactions, audit writes | `services/<domain>_service.py` (class taking `AsyncSession`) |
| Query helpers (org-scoped reads/writes) | `repositories/<domain>_repo.py` (class per entity, `get_by_id(id, org_id)`) |
| Request/response models | `schemas/` (Pydantic v2; `response_model=` on routes; `Model.model_validate(orm_obj)`) |
| Tables | `models/` extending `BaseModel`; new modules imported in `models/__init__.py` |
| Pure rules / enums / permission codes | `domain/` |
| Cross-notification side effects | `EventBus.publish` + handler in `subscribers.py` |
| Slow/async work | Celery task in `workers/` (register queue in `celery_app.task_routes`) |

**Naming/style:** snake_case modules/functions; `PascalCase` classes; services `XService`, repos `XRepository`; routers named `router` (or `<x>_router` when a module has several); file header docstring `"""DocFlow Backend — <Layer>: <Name> …"""`; `from __future__ import annotations`; type hints everywhere (`X | None`, `uuid.UUID`); `structlog.get_logger(__name__)` with key=value log fields (`logger.info("event_name", id=str(x))`). Comments explain WHY and cite requirement/architecture sections.

**Routers are thin:** inject `CurrentUser`, `DatabaseDep`; gate with `dependencies=[require_permission("x:y")]` (or `Depends(require_role(...))`); construct service; return schema. Declare literal paths before `/{id}` paths. Routers that still contain queries (`admin.py`, `chat.py`, `files.py`) are legacy, don't copy them.

**Errors:** raise `NotFoundException`, `ForbiddenException`, `ConflictException` (invalid state), `ValidationException`/`UnprocessableEntityException` (422 business validation), `UnauthorizedException`, `ServiceUnavailableException`. Response shape is `{"error": str, "status_code": int, "request_id": str|null}`; the frontend reads `.error`. Pydantic body failures use FastAPI's default 422 shape (`detail`). TODO(verify) frontend handling of that shape.

**Success shape:** the Pydantic model itself (no envelope). Lists: plain `list[Model]`, or `Paginated…Response` objects with `Pagination` dep (`page`, `limit` capped at 100); `X-Total-Count` header is exposed by CORS. Simple actions return `MessageResponse`.

**Multi-tenancy & security:** every query filters `org_id` (and `deleted_at IS NULL`); look up by `(id, org_id)` (repos do this; a miss raises `NotFoundException`). Check ownership/assignment at service level, not just permission. Don't trust JWT role for security-critical decisions, read live from DB (see `ApprovalService._enforce_approval_authority`). Every state change writes an `AuditLog` (use `AuditAction` enum) and signs/records where the existing flow does.

**Status/enums:** never use raw string literals for statuses, use `domain/enums.py` and `DocumentStatus`. Status columns are VARCHAR, not native enums.

**Validation:** Pydantic schemas for shape; business validation in services (e.g. `validate_form_data`, `TemplateService.validate_definition`). `bleach` is in `requirements.txt` but unused in `app/` (TODO(verify) whether user text/HTML is sanitised anywhere).

**DB/migrations:** async SQLAlchemy 2.0 `Mapped[...]`/`mapped_column`; UUID PKs; soft delete via `soft_delete()`; JSONB for flexible data; indexes declared in `__table_args__`. Migrations via Alembic autogenerate, then manual review; single linear chain (current head `e5b2a9d1c3f7`); data migrations belong in the migration (see `d4a1f0c2b7e9`). No `Base.metadata.create_all` outside tests.

**Transactions:** `get_db` commits at request end; service methods that are called inside another service's transaction must NOT commit (document it). Event handlers open their own session.

**Testing:** pytest + pytest-asyncio (`asyncio_mode=auto`), real Postgres (`TEST_DATABASE_URL`, default a local `docflow_test` DB, created automatically), TRUNCATE between tests, fresh session per request. Tests are file-per-concern (`test_approval_authorization.py` etc.), use `conftest.py` fixtures to make org/users/tokens. Add a regression test for every business-rule change. No frontend tests exist.

**Lint:** `ruff` (version pinned 0.6.9, no config file → defaults); old audit found ~85 unused-import findings, so don't mass-fix unrelated files.

## Frontend (`Frontend/src`)
- **Imports:** `@/` alias → `src/`. Use `import type` (`verbatimModuleSyntax` is on). TS flags on: `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly` (no enums/namespaces/parameter properties, use unions/consts). `any` still appears (~14 places), don't add more.
- **Naming/placement:** pages `PascalCasePage.tsx` in `pages/<feature>/` (default export); shared components `PascalCase.tsx` in `components/<area>/`; hooks `useThing.ts` in `hooks/` exporting a query-key factory (`documentKeys`) and hooks; API modules `camelCase.ts` in `lib/api/` exporting an object (`documentsApi`) plus payload/response types; shared types in `types/index.ts`; file header block comment `DocFlow Frontend — …`.
- **Data:** all server calls go through `apiClient` (never raw `fetch`, except the refresh call in `client.ts`). Use TanStack Query; invalidate related `…Keys` after mutations; gate `enabled` on auth state. Use `postForm` for uploads (don't set Content-Type).
- **Auth/permissions:** read via `useAuth()` (Firebase state) and `useAuthStore()` (`hasPermission`, `hasRole`, `isSuperAdmin`). UI gating is cosmetic; the backend decides.
- **Forms/validation:** auth pages use React Hook Form + `zodResolver` + Zod schemas (zod v3). Prefer that stack for new forms; mirror backend constraints. Dynamic document forms go through `DynamicFormRenderer`.
- **Errors/loading:** catch `ApiClientError` (`status`, `detail`, `requestId`); surface via `toastStore`; use `AppLoadingScreen`/`ConfirmDialog` from `components/ui/`.
- **Styling:** Tailwind classes + CSS variables from `index.css`; theme via `data-theme` on `<html>` from `uiStore`. Visual redesign pending, see `DESIGN.md`; follow neighboring files until then.
- **Lint/build:** `oxlint` rules: `react/rules-of-hooks` error, `only-export-components` warn.

## Never do (patterns this code actively protects)
1. Bypass RBAC: no endpoint without `require_permission`/ownership check; never rely on frontend guards.
2. Query without `org_id` scoping or return another org's data.
3. Hard-delete rows that have audit/approval history; never rewrite `ApprovalStep.decision` (use `revoked_at`/`is_counted`).
4. Let a `trainee` become an approver or decide (template validation, `_exclude_trainees`, live check all enforce it).
5. Skip signing/audit on a decision, or create duplicate notifications outside `subscribers.py`.
6. Raise raw `HTTPException` (only `files.py` does, legacy) or return ad-hoc error shapes.
7. Put business logic or ORM queries in routers/React components.
8. Use raw status strings, or add native Postgres enums for statuses.
9. Commit inside a service method that another service calls within its transaction.
10. Hardcode secrets, call vendor AI SDKs directly (go through `app/ai` interfaces), or disable TLS verification (`AI_CA_BUNDLE`/OS trust store instead).
11. Store access tokens in localStorage/Zustand persist (tokens live in memory `tokenStore`; refresh token is an HttpOnly cookie).
12. Edit/apply migrations or schema without user approval; never edit an already-applied migration.
13. Re-introduce the generic `lib/ws.ts` connection in `App.tsx` (it targets a non-existent route).
14. Implement `dynamic_by_amount_threshold` or other reserved rules silently, it must fail loudly/log (see `workflow_service._apply_rule`).

## How to use this when asked to…
- **Fix a bug:** reproduce first (test or API call); find the owning service via the router; fix in the service; add a regression test; check `DEBUGGING_LESSONS.md` for a known pattern; keep diff minimal.
- **Refactor:** only with a stated scope; no behavior change; run `pytest` and `npm run build` before/after; don't touch RBAC/auth/migrations as part of a refactor; don't mass-reformat.
- **Add a feature safely:** read `ARCHITECTURE.md` how-to for the layer; list files to touch and ask on schema/dependency/RBAC changes; backend first (schema → service → route → test), then API module → hook → UI; update `IMPLEMENTATION_STATUS.md`.
