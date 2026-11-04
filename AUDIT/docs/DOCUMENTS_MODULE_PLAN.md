# Documents Module — build plan & status

> Source spec: `module doc/Documents_Module_Requirements_Specification_v2.docx` (1299 lines).
> Engagement: implement across 3–4 turns, fully complete + verified per slice.
> Design foundation: v2 "Ice Pearl" system in `DESIGN.md` (reuse tokens/primitives).

## Locked decisions
- Build **Foundation (Phase 1) first**, then Template Studio (2), AI (3), Integration (4).
- **New deps approved (exact):** @tiptap/react, @tiptap/pm, @tiptap/starter-kit `3.32.0`;
  react-resizable-panels `4.15.0`; @dnd-kit/core `6.3.1`; @dnd-kit/sortable `10.0.0`; idb `8.0.4`.
  (TipTap resolved to 3.x — current stable, first-class React 19 support.) No other deps without asking.
- **Full-stack with Alembic migration** is in scope.
- **Reuse** the server-side `app/services/ai_document_service.py` (Gemini) for AI; key stays server-side.

## Phase 1 — Foundation: status

### Done (turn 1) — `vite build` green; backend AST + ruff checked (no new findings)
- **Backend migration** `alembic/versions/20261027_1200_f1a2b3c4d5e6_documents_foundation.py`:
  adds `documents.source` / `confidentiality` / `current_step` / `version` + two composite
  indexes (owner+status+updated, owner+due). **Must be applied** (see command below).
- **Autosave + optimistic locking**: `PATCH /documents/{id}` honours `If-Match: <version>` →
  409 `VERSION_CONFLICT`; bumps `version`; lenient draft validation; snapshot throttled to ≤1/5 min
  (manual saves unchanged). `list` gains `sort=<field>:<asc|desc>`. Response carries the new fields.
- **Frontend data layer**: `useAutosave` (debounce 1.5 s / 10 s max-wait, single-flight, backoff,
  offline + idb backup, tab-hide flush), `lib/offline/draftCache.ts` (idb), `autosaveDocument`
  API, `keepPreviousData` on the list, `useDocumentAnalytics` for tab counts.
- **Premium list** `/documents`: URL-synced filters (shareable/back-safe), debounced search (300 ms),
  status tabs w/ counts, type/dept/priority filters, filter chips + Clear all, sortable headers,
  density toggle (persisted), due-date severity, relative time + exact tooltip, drafts Continue,
  bulk delete, result summary + page size, skeleton / empty / no-match / error states.
- **New Document hub** `/documents/new`: 3 action cards (template / upload / blank) + template
  gallery (search, category chips, sort, favourites, tabs All/Recent/Favourites) + hover/focus
  quick-look with prefetch. Existing create/upload/blank + Step-2 form preserved.

### Done (turn 2) — `vite build` to be re-confirmed (shell tooling was intermittently unavailable)
- **Upload**: `UploadDropzone` state machine (idle/drag-over/validating/uploading/processing/
  success/error) with real byte progress (XHR to presigned URL), cancel/retry; `/documents/new/upload`
  page creates an UPLOAD-source draft + attaches the file.
- **Blank**: `/documents/new/blank` shared-element expand + immediate draft creation (source=blank).
- **Submission wizard** `/documents/:id/submit`: `Stepper` (Review → Workflow → Details → Confirm),
  details **autosaved** via `useAutosave` (If-Match), `SaveIndicator`, workflow select reusing
  `useWorkflowTemplates`/`useWorkflowTemplateReview`, final-review cards + confirm checkbox,
  idempotent (single-flight) submit through the existing submit endpoint.
- **Conflict dialog** (§24.3): `ConflictDialog` wired to `useAutosave.onConflict` (Keep mine / Load latest).
- Hub action cards now route to the new upload/blank pages; "Continue to submit" → the wizard.
- New shared components: `Stepper`, `SaveIndicator`, `ConflictDialog`.

### Pending (Phase 1 polish)
- Wire `useAutosave` into the document **detail/edit** surface too (currently only the wizard).
- Dedicated `documents/new/from-template/:id` route (template → inline Step-2 form works today).
- Retire the detail page's `SubmitWorkflowModal` once the wizard fully supersedes it.

## Turn 3 — runtime bug fixes + Phase 2 backend

### Root causes found and fixed
- **Template card did nothing** — `TemplateCard` had no handler on the card body; only the
  hover quick-look's button called `onUse`, so it was unreachable without hover (and entirely
  unreachable by keyboard/touch). Card is now `role="button"`, click + Enter/Space → use template;
  star and overlay button `stopPropagation`. A 0-field type works (empty schema validates clean).
- **Draft "Continue" didn't restore the step** — the list passed `state.resume`, which no page read.
  Continue now routes to `/documents/:id/submit` when `current_step` is a wizard step, and the
  wizard resumes at that step (FR-1.9 / FR-14.5).
- **Gallery pick mislabelled** — a 0-field template was saved as `source='blank'`; now `'template'`.
- **idb drafts survived logout** — added `clearAllDraftsLocal()`, called from `useLogout`/`useLogoutAll`.
- **Submit idempotency is now real server-side** — `POST /documents/:id/submit` accepts
  `Idempotency-Key`; a replay returns the already-submitted document instead of 409 (Redis-backed,
  24 h TTL, recorded only after commit). Wizard sends a per-mount UUID.
- **Upload/Blank "redirect to dashboard"** — NOT a code defect. Route resolution was verified with
  react-router's `matchRoutes`: `/documents/new/upload` → `UploadDocPage`, `/documents/new/blank`
  → `BlankDocPage`; the catch-all never wins. The symptom (only the two turn-2 routes failing) is a
  stale running bundle — restart the dev server.

### Confirmed (audited, not changed)
- **CORS**: `allow_headers=["*"]` already permits `If-Match` / `Idempotency-Key`; in dev the Vite
  proxy makes it same-origin anyway. No change needed.
- **Owner check before version compare**: `update_document` fetches → `can_user_access_document`
  (403) → *then* compares `If-Match`. Correct order; a non-owner never learns the version.

## Phase 2 — Template Studio: status
### Backend scaffolding done (migration NOT applied — review first)
- Models `app/models/template.py`: `Template`, `TemplateVersion`, `TemplateField`,
  `PlaceholderOccurrence` (registered in `models/__init__.py`; mappers configure cleanly).
- Migration `alembic/versions/20261027_1600_a7b8c9d0e1f2_template_studio_tables.py` — **ADDITIVE
  ONLY** (4 new tables + indexes; no existing table touched). Chained off `f1a2b3c4d5e6`.
  **Apply when ready:** `cd Backend && .venv\Scripts\alembic.exe upgrade head` (expect head
  `a7b8c9d0e1f2`). Nothing references these tables yet, so applying is safe and reversible
  (`downgrade` drops them).
### Backend CRUD + publish — DONE (turn 3)
`schemas/template.py`, `repositories/template_repo.py`, `services/template_studio_service.py`,
`routers/templates.py` (mounted at `/api/v1/templates`). Eight endpoints: list · create · detail ·
PATCH autosave · publish-check · publish · duplicate · delete.
Rules implemented: visibility/IDOR → **404 not 403**; per-user quota (50) + case-insensitive unique
name with `Name (2)` suggestion; **editing a PUBLISHED template starts a new draft version** so
existing documents stay pinned (FR-11.5 / C9); publish checklist (name, ≥1 field, every field has
label+type, no duplicate keys) exposed as data via `GET /templates/{id}/publish-check` so the UI can
render it live, and enforced on publish.
**Requires migration `a7b8c9d0e1f2` to be applied before these endpoints will work.**

### Frontend wired (turn 4)
`lib/api/templates.ts` + `hooks/useTemplates.ts` (all 8 endpoints) · Studio entry
`/documents/templates/new` · `My templates /documents/templates/mine` (quota meter, duplicate,
delete, states) · **TipTap editor** `/documents/templates/:id/edit` with the structured
placeholder node (`PlaceholderNode.ts`), scanner/normaliser (`placeholderScanner.ts`:
stable ids, duplicate-id repair on paste, 1..N numbering, "N blanks, M unique fields"),
field-config panel, autosave, and the live server publish checklist gating "Create template".
Hub gallery header now links to both Studio entries (FR-2.4).

**Migration `b1c2d3e4f5a6`** (additive: `documents.template_version_id` + FK + partial index)
is written but **NOT applied**, and the ORM deliberately does **not** map the column yet —
mapping it before applying would break every document SELECT. Map it in the same change that
wires Form Fill, after applying.

### Turn 5 — Blank & Upload corrected to spec
Both flows previously dead-ended on the old schema-form detail page.
- **Blank (C12 / FR-3.4 / §19 screen 4)** now opens a real freeform authoring surface:
  `/documents/:id/edit` (`DocumentEditorPage`) — same TipTap editor as Template Studio via the
  new shared `EditorToolbar`, **without** the placeholder node (a blank document has no blanks),
  cursor placed in the first line, title + body autosave, locked banner for non-drafts, then
  **Continue → the wizard** (joins at Workflow, per C12).
- **Upload (C4 / §7.4 Flow C / §19 screen 3)** is now a **modal** that slides down from the top:
  dropzone → **file summary card → Continue bar** → creates the UPLOAD-source draft with the file
  attached and goes **straight to the wizard** (`current_step='workflow'`). Focus trap, Esc,
  guarded click-outside, `aria-modal` + labelled title, reduced-motion = fade, responsive.
  `/documents/new/upload` is kept as a deep link rendering the hub with the modal open; closing
  returns to `/documents/new`. `UploadDocPage` deleted.
  **Hub upload does NOT need Phase 3** — AI import belongs to Template Studio (C4, §8.9).
- **Body storage**: spec §9 `DocumentContent` added as table `document_contents` + `GET/PATCH
  /documents/{id}/content` (submitted documents are locked). Migration **c3d4e5f6a7b8** (additive).
- Detail page attachment picker restyled onto the design system (was a raw browser file input).

## Turn 6 — PART 1 (hub card) + PART 2 (Phase 2 completion)

### PART 1 — "Start from a template" did nothing visible
Spec (§18 Point 2) defines the card as "scrolls to the gallery" and nothing more; with the
gallery already in the viewport that scroll is a no-op, so the click read as dead. The earlier
trace passed it because the criterion was "does the handler reach its target", not "does the
user perceive a result". Fixed: the card resets the gallery to All + no category, scrolls,
spotlights the gallery for 1.4 s (`.gallery-spotlight` — an `outline`, so no layout shift; a
static ring under reduced motion) and moves focus into the search box (or "Create your own
template" when the gallery is empty), with an `sr-only` live-region announcement.
Also fixed the gallery card's invalid ARIA: it was a `div[role=button]` wrapping two real
buttons; it is now the stretched-link pattern (`.card-stretch::after`).

### PART 2 — completed
**Backend**
- `documents.template_version_id` MAPPED on the ORM (migration `b1c2d3e4f5a6` is applied) and
  pinned on create: `POST /documents` accepts `template_id`, the server resolves the template's
  CURRENT PUBLISHED version, pins it, seeds `DocumentContent.content` and increments
  `usage_count` (C9 / FR-11.5 / FR-2.5). The client never names a version id.
- `GET /documents/{id}/fill-schema` — Form Fill's questions read from the PINNED version,
  bypassing template visibility (the document was already authorised) so filling survives the
  template being archived or deleted; reports `template_deleted`.
- `POST /documents/{id}/save-as-template` (FR-5.4).
- Favourites: `template_favourites` table + `PUT/DELETE /templates/{id}/favourite`,
  `is_favourite` on every response, `favourites_only` filtered in-query.
- Archive: `POST /templates/{id}/archive` + `/unarchive`, `include_archived`; archived templates
  free a quota slot and are refused by `pin_published_version`.
- Gallery query gains `published_only` and `sort=recent|most_used|az` (FR-2.3);
  publish metadata extended with `icon`/`color` (FR-11.3).
- **Server-side sanitisation** (`app/services/content_sanitizer.py`): an allow-list over the
  editor JSON (node types, mark types, per-attribute, safe URL schemes, forced
  `rel="noopener noreferrer nofollow"`, depth/node/character limits) on every template and
  document content write, plus `content_to_text` for FTS. No new dependency — the body is JSON,
  not HTML, so an allow-list over named nodes is simpler and stricter than HTML scrubbing.

**Frontend**
- **Gallery shows real published Templates** beside DocumentTypes, normalised into one
  `GalleryItem`: tabs All / Organisation / My templates / Recent / Favourites, sort
  Most used / Newest / A–Z, ownership badge, real usage counts, server-backed favourites.
- **Form Fill** `/documents/:id/fill` (+ `/documents/new/from-template/:templateId`): resizable
  split view, live document left, "Question k of N" right, click-a-blank to jump to its question,
  linked placeholders filling together, per-type inputs + validation, Enter/Shift+Enter, overview
  with "Fix n issues", answers autosaved.
- **`SplitPane`** on react-resizable-panels **v4** (`Group`/`Panel`/`Separator`), layout persisted,
  stacking to a sticky collapsible mini-preview below 1024 px (FR-8.7).
- **Template Studio** is now spec flow A: Write → Questions → Preview & publish, with the split
  view, the full FR-7.7 property set, link/unlink of individual occurrences, and a preview with
  **Blank** and **Try-it (sample data)** modes plus the publish metadata form.
- **Editor depth**: underline, blockquote, code block, horizontal rule, clear formatting, link
  insert/remove with scheme normalisation — all from starter-kit, no new dependency.
- **Code-split** (FR-6.8 / FR-15.5): the three editor routes and the preview are lazy; TipTap +
  ProseMirror moved into a ~400 kB async chunk and the main bundle fell 1,655 kB → 1,250 kB
  (gzip 458 → 329 kB).
- **My templates**: favourite, archive/restore, "Show archived"; quota counts active only.
- **Detail page**: draft editing autosaves (FR-14.1) with indicator + conflict dialog —
  deliberately NOT on `sent_back`, where Save also runs revise-and-resume and autosaving would
  resubmit on every keystroke; plus "Save as template".
- **Documents list**: column show/hide/reorder (dnd-kit, persisted, reconciled on load).
- **Submit wizard** review step renders the real document with answers, replacing the old
  "arrives in Phase 2" note.

### Deliberate gaps (not "missing")
- **DocumentType favourites stay in localStorage.** Favourites are a Template feature in the spec
  (FR-5.3); DocumentTypes have no favourite table and adding one is not in the spec. The star is
  kept on those cards so existing behaviour is not lost ("saved on this device").
- **Tables and images in the editor** (part of FR-6.1 Insert) need `@tiptap/extension-table` and
  `-image` — not installed, not added; needs a dependency decision.
- `@dnd-kit/modifiers` is likewise not installed; the column reorder works without it.

### Still to do (Phase 2)
- TipTap editor + stable-id placeholder node + scanner/linking (N blanks, M unique fields).
- Field-config split view — build `SplitPane` on react-resizable-panels **v4** (`Group`/`Panel`/`Separator`).
- Preview + publish UI (blank / try-it modes, checklist card).
- Form Fill pinned to `template_version_id`; `documents.template_version_id` column (needs a further
  additive migration) + create-from-template wiring.
- Frontend API client/hooks for the 8 template endpoints.

## Deferred / "needs backend" (not built — no data or later phase)
- **Row action "Duplicate"** (FR-1.8): no document-duplicate endpoint → omitted (needs backend).
- **Column show/hide/reorder/resize** (FR-1.8, *Should*): deferred; density shipped. dnd-kit installed for it + Phase 2 field reorder.
- **`SplitPane`** (react-resizable-panels): deferred to Phase 2 — v4 is a grid-rewrite (`Group`/`Panel`/`Separator`); build it with the real split view so resize can be tested live. Dep stays installed.
- **Server-side submit idempotency** (FR-13.7): client guards double-fire; an `Idempotency-Key` guard on `POST /documents/:id/submit` is a backend follow-up.
- **Keyset/cursor pagination** (FR-1.4): offset pagination for now (list API is page/limit).
- **"My templates" / "Organisation" gallery tabs** (FR-2.3): need USER/SYSTEM template scope → Phase 2.
  Gallery currently uses org DocumentTypes with real tabs (All/Recent/Favourites).
- **Est. fill time** shown as a labelled estimate derived from field count (not stored data).
- **Stat strip removed** from the list: duplicated the dashboard and showed fabricated trend deltas
  (violates "no fake data"); counts now come from the real `/documents/analytics` aggregate.

## How to apply the migration (user runs this)
```
cd Backend
.venv\Scripts\alembic.exe upgrade head
.venv\Scripts\alembic.exe current   # expect d5e6f7a8b9c0 (single head)
```
Applied so far: `f1a2b3c4d5e6`, `a7b8c9d0e1f2`, `b1c2d3e4f5a6`, `c3d4e5f6a7b8`.
**Pending: `d5e6f7a8b9c0` (template_favourites — additive, one new table).** The gallery
reads favourites on every template list, so this must be applied before templates load.

## Pre-existing errors (NOT touched — unchanged by this work)
Frontend `tsc -b`: analytics.ts, syncProfile.ts, WorkflowsPage.tsx, AuthContext.tsx,
WorkflowBuilderModal.tsx (9 errors total). Backend ruff: pre-existing F401/F821 in
document models/service/repo (string relationships + unused imports). No new errors introduced.

---

## Turn 7 — confirmations, AV, retention, PART 3 (AI)

### Pending migration (additive): `e7f8a9b0c1d2`
`ai_interactions` table + `users.ai_opt_out` (boolean, server_default false).
Run `.venv\Scripts\alembic.exe upgrade head`. Single head confirmed.

### Three confirmations requested
1. **Sanitizer blocks `javascript:` / `data:`** — yes. `_SAFE_URL` is an
   allow-list (`https?:|mailto:|tel:|/|#`), so hostile schemes cannot match.
   Images now carry **no `src` at all**: an `image` node stores `assetId`
   (a FileAsset uuid) and the viewer resolves it through an authorised
   endpoint. Verified by direct probe of 9 payloads.
2. **Pinning survives re-publish** — yes. `_editable_version()` copies a
   published version into a NEW row before any edit, so re-publishing moves
   `current_version_id` forward while existing documents keep their
   `template_version_id`.
3. **Submitted-document immutability** — a real gap was found and closed.
   `save_content` blocked non-drafts but `update_document` had **no status
   check at all**, so a submitted document's title/form_data/tags/priority
   were still editable. Added `EDITABLE_STATUSES` (DRAFT, READY, SENT_BACK)
   and `_require_editable()` on both paths. FR-13.8 snapshot implemented:
   `submitter_snapshot` now freezes title, form_data, body content, answers
   and the pinned template version, with a SHA-256 checksum; `get_content`
   serves the snapshot for locked documents.

### Upload safety — Option C
`app/services/antivirus.py`: `AntivirusScanner` protocol,
`StructuralScanner` (default), `ClamAVScanner` (INSTREAM over TCP, behind
`AV_SCANNER=clamav`), `DisabledScanner`. Scans in `/files/confirm-upload`.
**Honest labels**: `SCAN_LABELS` is the only wording the UI may use;
"Virus scan passed" is reachable **only** from `ScanStatus.CLEAN`, which only
a real scanner returns. Structural returns CHECKED → "File checked".

### Draft retention purge
`app/workers/cleanup_tasks.py` — dry-run by default
(`DRAFT_RETENTION_DRY_RUN=True`), soft-delete only, configurable days/batch,
one `audit_logs` row per org per pass including dry runs and empty passes.

### PART 3 — AI
Service `ai_assist_service.py` with four touchpoints (field suggestion,
blank detection, rewrite, review) behind one governance layer: server-side
key, per-user daily quota (count over `ai_interactions`), org switch
(`organizations.settings.ai_enabled`) and user switch (`users.ai_opt_out`),
25 s timeout, untrusted-text fencing, minimal-text budgets, accept/reject
recorded. Router `/api/v1/ai/*`. UI: `ConfidenceBadge`, `AIRewriteDialog`
(word-level LCS diff), `AIBlankDetectPanel`, `AIReviewPanel`,
`AISettingsSection`.

---

## Turn 8 — FR-13.8 PDF, export, reorder, version restore

### Pending migrations (additive, in order)
| Rev | Adds |
|---|---|
| `f9a0b1c2d3e4` | `document_contents.pdf_status / pdf_checksum / pdf_rendered_at / pdf_error` |
| `c7d8e9f0a1b2` | `documents.category / effective_from / expires_at / reminder_days_before / reminder_sent_at`, partial index `idx_document_expiry_due`, table `document_watchers` |

`alembic heads` → `c7d8e9f0a1b2` (single). Note: the first draft of the second
migration reused revision id `a1b2c3d4e5f6`, which already belonged to
`20260926_1800_..._org_extended_profile.py`; alembic reported `CycleDetected`
until it was renamed. Check `grep -r "revision: str" alembic/versions/` before
choosing an id.

### Answers to the three questions
1. **Org AI switch now defaults OFF.** `_ensure_enabled` changed from
   `settings.get("ai_enabled") is False` to `not settings.get("ai_enabled")`,
   so AI stays dark until an admin enables it in Settings → AI assistance.
2. **No workflow/approval path uses `update_document`.** All eleven status
   transitions in `approval_service` and `workflow_service` assign
   `doc.status` on the ORM object directly. `EDITABLE_STATUSES` gates only the
   user-facing `PATCH /documents/{id}`, so nothing in the approval chain is
   affected.
3. **`deleted_at` is filtered everywhere checked**: list + count (shared
   subquery), `get_by_id`, search (`search_service:143`), and every analytics
   breakdown (all derive from one `base` select that filters it).
   **The retention job was scheduled but could never run** — the celery-beat
   container's command named `django_celery_beat.schedulers:DatabaseScheduler`,
   a Django package absent from this project, so beat crash-looped and NOTHING
   on `beat_schedule` fired (SLA checks, embedding refresh, retention).
   Switched to Celery's own PersistentScheduler.

### Dependencies added (approved)
- `reportlab==4.2.5` (pinned) — pure Python, no system packages.
- **Noto Sans** 4 faces in `app/assets/fonts/`, SIL OFL 1.1 (`OFL.txt` +
  `README.md` committed). reportlab's bundled Vera was rejected: 283 glyphs,
  no ₹, no Greek, no Cyrillic. Noto Sans has 2,965 glyphs incl. ₹.
- DOCX export needed nothing new — `python-docx==1.1.2` was already declared.

### (a) FR-13.8 — done
`pdf_renderer.py` renders the FROZEN snapshot only. Deterministic
(`invariant=1` + creation date pinned to `submitted_at`), so the stored
SHA-256 can be re-derived and the PDF proven to match the snapshot. All user
text escaped before reaching `Paragraph`. Async via
`workers/pdf_tasks.py`; states Preparing / Download / Retry in
`SnapshotPdfCard`. Unrenderable glyphs become a visible □ and are logged.

### (c) partially — export done, editor canvas not
`docx_renderer.py` + `GET /documents/{id}/export?format=pdf|docx`.
A submitted document exports its snapshot; a draft exports live content and is
watermarked DRAFT. FR-6.4 headers/footers exist in both outputs (real
PAGE/NUMPAGES fields in DOCX). FR-6.6 find/replace in both editors (Ctrl+F);
blanks are never matched, so replacing text cannot delete a question.
**Still open: FR-6.2 paged canvas / page count in the EDITOR.**

### (d) FR-8.6 — done. Backend already supported it (`order_index`,
`section` were on `TemplateField` and in `FIELD_COLUMNS`); only the UI was
missing. `QuestionReorderList` (dnd-kit), one state update per drag.

### (e) FR-14.8 — done. Restore COPIES a version forward into the working
draft rather than rewinding, so documents pinned to older versions keep
working (C9) and the restore is itself visible in the history.

### Not started
(b) FR-13.4 — migration written, blocked on applying it (mapping those
columns early would break every document read). (f) thumbnails + keyset
pagination. FR-6.2 paged canvas.

---

## Turn 9 — FR-13.4 submission details, FR-6.2 paged canvas, thumbnails, keyset pagination

Migrations `f9a0b1c2d3e4` and `c7d8e9f0a1b2` were applied before this turn, so
the deferred-mapping workarounds could be retired and the five `documents`
columns mapped on the ORM normally.

### FR-13.4 — submission details
- `Document` now maps `category`, `effective_from`, `expires_at`,
  `reminder_days_before`, `reminder_sent_at`; new `DocumentWatcher` model.
- `clear_fields` on `PATCH /documents/{id}`: a partial update cannot express
  "remove this date", because an omitted field and a null field look the same.
  The clearable set is a closed allow-list in BOTH the schema layer and the
  repository, so a request body can never null out `status` or an id.
- `reminder_sent_at` is server-only. It is stamped by the sweep and cleared
  automatically when the expiry date or notice period changes — otherwise a
  rescheduled expiry would never be announced. A client asking to clear it is
  ignored, since that would let anyone re-trigger reminder emails.
- Watchers: `GET/POST/DELETE /documents/{id}/watchers` plus
  `GET /documents/{id}/watcher-candidates`. Only the owner or an admin changes
  the list; anyone may remove themselves. Re-adding someone revives the
  soft-deleted row rather than violating `uq_document_watcher`.
- A watcher gets notifications only. The workflow engine never reads this
  table, and being CC'd grants no access — `can_user_access_document` is
  untouched. The UI says so, because "CC" normally implies access.
- New worker `app/workers/reminder_tasks.py`, daily at 07:00 UTC. Sends once
  (stamp in the same transaction), still sends if it was late, skips documents
  that already expired, never changes `status` (that belongs to the workflow
  module), and audits every pass including empty ones.

### FR-1.4 — keyset pagination
- `encode_cursor` / `decode_cursor` / `_after_cursor` in `document_repo.py`.
  The count is skipped on a cursor request and returned as -1 ("not counted"),
  which the client replaces with the total it already has.
- The offset path is retained, so a bookmarked `?page=N` still works; the
  pager switches to cursors as soon as it is used.
- Front end keeps the cursor stack in component state, not the URL: filters
  are worth sharing, a long opaque cursor is not.

### FR-6.2 — paged canvas
`PagedCanvas` draws page-break guides at the chosen page size and reports the
page count for the status bar. Opt-in via a "Page view" toggle. Labelled
"approx." on purpose: ReportLab decides the real pagination at export, and
claiming exact agreement would be a promise this cannot keep.

### FR-4.1/4.3 — thumbnails
`TemplateThumbnail` renders a real miniature of the template's own first page
from the stored editor JSON, scaled with a CSS transform. A server-rendered
raster would need a rasteriser (new dependency), so `thumbnail_url` stays
unused for now. Mounted only while the quick-look is open, reusing its
existing prefetch, so nothing loads until a card is hovered or focused. A
DocumentType gets an honest "form with N questions" panel instead of a fake
page.

### Bugs found while building
1. **`User` has no `org_id`.** Org membership is `organization_members`. The
   first draft of the watcher candidate query and the `add_watcher` org check
   both read `User.org_id`, which would have raised `AttributeError` on every
   call. Found by running the service against the real database, not by
   tsc/ruff/import checks — all of which passed. Both now join through
   `organization_members` with `status = 'active'`.
2. **Enum cursor corruption.** `str(DocumentStatus.DRAFT)` is
   `"DocumentStatus.DRAFT"`, not `"draft"`, so sorting by status would have
   produced a cursor that matched no row and silently ended the list.
   `encode_cursor` now unwraps `Enum.value`.
3. **NULLs in keyset predicates.** A tuple comparison against NULL yields
   NULL, so paging by the nullable `due_at` would have returned an empty page
   that looked like the end of the list. Both directions use NULLS LAST with
   an explicit null branch. Worth noting: the first test of this passed only
   because every row happened to have `due_at` NULL — the boundary was never
   crossed until a 50/50 mix was forced.

---

## Day 1 (3-day sprint) — FR-9 document import

The "Import an existing document" card was a dead, disabled tile. It is now a
working pipeline: upload -> convert -> sanitize -> detect -> review -> template.

New: `models/import_job.py`, `services/document_importer.py`,
`services/blank_detector.py`, `services/import_service.py`,
`workers/import_tasks.py`, `routers/imports.py`, `schemas/import_job.py`,
migration `d1e2f3a4b5c6` (import_jobs), plus the frontend
`ImportTemplatePage` + `ImportDocumentPanel` + `lib/api/imports.ts` +
`hooks/useImports.ts`.

### Decisions
- **DOCX keeps structure, PDF does not, and the UI says so.** A PDF records
  glyphs at coordinates, not meaning; guessing headings and tables from that
  would produce a document that looks right and is structurally wrong.
- **The LLM pass is opt-in and off by default**, hidden when the org AI switch
  is off. The rule pass always runs and never leaves the server.
- **Detections are spans, never replacement text.** This is what makes FR-9.4
  provable: after applying, the text outside the replaced spans is re-derived
  and compared, and a mismatch refuses the whole apply.
- **The server matches a detection by its stored span.** Only label/key/type
  are client-editable. A hand-marked span ("Make blank") is accepted but
  bounds-checked, and its `original` is read from the server's own copy.
- **Overlapping spans are deduplicated, first wins** — two blanks over the
  same text would corrupt the replacement.
- An import is private to its creator: another member of the same org gets
  404, because the job holds the full text of an unshared document.
- Blanks sharing a label share a key, so FR-7.4 linked placeholders fall out
  of detection for free.
- `validation.visible_when` / `validation.repeat_group` are reserved on the
  field model for FR-7.10. Unread today; no migration needed to add it later.

### Defects found and fixed in my own work
1. Label lookback crossed line breaks ("MENT AGREEMENT agreement made").
2. `Monthly Salary (INR):` defeated the label regex -> anonymous `field_1`.
3. Table-cell blanks lost their row label, because the cell's paragraph emits
   a newline before the cell's tab. Fixed by stripping trailing separators
   before cutting at the newline.
4. No task timeout: a hung conversion left the job `extracting` forever and
   the UI polling forever. Now soft 120s / hard 180s.

### Still open in FR-9
- FR-9.7 side-by-side view of the original file (warnings are done).
- FR-9.9 encryption at rest -> deployment checklist, not code.
- OCR for scanned PDFs (Could) — deferred.

---

## Day 2 (3-day sprint)

No migration. One config key (`EMPTY_DRAFT_RETENTION_HOURS`), one new beat
entry, so the worker needs a restart but the database does not change.

| Item | What landed |
|---|---|
| FR-6.6 | `OutlinePane` — headings read from the ProseMirror doc (not the DOM), click to jump, caret-aware highlight. Toggled from the status bar in both editors. |
| FR-14.9 | "Discard draft" on the detail page (soft delete, confirm dialog) + hourly `purge_empty_drafts` task. |
| FR-12.4 | **Already done** — `FormFillPage` had Enter/Shift+Enter, and radios/selects are native so arrow keys work. My earlier table was wrong. |
| FR-13.5 | `/ai/suggest-details` + `AISuggestDetails`. Opt-in, per-field Use buttons, nothing auto-applied. |
| FR-13.6 | Review card gains a real first-page miniature and "Open full preview" (reuses the lazy `DocumentPreview`). |
| FR-1.2 | Owner / workflow / created-date-range filters, URL-synced, with chips. Workflow filter uses EXISTS. |
| FR-6.4 | `pasteCleaner` — strips Word's `mso-*`, `MsoNormal`, `<o:p>`, conditional comments, inline styles; keeps structure. |
| FR-10.5 | A rewrite that loses or duplicates a `{{token}}` is retried once, then **blocked** — shown but not applicable. |

### Decisions
- **Empty-draft purge is strict on purpose.** A draft counts as empty only if
  it has no form data, no answers, no body text, no attachments AND still has
  its default "Untitled…" title. Deleting a draft someone was still writing
  would be unforgivable, so the test errs heavily toward keeping.
- **A damaged rewrite is blocked, not repaired.** There is no safe automatic
  repair: we cannot know where in the new wording a dropped token belonged.
  The server retries once with the rule restated, then gives up and disables
  Accept.
- **Workflow filter uses EXISTS, not a join** — a document can have several
  instances over its life, and a join would return it once per instance.
- **`description` lives in `metadata`**, so FR-13.5's description suggestion
  had somewhere to go without a migration. It also closes a small FR-13.4 gap.
- `ContentMiniature` was extracted so the review thumbnail and the template
  card thumbnail share one renderer instead of duplicating 100 lines.

### Verified live
Empty-draft purge both ways (catches a planted empty draft 1-of-8, keeps all 7
real ones, deletes nothing in dry-run); workflow filter 9 rows with no false
positives and no duplicates; date-range narrowing on 17 real documents;
FR-13.5 degrading to a readable 503 when the org AI switch is off.

**Caught:** the first run of the filter checks passed *vacuously* ("0 of 0")
because it picked an org with no documents. Re-pointed at a populated org.
Same class of mistake as the `due_at` NULL test on Day 0 — a filter test
against an empty set always passes.

### Not verified at runtime
`pasteCleaner` needs a DOM, so it is covered by build + review only; paste
from Word is in the click-test instead.

### Day 2 — re-check and gap closure

A second pass against the spec found six things the first report had called
done. All now closed:

1. **FR-13.6** Workflow card showed "N stages", not the stage timeline the
   spec asks for. Now a numbered list with approver and SLA per stage.
2. **FR-14.9** No prior notice before the long purge (spec §24 wants 7 days).
   Added `send_retention_notices`, daily at 02:30, half an hour before the
   purge. Marker lives in `documents.metadata` — no migration.
3. **FR-14.9** `DRAFT_RETENTION_DAYS` defaulted to 180; the spec says 90.
   Default changed so shipped behaviour matches the written policy.
4. **FR-14.9** "Discard draft is ALWAYS available" — it was only on the
   detail page. Added to the draft editor's status bar too.
5. **FR-1.2** The owner filter only offered "Anyone / My documents". Now a
   real colleague list via `GET /chat/members`, which is the one member list
   every user may read (the admin endpoint needs `admin:users`). Filtering
   does not widen what anyone can see — access rules are unchanged.
6. **FR-6.4** Native spell-check was never set explicitly; it worked only by
   browser default. Now `spellcheck: 'true'` in editorProps.

### The bug worth remembering

`BaseModel.updated_at` has `onupdate=utcnow`, and the retention purge measures
age from `updated_at`. Stamping "we warned this owner" through the ORM
therefore **reset the 90-day purge clock** — a warned draft would be warned
again months later and never actually purged. The notice now writes with a
Core UPDATE that restates the existing `updated_at`, overriding the column
default. Found by a positive test, not by review.

Verified live, with the notification stubbed so nothing reached a real person:
warned once at 85 days quiet, clock intact, not warned twice, a marker older
than the last edit re-warns, past the cutoff is left to the purge, a recently
edited draft is untouched.

**Also:** two earlier crashed test runs left `d7d3fec2` and `7637e391` with a
fake 85-day-old `updated_at` and a stray marker. Both repaired
(`updated_at = created_at`, marker removed) and re-checked: 8 drafts, 0
disturbed. Lesson: a verification script that mutates real rows must restore
in a `finally`, not at the end of the happy path.

---

## Day-2 click-test defects B–E (closed before Day 3)

### B — "Create from scratch" took several seconds

Measured separately, as asked, against the live (remote) database:

| Part | Before | After |
|---|---|---|
| `POST /templates`, SELECTs | 8 (`count_owned`, one `name_exists` per name collision, 4 in `_to_detail`) | 1 |
| `_to_detail` after create | 2099 ms of guaranteed-empty queries | removed |
| Editor chunk | 14 kB gz page + 146 kB gz shared TipTap chunk, downloaded **after** the POST returned | preloaded on hover/focus, in parallel |
| What the author waits for | all of it | nothing — the editor frame renders on click |

Changes: `TemplateRepository.owned_name_rows` answers the quota and every
name-collision probe in one query; `create_with_version` inserts the template
and its first version in one flush; `create_template` builds its response
directly instead of re-reading fields, occurrences and favourites that cannot
exist yet.

**Remaining, and not application logic:** the three statements that are left
still cost ~3.1 s, of which a single `INSERT INTO templates` is ~2.2 s. The
table has 3 rows, 3 indexes and no triggers, and a bare `SELECT 1` on the same
connection costs 256 ms — this is round-trip latency to a remote Postgres, not
query cost. On a local or low-latency database the same path is tens of
milliseconds. Worth raising with whoever owns the database host.

### C — the "Preparing your blank document…" page is gone

The hub's Blank card now creates the draft in the background and renders
`<EditorSkeleton />` immediately. `/documents/new/blank` is kept purely as a
redirect for old links and does the same thing. Shared logic:
`useStartBlankDocument` / `useStartScratchTemplate` in `hooks/useStartDraft.ts`.

### D — the template editor

1. **Pasted `___` becomes a real blank.** A ProseMirror `transformPasted`
   plugin on `PlaceholderNode` rewrites each run, naming it from the words
   before it or a `(Label)` after it; identical labels share a key, so two
   occurrences are one question (FR-7.4). **"Detect blanks"** button posts the
   live body to `POST /templates/{id}/detect-blanks`, which reuses the Day-1
   `blank_detector` + `apply_detections` + `verify_untouched` — rule-based, so
   it works with AI switched off and nothing leaves the server.
2. **Questions empty state is actionable:** when the body still holds plain
   `___` runs it says how many and offers to convert them.
3. **`EditorTipBar`** above the canvas, with the keys drawn as keys, dismissible.
4. **"Writing in ChatGPT?"** collapsible box with the prompt rule and a Copy button.
5. **FR-10.1 assistant:** `AIAssistantPanel` + a `/ai` slash command, in both
   editors. Non-streaming (every provider is request/response). Only the
   author's instruction and the paragraph at the cursor are sent; nothing is
   applied without Insert, and rejections are recorded too.

**Detector defects found by running D1 on real prose, and fixed:**
`_LABEL_RE.search` returns the earliest position a match can start, so
"This agreement is made between ACME Ltd and Employee Name: ___" named the
blank with the whole sentence. Labels are now capped at the last six words,
cut at the previous sentence end, and cut at the last joining word ("and",
"or", "with", "from") when longer than three words. A `(Label)` straight after
a blank is now read and wins over the preceding text. This also improves
Day-1 DOCX import, which uses the same detector.

### E — validation, server-side first

`app/services/document_validation.py` is the single source of truth, reached
two ways: `POST /documents/{id}/submit-check` (pre-flight, per wizard stage)
and `submit_document`, which runs the identical check and raises
`FieldValidationException` → 422 with a `fields: [{field, code, message}]`
array. `ValidationSummary` renders the list with "Fix this" links that focus
the named control.

Rules: blank docs need a real title (not "Untitled document") and ≥20
characters of body; upload docs need an attached file that is not blocked,
pending or uncheckable; template docs need every required answer and a
*published* pinned version; the workflow must exist, be active, have stages
and have an approver on every stage (self-approval is a warning, not a block);
details cover title, past due date, effective < expiry, reminder-needs-expiry,
reminder-before-start, tag count and length, confidentiality and priority.

Checked against the live database: of 11 open drafts, 2 are blocked, both
genuinely empty "Untitled document" drafts. No false positives.

---

## Day 3

**Dependencies installed** (exact, as approved): `@tiptap/extension-text-style`,
`@tiptap/extension-color`, `@tiptap/extension-highlight`,
`@tiptap/extension-text-align`, all `3.32.0`. The editor chunk grew 2.6 kB gzip.

### FR-6.1 — the ribbon
Four tabs (Home / Insert / Layout / View), with arrow-key navigation and the
ARIA tablist pattern. Home adds a styles dropdown, font size, text colour,
highlight, four alignments, indent in/out and line spacing. Layout sets page
size and orientation; View toggles page view, outline and find.

`@tiptap/extension-text-style` 3.32 ships Color, FontSize, LineHeight,
FontFamily and BackgroundColor inside `TextStyleKit`. Configured with
`color: false` (the standalone approved package provides it), `fontFamily:
false` (no picker, by your decision), `backgroundColor: false` (Highlight
covers it) and `lineHeight: false` — TipTap's LineHeight writes to the
`textStyle` MARK, i.e. per character run, where Word's line spacing is a
paragraph property. `components/editor/BlockFormat.ts` owns `lineHeight` and
`indent` as block attributes instead, which is also what the PDF needs.

### FR-6.1 Layout → PDF
`pdf_renderer` hardcoded A4 in eight places. It now resolves one page size
from `page_settings` and carries it on the document template, frame and
running furniture. `submit_document` freezes `page_settings` into the
submission snapshot, so a PDF rendered later uses the page the author chose
and the stored checksum still covers everything. Snapshots taken before this
field existed have none and render A4 portrait exactly as before, so their
checksums are unchanged — verified.

### FR-6.3 — images and tables
Images gain an `align` attribute and a drag handle (pointer-capture, one undo
step per gesture, arrow keys for the keyboard) plus S/M/L/Full presets on a
bar that appears when the image is selected. The PDF wraps an aligned image in
a frame-width single-cell table, since reportlab's `Image` has no alignment of
its own. Tables gain merge, split and toggle-header-row on the Insert tab.

### Security — the ribbon's values are checked, not just allowed
Everything new ends up inside a `style` attribute in every viewer's DOM, so
`content_sanitizer` pattern-matches each one: colours must be `#rgb`,
`#rrggbb` or `rgb()`/`rgba()`; font sizes a bounded number plus px/pt/rem;
line spacing one of the four the ribbon offers; indent an int 0–8; `textAlign`
and image `align` one of their fixed names; image width 16–2000. Verified
against payloads carrying `url(javascript:…)`, `expression(…)` and a second
declaration after a semicolon — all dropped, text preserved.

### FR-1.8 — resizable list columns
Per-column widths stored alongside order and visibility in the same
localStorage key, clamped 64–420px on read (a stored 0 or 9000 is unusable).
The grip is a real `role="slider"`, so columns resize from the keyboard too.

### FR-15.4 / FR-15.6 / FR-8.7 — accessibility and touch

Design-token contrast, measured against the page and against a card:

| Token | Was | Now | Why |
|---|---|---|---|
| `--success` (light) | `#16A34A`, 3.10:1 | `#15803D`, 4.72:1 | used as text; below AA |
| `--warning` (light) | `#D97706`, 3.00:1 | `#B45309`, 4.73:1 | used as text; below AA |

Both are the same hue at the stop `--status-approved` / `--status-pending`
already use. Dark mode passed everywhere (lowest 6.5:1) and is untouched.

`--accent-amber` measures 2.02:1 on a light page. It is a decorative fill
(admin accent), not a text token, so it is **not** changed — but the tip bar's
icon was switched off it to `--status-pending`, and it should stay off text.

Also: a `:focus-visible` outline on every interactive element (several inline
styles set `border: none` and were relying on the browser default), 44px touch
targets on a coarse pointer for ribbon buttons, image controls, column grips,
`.btn`/`.btn-sm`, checkboxes and form controls, the ribbon un-stickied on
phones, and two-column wizard grids stacking under 760px.

---

## Final deliverables

This plan records *how* the module was built. The finished state — the
traceability table for all 112 FR lines, the acceptance-criteria walkthrough,
the deployment checklist, the "PDF stuck on Preparing" runbook, the honest
completion figure and the deferred list — is in
**[`DOCUMENTS_MODULE_HANDOVER.md`](DOCUMENTS_MODULE_HANDOVER.md)**.

Summary at hand-off (2026-10-30):

| | Count |
|---|---:|
| Done | 90 / 112 (80%) |
| Partial (main path works, a named sub-clause does not) | 16 |
| Not verifiable here | 1 (FR-1.6, p95 at 100k) |
| Deferred, with reasons | 5 |

Must 76/91 · Should 14/17 · Could 0/4.

**Three things this engagement does NOT claim:** WCAG 2.2 AA is not proven (no
screen-reader or axe pass was run), LCP and INP were never measured, and the
upload path was fixed by the project owner after the last verification run and
is therefore not re-verified here.

**Known limitation recorded on request:** FR-10.7 PII redaction before sending
text to the model is not implemented. Minimal text is sent, the org switch
defaults off and the import LLM pass is separately opt-in, but the text is not
scrubbed.

**Deployment action recorded on request:** enable server-side encryption on the
storage bucket (FR-9.9) — see the deployment checklist §4.8.

**Also recorded:** FR-1.6 is untested. (FR-1.4 virtualisation was listed here
as unimplemented; it was built on 2026-11-01 — see below.)

---

## After the sprint — five partial lines completed (2026-11-01)

Five of the sixteen "partial" lines were finished, all Must-priority. The
handover document is the source of truth; this is the summary.

| FR | What was missing | What was built |
|---|---|---|
| 1.4 | virtualisation | `hooks/useVirtualRows.ts` — dependency-free windowing with spacer divs. Threshold 60 rows, not the spec's 100: the largest page size the UI offers *is* 100, so a 100-row trigger could never fire. Rows are pinned to an exact height while windowed. |
| 1.5 | full-text index | GIN expression index over the title plus the first 100,000 characters of `content_text`, migration `e3f4a5b6c7d8` (**written, not applied**). The repository emits the indexed expression character-for-character; the ILIKE branches stay as an `OR` so nothing that matched before stops matching. |
| 1.7 | OpenAPI codegen | `scripts/generate-api-types.mjs`, zero dependencies, 137 paths / 161 schemas → `src/types/api.generated.ts`, `npm run gen:api`. `lib/api/files.ts` now takes every wire type from it. Transport stays hand-written by design. |
| 2.4 | dashed "+" card | `NewTemplateCard` leads the My Templates grid and stands in for that tab's empty state, except while a search or category is narrowing it. |
| 3.2 | resumable upload | S3/MinIO multipart: 8 MB parts, Pause/Resume, three attempts per part, session in localStorage so a reload resumes. **No new table and no new dependency** — storage's own part list is the session, and `complete` reads the ETags server-side so no CORS `ExposeHeaders` rule is needed. |

Also fixed, outside those five: the `declare module '@tiptap/core'` augmentation
in `BlockFormat.ts` could not resolve, because nothing in `src` imported that
module directly. It was failing `tsc -b` — and so `npm run build` — with eight
errors across `BlockFormat.ts` and `EditorToolbar.tsx`. A direct type import
makes the augmentation resolve. `@tiptap/core` is still not a declared
dependency; it arrives via `@tiptap/react`, and is worth pinning directly.

New completion: **95/112 (85%)**, 11 partial, 1 not verifiable, 5 deferred.
Must 81/91 · Should 14/17 · Could 0/4.

**You must still:** apply migration `e3f4a5b6c7d8`, and add a bucket lifecycle
rule that aborts incomplete multipart uploads (checklist §4.8).

## Items 6-10 of the partial list (2026-11-01, same day)

| FR | What was missing | What was built |
|---|---|---|
| 6.6 | no UI to author header/footer text | Four fields plus a page-numbers toggle in the ribbon's Layout tab, stored in the template version's `page_settings`, validated by a new `sanitize_page_settings` (that JSON used to be stored exactly as the client sent it, then handed to the PDF renderer), and applied by `pdf_renderer.resolve_furniture`. Empty inherits the derived title/reference/date; explicitly empty prints nothing. A snapshot with no authored furniture renders byte-identically, so stored PDF checksums are unaffected. |
| 9.1 | DOC/ODT/RTF/TXT, OCR | **ODT** with real structure (headings, lists, tables, bold/italic/underline) via `zipfile` + `ElementTree`; **RTF** as text only through a control-word parser; **TXT** as paragraphs plus `-`/`1.` lists. No dependency added. **Still open: `.doc` and OCR** — both need a binary (LibreOffice/antiword, Tesseract), which is a decision for you. |
| 9.6 | streaming | `GET /imports/{id}/stream`, server-sent events: one `stage` event per change, a `done` event, a 15 s heartbeat and a 120 s reconnect deadline. Each tick opens its own short-lived session rather than holding the request's connection for two minutes. Consumed with `fetch` + a stream reader, because `EventSource` cannot send an Authorization header. The 3 s poll stays as the fallback. |
| 9.7 | side-by-side original | "Compare with the original" on the review screen. PDF renders as the real file; DOCX/ODT/RTF show the extracted text **labelled as extracted text** with a download, because a browser cannot render them and a second conversion would make the comparison worthless. |
| 9.9 | encryption at rest | `S3_SSE` (+ `S3_SSE_KMS_KEY_ID`), empty by default: when set, every write the backend performs itself is encrypted — multipart initiation and the macro-stripper rewrite. Startup now logs the bucket's **actual** default-encryption state and warns in production when it is off. The browser's presigned PUT is deliberately left alone: signing an encryption header obliges the browser to echo it exactly, and on a MinIO without KMS it fails the upload outright. **The bucket flag remains yours to set.** |

New completion: **98/112 (88%)**, 8 partial, 1 not verifiable, 5 deferred.
Must 82/91 · Should 16/17 · Could 0/4.

**Still yours to do:** apply migration `e3f4a5b6c7d8`; add the bucket lifecycle
rule for incomplete multipart uploads; enable default bucket encryption; and
decide whether `.doc` import and OCR are worth a dependency.

## Items 11-15 of the partial list (2026-11-02)

| FR | What was missing | What was built |
|---|---|---|
| 10.1 | selection menu presets, ghost text | `AISelectionMenu` over the selection (TipTap `BubbleMenu`, already bundled): Improve, Shorten, Expand, Fix grammar, Tone → formal/friendlier/plain, each a preset instruction into the **same** `/ai/rewrite` call as the toolbar, so the diff dialog, confidence label, placeholder-damage check and audit record are shared. Ghost text via a new `POST /ai/complete` (120 tokens, 800 chars of context), drawn as a ProseMirror decoration — until Tab it is not in the document, so it cannot be saved or reach a PDF. **Off by default per author.** |
| 10.7 | PII redaction | `services/pii_redactor.py` wired into all seven prompt sites. Email, phone, PAN, Aadhaar, GSTIN, IFSC, passport, Luhn-checked card, IP → `[[KIND_n]]`, restored in the reply. The blank detector gets a **length-preserving `#` mask** instead, because its reply is character offsets and a substitution would shift them and break FR-9.4's no-rewrite proof. Dates, invoice numbers and amounts verified untouched. **Names and addresses remain out of reach** without NER. |
| 12.1 | draft created on open | Opening a template now writes nothing. New `GET /templates/{id}/fill-schema` reads the published version's questions; `FillSurface` renders against a stand-in document with an empty id and routes its first save through `onCreate`. The created doc and schema are seeded into the query cache before navigating so the hand-off paints instantly, and a `creatingRef` guard stops an autosave and a Continue racing into two drafts. |
| 13.2 | searchable workflow list | `components/ui/SearchableSelect.tsx` — a hand-written ARIA 1.2 combobox (filter on name or description, ↓/↑/Home/End/Enter/Esc). The typed text is only ever a filter: closing without choosing restores the selected label. |
| 15.4 | no audit had been run | jsx-a11y enabled in `.oxlintrc.json`, so the audit is **repeatable**, and the fourteen real findings fixed: nine `<label>`s labelling nothing, a `role="switch"` with no `aria-checked`, two modal scrims that were click-to-close `<div>`s, mouse-only version-history rows, and a keyboard handler on an unlabelled wrapper. Five `prefer-tag-over-role` hints kept deliberately. **Still partial** — a screen-reader pass needs a human. |

New completion: **101/112 (90%)**, 5 partial, 1 not verifiable, 5 deferred.
Must 85/91 · Should 16/17 · Could 0/4.

The five remaining partials, with the reason each cannot simply be finished:
`9.1` `.doc` + OCR need a dependency · `9.9` needs the bucket flag ·
`10.7` names/addresses need NER · `15.4` needs a screen reader ·
`15.5` needs LCP/INP measured against a deployed build.
Plus `1.6`, which is not partial but **not verifiable here**: it needs a 100k
dataset and a load harness.
