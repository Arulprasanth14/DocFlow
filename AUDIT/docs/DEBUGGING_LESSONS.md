# DEBUGGING_LESSONS — failure checklist and lessons log
> Purpose: where to look first when something breaks, and a log of solved non-obvious bugs.
> Read: first, on any bug/error/"works locally but not here" report; append an entry after solving a non-obvious bug.

## Common failure points to check first (derived from the code)
| Symptom | Check |
|---|---|
| Every API call 401 after login | Frontend must exchange Firebase token via `POST /auth/firebase-login` (`lib/auth/syncProfile.ts`); API expects the DocFlow JWT (`iss=docflow`), not a Firebase token. `Session` row revoked/expired also → 401 (`get_current_user`). JWT algorithm: RS256 only if `JWT_PRIVATE_KEY` is set (not containing `PLACEHOLDER`), else HS256 with `SECRET_KEY`. |
| 401 only on `/users/me/sync` or firebase-login | `FIREBASE_PROJECT_ID`/`FIREBASE_CREDENTIALS_JSON` unset (Firebase init is non-fatal at startup, see "Firebase status" log); revocation check needs Google reachability (`FIREBASE_CHECK_REVOKED`, `FIREBASE_REVOCATION_FAIL_CLOSED`); 503 means provider unreachable, not bad credentials (`test_firebase_login_resilience.py`). |
| 403 on an action | Permission snapshot in JWT is stale after a role change (≤120 min; re-login). Check `SYSTEM_ROLES` for the permission. `/approvals/*` requires `approvals:decide` for ALL routes, trainees always 403. |
| "You cannot approve your own document" | Intended; org setting `allow_self_approval`. |
| Workflow stalls with no approvers | Stage rules resolved to nobody: trainee excluded, `dynamic_by_amount_threshold` (unimplemented), `manager_of_requester` with no `Department.head_user_id`, or user lacks `department_id`. Look for `no_approvers_resolved` / `trainee_excluded_from_approvers` logs. |
| CORS / cookie not sent | `CORS_ORIGINS` must include the frontend origin; credentials are on. Refresh cookie is `SameSite=Strict`, path `/api/v1/auth`, `Secure` only in production; use the Vite proxy (`/api` → 127.0.0.1:8000) so requests are same-origin. Vite proxy targets `127.0.0.1` on purpose (IPv6 `localhost` hang). |
| 500 right after pulling code / new column error | Migrations out of sync: `alembic current` vs `alembic heads`, then `alembic upgrade head`. |
| Alembic autogenerate wants to touch everything | Check models are imported in `models/__init__.py` and DB is at head. |
| No real-time updates / notifications | Redis down: helpers degrade silently (`core/redis.py`), `/health/live` reports Redis. WS auth is `?token=` DocFlow JWT (expired token → closed socket). `start_redis_subscriber` runs in lifespan. |
| Emails never arrive | `EMAIL_PROVIDER` (smtp/resend/console), `EMAIL_DELIVERY_MODE=queue` needs a Celery worker on queue `email`; `EMAIL_SYNC_FALLBACK` sends inline when worker/Redis absent. Dev: Mailpit UI :8025. `scripts/check_email_deliverability.py`, `scripts/test_email.py`. |
| Celery tasks not running | Worker must listen on `-Q default,ai,email`; beat schedule is in `celery_app.py`. docker-compose beat uses `django_celery_beat` scheduler which isn't in `requirements.txt` (TODO(verify)). `ai_tasks`/`cleanup_tasks` are stubs. |
| Upload/download URL fails | MinIO/S3 reachable? bucket exists (compose `minio-init`)? `STORAGE_BACKEND`, `MINIO_ENDPOINT`, `S3_BUCKET_*`; MIME allow-list and 50 MB cap in `core/storage.py`. Browser PUT goes straight to MinIO (CORS/endpoint host must be browser-reachable). |
| Upload returns parse error | `Content-Type` must not be forced for `FormData` (`client.ts` handles it). |
| AI Agent / drafts fail | `GET /agent/status` (configured?); `AI_PROVIDER` + matching `*_API_KEY`; TLS errors on corporate network → `SSL_USE_OS_TRUST_STORE` / `AI_CA_BUNDLE` (`core/trust.py`); changing `AI_EMBEDDING_MODEL` leaves old chunks "needs re-embedding". |
| Search/similarity errors | `pg_trgm` extension missing (`scripts/enable_pg_trgm.py`). Embeddings are float arrays, pgvector extension is NOT required by the code. |
| Tests fail to connect/hang | Need local Postgres for `TEST_DATABASE_URL` (conftest creates the DB if missing). Don't point tests at a remote DB (a past run took ~16h over a remote Neon DB, per conftest comment). |
| Route returns wrong/422 for `/documents/<word>` | Literal paths must be declared before `/{doc_id}` (FastAPI order), e.g. `/analytics`, `/ai/*`. |
| Startup refuses to boot in production | `settings.validate_production()` (insecure `SECRET_KEY` etc.). |
| Frontend build fails | `tsc -b` strict flags (`noUnusedLocals`, `erasableSyntaxOnly`); `src/pages/approvals/UI Components` is excluded from tsc but unimported. |
| Frontend shows retry/error screen instead of onboarding | `AuthContext.exchangeError` set: backend down/5xx during exchange; org state unknown by design. |

## Lesson log
Template (copy for each new entry, newest first):
```
### YYYY-MM-DD — <short title>
- Symptom:
- Root cause:
- Fix:
- Files:
- How to prevent:
```

### 2026-10-26 — shadcn token utilities need a Tailwind v4 `@theme inline` bridge
- Symptom: shadcn/Aceternity `components/ui/*` render unstyled; `bg-background`/`bg-card`/`border-border` produce nothing.
- Root cause: canonical tokens (`--background`, `--primary`, …) defined in plain `:root` are NOT registered as Tailwind utilities. Tailwind v4 only generates color utilities from a `@theme` block.
- Fix: `src/index.css` maps each token into `@theme inline { --color-background: var(--background); … }` (inline so utilities follow the `.dark` override). Theme switches via the `.dark` class on `<html>` (set in `App.tsx`), matching `@custom-variant dark (&:is(.dark *))`.
- How to prevent: when adding a new token, add it to `:root`/`.dark` AND to the `@theme inline` block. Inline styles use `color-mix(in srgb, var(--token) N%, transparent)` for tints (no hardcoded hsla). Legacy token names (`--bg-*`, `--text-*`, `--color-primary-*`) are aliases to Ice tokens — don't reintroduce them for new code; use the Ice/shadcn names.

### Seeded from evidence in code comments (undated; each fix is present in code today)
### Shared AsyncSession across tasks broke tests
- Symptom: tests failed with asyncpg "Future attached to a different loop"/task-affinity errors.
- Root cause: one AsyncSession shared between fixtures and requests; `BaseHTTPMiddleware` (`middleware/logging.py`) runs requests in a separate anyio task.
- Fix: commit-and-TRUNCATE isolation with a fresh session per request, `NullPool`.
- Files: `Backend/tests/conftest.py`.
- How to prevent: never share an `AsyncSession`/connection across tasks.

### Accounts: duplicate users/orgs on concurrent sign-in
- Root cause (per `AccountService` docstrings): two sign-in endpoints could disagree/race when resolving the user and org.
- Fix: all user resolution + org creation consolidated in `AccountService` (race-safe, atomic, unique org name); `/users/me/sync` only creates orgs.
- Files: `services/account_service.py`, `services/user_sync_service.py`, migration `e5b2a9d1c3f7`.
- How to prevent: route any new identity logic through `AccountService`.

### Doomed WebSocket reconnect loop on every page load
- Root cause: generic `lib/ws.ts` manager pointed at a URL matching neither backend WS route.
- Fix: removed from `App.tsx`; use `useChatWebSocket` / `useNotificationWebSocket`.
- How to prevent: WS paths are `/ws/chat/{id}` and `/ws/notifications` (no `/api/v1` prefix).

### File upload failed to parse server-side
- Root cause: `client.ts` forced `Content-Type: application/json` on `FormData`.
- Fix: skip the header for `FormData` so the browser sets the multipart boundary.
- Files: `Frontend/src/lib/api/client.ts`.

### Redis outage 500'd unrelated requests
- Fix: `cache_*`/`publish` helpers swallow connection errors (`core/redis.py`).
- How to prevent: Redis is cache/fan-out only; Postgres is source of truth.

### Corporate TLS inspection broke outbound HTTPS (AI calls)
- Fix: `truststore` OS cert store (`core/trust.py`) or `AI_CA_BUNDLE`. Never disable verification.

## UI redesign v2 lessons (non-obvious)
- **Translucent `--card` made flat cards see-through.** v2 defines `--card` as a low-alpha glass color (for
  `.glass-card`/GlassCard with backdrop-blur). The ~1,400 legacy inline cards use `var(--bg-elevated)` **without**
  blur, so they rendered as washed-out transparent boxes. Fix: point legacy `--bg-elevated`/`--bg-card` at the
  opaque `--card-solid`; keep `--glass-bg` on translucent `--card`. Only real glass surfaces are translucent.
- **`approvals-theme.css` was a second design system.** It redefined the entire token set (black `#030213`
  primary, pure-white cards, different radius) inside `.approvals-wrapper`, so the Approvals page ignored the
  global theme. Fix: collapse it to inherit the global tokens; only keep the extra vars (`--input-background`,
  `--switch-background`) the imported components need.
- **`background: \`${var}ee\`` is invalid.** AdminLayout's topbar built `var(--sidebar)ee` to fake opacity — a
  CSS var can't take a hex-alpha suffix, so it produced no background. Use a real token + `backdrop-filter`.
- **A fixed `z-index:-1` background needs a transparent ancestor.** LivingBackground has no background-color;
  if the shell root paints an opaque `background`, it hides the aura. Remove the root bg (the body owns
  `--background`) and let glass surfaces sit above.
- **Tailwind v4 + GSAP:** register `useGSAP`/`Flip` once in `main.tsx` via `gsap.registerPlugin`; animate only
  transform/opacity; never animate `blur`/`filter` (the LivingBackground drift moves blurred blobs, not the blur).
- **Blue box on a pipeline label ("Pending"):** it was the **browser text-selecting** the stage label (the
  label text was selectable), not a leaked class or focus style. Fixed with `user-select:none` on pipeline
  chips/labels + a themed `::selection` rule in `index.css`. (A fixed palm-tree icon at bottom-right is a
  **browser extension**, not app code — `grep` finds no such asset in `src/`.)
- **Dashboard duplication / mismatched counts:** route every count through the one `useDashboardData` hook and
  keep each fact to a single widget (see DESIGN.md §13). The old dashboard showed the same status in a
  "Document Status" card, the pipeline, the KPI row and "Pending Review" — four places that could disagree.

Older audit history (bugs fixed before this log) lives in `AUDIT/CHANGELOG.md` and `AUDIT/AUDIT_REPORT.md`; those files are partly outdated, so re-verify before relying on them.

## How to use this when asked to…
- **Debug an error:** match the symptom to the table above, then confirm with logs (`request_id` from the error body / `X-Request-ID` header ties frontend errors to backend logs).
- **Record a lesson:** only for non-obvious causes; fill the template; keep it to five lines.
- **Triage "works on my machine":** check env vars (names in `ARCHITECTURE.md`), migration head, Redis/Postgres/MinIO reachability (`/health/live`), and which processes are running (API, worker, beat).
