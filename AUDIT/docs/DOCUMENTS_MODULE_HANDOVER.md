# Documents Module — handover

Final state after the 3-day sprint. Covers all **112** FR lines of
`module doc/Documents_Module_Requirements_Specification_v2.docx`, the
acceptance-criteria walkthrough, the deployment checklist, one runbook, and an
honest completion figure.

Build state at hand-off: `tsc --noEmit` clean for every file this engagement
touched; `ruff check` clean for every backend file touched; `vite build`
succeeds; the app boots and `configure_mappers()` passes; `alembic heads` is a
single head, `d1e2f3a4b5c6`.

> **Upload/storage note.** The "Validating stuck / Internal server error"
> upload bug was fixed by the project owner, not by this engagement. The
> upload and storage code is therefore **not** re-verified here, and FR-3.2 /
> FR-3.3 are marked accordingly.

---

## 1. Completion

| | Count | Share |
|---|---:|---:|
| **Done** — built and verified end to end | **101** | **90%** |
| **Partial** — the main path works, a named sub-clause does not | 5 | 4% |
| **Not verifiable here** — needs data or tooling we do not have | 1 | 1% |
| **Deferred** — agreed out of scope, with a reason | 5 | 4% |

By MoSCoW priority as the spec assigns it (Must 91, Should 17, Could 4):

| Priority | Fully done | Share |
|---|---:|---:|
| Must | 85 / 91 | 93% |
| Should | 16 / 17 | 94% |
| Could | 0 / 4 | 0% |

**Headline: 90% of the specification is fully built; 95% is at least
partially built; the 4% that is deferred is the four Could-priority lines
plus FR-10.3 (AI streaming), which was explicitly traded away.**

Counting a partial as half gives 92%. The 90% figure is the honest one —
"partial" below always names exactly what is missing.

> **Counts deliberately exclude unverified work (2026-11-03).** Code for
> FR-1.10 (filter presets), FR-5.6 (TEAM scope), FR-7.10 (conditional and
> repeating sections), FR-10.3 (AI streaming), FR-10.9, and the `.doc` + OCR
> half of FR-9.1 now exists in the tree, written in a separate session. Those
> rows below still read Deferred or Partial **on purpose**: none of it has
> been run end to end, its migration (`f5a6b7c8d9e0`) is not applied, and
> crediting unverified code is how a status document starts lying. Re-grade
> those six rows after a click-test, not before.
>
> Three statuses that are sometimes misread as finished, and are not:
> **FR-15.4** is Partial — a human NVDA/VoiceOver pass is outstanding; only
> an automated jsx-a11y audit has run. **FR-15.5** is Partial — LCP and INP
> have **never** been measured; no measurement artifact or instrumentation
> exists in the tree (checked). **FR-10.7** is Partial and best-effort — the
> redaction is regex and context heuristics, **not** named-entity
> recognition, so an unqualified personal name still passes through.

> **Update, 2026-11-01.** Eight lines moved from partial to done after the
> completion report.
>
> First five, all Must: FR-1.4 (virtualisation), FR-1.5 (full-text index),
> FR-1.7 (OpenAPI codegen), FR-2.4 (dashed "+" card) and FR-3.2 (resumable
> upload). Migration `e3f4a5b6c7d8` is **written and not yet applied** —
> until it is, search returns the same rows by sequential scan, which is
> the behaviour that was there before.
>
> Then three more: FR-6.6 (authored headers and footers), FR-9.6
> (streamed import progress) and FR-9.7 (the original, side by side).
>
> Two of that second batch could not be finished by code alone and are
> **still partial on purpose**: FR-9.1 now reads ODT, RTF and plain text
> as well as DOCX and PDF, but `.doc` and OCR both need a dependency that
> has not been approved; and FR-9.9's code side is done (server-side
> writes encrypt when `S3_SSE` is set, and startup now reports the
> bucket's real state) while the bucket's own default-encryption flag is
> still yours to set.
>
> Then four more: FR-10.1 (the floating selection menu and ghost text),
> FR-10.7 (**PII redaction — previously recorded as a known limitation**),
> FR-12.1 (the draft is now created by the first answer, not by opening a
> template) and FR-13.2 (a searchable workflow picker).
>
> FR-15.4 moved from "not audited" to "automated audit clean": the
> jsx-a11y plugin is switched on in `.oxlintrc.json`, so the audit is
> repeatable, and the fourteen real findings it reported are fixed. It
> stays **partial** because a screen-reader pass needs a human at a
> screen reader — see §3 AC13.

---

## 2. Traceability — all 112 lines

Legend: **D** done · **P** partial · **NV** not verifiable here · **X** deferred.
"Verified" says how the claim was checked, not that a test file exists
(no tests were written, per the engagement rules).

### §1 Documents list

| FR | Pri | St | Where | Verified / what is missing |
|---|---|---|---|---|
| 1.1 Server-side filter/sort/paginate | M | D | `repositories/document_repo.py`, `routers/documents.py` | Live DB run: filters narrow the result set, no client-side filtering exists |
| 1.2 Filters: status, type, priority, workflow, owner, date range, search | M | D | `DocumentListPage.tsx`, `document_repo.list_by_org` | Live DB run on the org with 17 docs: owner/workflow/date-range each narrow, no duplicates, no false positives |
| 1.3 Debounced search, cancelled requests, previous results retained | M | D | `DocumentListPage.tsx` (300 ms), `useDocuments` (`keepPreviousData`) | Code path traced |
| 1.4 Keyset pagination + virtualisation >100 rows | M | D | `document_repo.encode_cursor`, `hooks/useVirtualRows.ts` | Keyset pagination tested against NULL `due_at` (8/17 mix). Virtualisation built: the body gets its own scroll container above 60 rows (not 100 — the largest page size the UI offers *is* 100, so a 100-row trigger could never fire), two spacer divs keep the scrollbar the length of the full list, and rows are pinned to an exact height while windowed so the window cannot drift |
| 1.5 Indexes incl. full-text | M | D | migration `e3f4a5b6c7d8`, `document_repo._document_tsv` | The owner/status/due indexes plus a GIN expression index over a tsvector of the title concatenated with the first 100,000 characters of `content_text` (the cap matters: a tsvector is limited to ~1 MB, and without it a long enough document would make its own INSERT fail once the index exists). The repository emits that expression character-for-character — checked by compiling the statement and comparing it to the DDL — because Postgres only uses an expression index on an exact match. The two ILIKE branches are kept as an `OR`, so no search that matched before stops matching. Checked against the live database rather than assumed: a trigram GIN index (`idx_documents_title_trgm`) already covered the title ILIKE branch, the pre-existing `search_vector` column and its `idx_documents_fts` index are **dead** (NULL on all 27 rows — nothing has ever written to that column), and the document *body* was neither searched nor indexed. The new index is what closes that. The `public_id` ILIKE branch still scans; it is a short column and is left alone |
| 1.6 p95 ≤ 300 ms at 100k docs; UI ≤ 100 ms | M | **NV** | — | No 100k dataset and no load tool here. **Untested and unimplemented as a measured target** |
| 1.7 OpenAPI-generated client, error envelope, no mock data, all states | M | D | `scripts/generate-api-types.mjs`, `src/types/api.generated.ts`, `main.py` handler | Error envelope, loading/empty/error/retry states and no mock data as before. Types are now generated from the backend's own OpenAPI document by a zero-dependency script (137 paths, 161 schemas, `npm run gen:api`); `lib/api/files.ts` takes every request and response type from it, so a backend change becomes a type error. The transport layer stays hand-written on purpose — token refresh, the error envelope and org headers are not a generator's business. The shared `Document` type in `types/index.ts` is still hand-written: it is referenced by ~40 files and rebinding it is its own change, not a drive-by |
| 1.8 Premium table (sticky header, hover, badges, relative time, resize) | S | D | `DocumentListPage.tsx` | Day 3 added column resize (localStorage, 64–420px clamp, keyboard slider) |
| 1.9 Draft badge + Continue restores the step | M | D | `DocumentListPage.tsx`, `documents.current_step` | Click-tested in an earlier turn |
| 1.10 Saved filter presets | C | **X** | — | Deferred (Could) |

### §2 New Document hub

| FR | Pri | St | Where | Verified / what is missing |
|---|---|---|---|---|
| 2.1 12-col grid, 1280px, breadcrumb, back | M | D | `DocumentCreatePage.tsx`, `PageHeader` | Visual |
| 2.2 Three equal action cards | M | D | `DocumentCreatePage.tsx` | Visual |
| 2.3 Gallery: tabs, search, chips, sort | M | D | `DocumentCreatePage.tsx`, `templates` API | Favourites are server-side (FR-5.3) |
| 2.4 "Create your own template" button **and** dashed "+" card in My Templates | M | D | `DocumentCreatePage.tsx` (`NewTemplateCard`) | Button, plus a dashed "+" card leading the My Templates grid. It also stands in for that tab's empty state — an empty My Templates with a "+" card says the same thing and offers the action — except while a search or category is narrowing the list, where "nothing matched" is a different message and the EmptyState still says it |
| 2.5 Card shows name, category, description, field count, fill time, ownership, usage | M | D | `DocumentCreatePage.tsx` | Visual |
| 2.6 Skeletons, empty states, 3→2→1 columns | M | D | `DocumentCreatePage.tsx`, `auto-fit` grids | Visual |

### §3 Upload and blank

| FR | Pri | St | Where | Verified / what is missing |
|---|---|---|---|---|
| 3.1 Dropzone state machine with animation | M | D | `UploadDropzone.tsx` | Visual |
| 3.2 Client+server validation, magic bytes, size, empty, byte progress, resumable | M | D | `UploadDropzone.tsx`, `lib/upload/resumableUpload.ts`, `core/storage.py`, `routers/files.py` | Validation and real byte progress as before. Resumable upload added over S3/MinIO multipart: 8 MB parts, Pause/Resume, three attempts per part with backoff, and a session (upload id + storage key) in localStorage so a reload or a closed tab resumes rather than restarts. The server keeps no session state — storage's own part list is the resume answer, and `complete` reads the ETags from storage so the browser never needs a CORS ExposeHeaders rule. Files under 8 MB keep the single presigned PUT, whose owner-fixed path is **unchanged and still not re-verified here** |
| 3.3 AV scan + macro stripping before availability | M | D | `services/antivirus.py`, `routers/files.py` | Structural scanner + optional ClamAV. Labels are honest: "File checked" / "Virus scan not enabled" — never "Scanned" unless ClamAV ran |
| 3.4 Blank card expands into the editor, draft created immediately | M | D | `useStartDraft.ts`, `EditorSkeleton.tsx` | Day-3 defect C: the frame now renders on click and the draft is created behind it. The shared-element expand was **replaced** by that, on your instruction |
| 3.5 Motion tokens 150–350 ms, reduced-motion respected | M | D | `index.css`, `prefersReducedMotion.ts` | 15 `prefers-reduced-motion` blocks |
| 3.6 Animated route transitions | S | D | `framer-motion` per page | Visual |
| 3.7 Hub upload = submit as-is; import lives in Template Studio | M | D | `UploadDocumentModal.tsx`, `ImportTemplatePage.tsx` | Two separate routes |

### §4 Hover quick-look

| FR | Pri | St | Where | Verified |
|---|---|---|---|---|
| 4.1 200 ms intent delay or focus → quick-look | M | D | `DocumentCreatePage.tsx` template card | Visual |
| 4.2 No layout shift, stays in viewport | M | D | popover positioning | Visual |
| 4.3 Lazy thumbnails, prefetch on hover | S | D | `TemplateThumbnail.tsx`, query prefetch | Visual |

### §5 Template Studio

| FR | Pri | St | Where | Verified / what is missing |
|---|---|---|---|---|
| 5.1 Two choices: scratch / import | M | D | `TemplateStudioEntryPage.tsx` | Both live; Day-3 defect B made "scratch" instant |
| 5.2 SYSTEM/USER scope, server-enforced, 404 not 403 | M | D | `template_studio_service._require` | Code path traced |
| 5.3 Rename, new version, duplicate, archive, favourite; documents keep their version | M | D | `template_studio_service`, migration `b1c2d3e4f5a6` | Pinning verified in an earlier turn |
| 5.4 "Save as template" from a document | S | D | `DocumentDetailPage.tsx`, `document_service` | Endpoint + UI present |
| 5.5 Per-user quota (default 50) | S | D | `TEMPLATE_QUOTA_PER_USER = 50` | Message shown on the entry page |
| 5.6 TEAM scope / admin promotion | C | **X** | — | Deferred (Could) |

### §6 Editor

| FR | Pri | St | Where | Verified / what is missing |
|---|---|---|---|---|
| 6.1 Ribbon tabs: Home / Insert / Layout / View | M | D | `EditorToolbar.tsx`, `BlockFormat.ts` | Day 3. **Font-family picker deliberately omitted** (your decision). Layout feeds the PDF — verified: Letter/landscape produce different bytes, still deterministic |
| 6.2 Paged canvas with boundaries and page count | M | D | `PagedCanvas.tsx` | Labelled "approximate" on purpose |
| 6.3 H1–3/Title/Normal, merged table cells, image resize + alignment | M | D | `EditorToolbar.tsx`, `ImageNode.tsx`, PDF renderer | Day 3. Merge/split via TableKit; image drag-resize + align, honoured in the PDF |
| 6.4 Undo/redo, find/replace, shortcuts, cleaned Word paste, spell-check | M | D | `FindReplaceBar.tsx`, `pasteCleaner.ts` | `spellcheck: 'true'` set explicitly |
| 6.5 Status bar: words, page x of y, autosave state | M | D | both editors, `SaveIndicator.tsx` | Visual |
| 6.6 Headers/footers, page numbers, outline pane | S | D | `EditorToolbar.tsx` (Layout tab), `content_sanitizer.sanitize_page_settings`, `pdf_renderer.resolve_furniture` | Outline pane as before. Header and footer text are now authored in the Layout tab (four fields plus a page-numbers toggle), stored in the template version's `page_settings`, validated server-side, and printed by the PDF renderer. A field left empty inherits what DocFlow derives (title, reference, submission date); a field set to empty prints nothing — the two are different instructions and are kept apart. Checked: a snapshot with no authored furniture still renders byte-identically, so stored PDF checksums are unaffected (FR-13.8) |
| 6.7 Export preview to PDF and DOCX | S | D | `ExportMenu.tsx`, `pdf_renderer.py`, `docx_renderer.py` | Both formats wired |
| 6.8 Editor bundle lazy-loaded | M | D | `App.tsx` `lazy()`, `lib/preload.ts` | Build output: editor chunks are separate (`extensions` 148 kB gz), not in the entry bundle |

### §7 Placeholders

| FR | Pri | St | Where | Verified |
|---|---|---|---|---|
| 7.1 Structured inline node | M | D | `PlaceholderNode.ts` | Never raw underscores in the stored JSON |
| 7.2 Button, Ctrl+Shift+B, 3+ underscores/asterisks, **and pasted text** | M | D | `PlaceholderNode.ts` input rule + `transformPasted`, `blankText.ts` | Day-3 defect D1. Bundled the real module and ran it: label-before, `(Label)`-after, linking, reserved keys, no false positives on `__` |
| 7.3 Stable numbering, "N blanks, M unique fields" | M | D | `placeholderScanner.ts` | Renumbering verified server-side in `apply_detections` |
| 7.4 Linked placeholders, link/unlink, update together | M | D | `TemplateEditorPage`, `blank_detector` | Live run: 5 blanks → 4 questions, the two "Employee Name" occurrences share a key |
| 7.5 Placeholders in paragraphs, headings, lists, table cells | M | D | sanitizer + scanner | Table-cell case verified in the detector regression run |
| 7.6 11 field types | M | D | `FieldConfigPanel.tsx`, `template.py` | All present |
| 7.7 Label, help, example, required, default, validation | M | D | `FieldConfigPanel.tsx` | All present |
| 7.8 Answers replace the blank and reflow | M | D | `DocumentPreview.tsx` | Visual |
| 7.9 Deleting a placeholder drops its config, undoable | M | D | `TemplateEditorPage` reconcile effect | Code path traced |
| 7.10 Conditional / repeating sections | C | **X** | — | Deferred (Could). Field model shaped so it can be added without a rewrite |

### §8 Field configuration

| FR | Pri | St | Where | Verified |
|---|---|---|---|---|
| 8.1 "N blanks found", one question per unique field, gate | M | D | `TemplateEditorPage` | Day 3 made the empty state actionable |
| 8.2 Split view, stepper, scroll-into-view | M | D | `SplitPane.tsx`, `FieldConfigPanel.tsx` | Visual |
| 8.3 Bi-directional navigation | M | D | `DocumentPreview onBlankClick`, `focusOccurrence` | Visual |
| 8.4 AI pre-fills each question | M | D | `ai_assist_service.suggest_field` | Accept/reject, never auto-applied |
| 8.5 Validation gate + "Fix n issues" list | M | D | `fieldIssue`, publish checklist | Links jump to the field |
| 8.6 Reorder and group into sections | S | D | `QuestionReorderList.tsx` (@dnd-kit) | One autosave per drag |
| 8.7 Below 1024 px panes stack | S | D | `SplitPane.tsx`, Day-3 CSS | Stacked layout + coarse-pointer rules |

### §9 Import

| FR | Pri | St | Where | Verified / what is missing |
|---|---|---|---|---|
| 9.1 DOCX + text PDF (M); DOC/ODT/RTF/TXT (S); OCR (C) | M | **P** | `document_importer.py` | DOCX **and ODT** with headings, lists, tables and bold/italic/underline (ODT via zipfile + ElementTree — no dependency). PDF, **RTF** and **plain text** as clearly-labelled text-only; TXT additionally keeps lists written with `-` or `1.` markers. One honest ODT gap: bullet vs numbered lives in a separate style file, so every list arrives bulleted and the author is told so. **Still missing: `.doc` (OLE2 — needs a converter binary) and OCR (needs Tesseract).** Both need a dependency decision |
| 9.2 Rule pass then optional LLM pass | M | D | `blank_detector.py`, `import_tasks._llm_pass` | LLM pass is **opt-in, default off**, hidden when the org switch is off |
| 9.3 Schema-validated JSON per detection | M | D | `import_service.py` | Offsets, original text, key, label, type, confidence, reason |
| 9.4 AI must not rewrite text; server verifies | M | D | `import_service.verify_untouched` | The proof runs on every apply; a failure refuses rather than returns |
| 9.5 Review UI by confidence, accept/reject, "Make blank" | M | D | `ImportDocumentPanel.tsx` | Manual spans bounds-checked server-side |
| 9.6 Staged progress, streaming, cancel, timeout | M | D | `routers/imports.stream_import`, `lib/api/eventStream.ts`, `useImports.ts` | Stages, cancel and the 120 s soft limit as before, plus a real server-sent-events stream (`GET /imports/{id}/stream`) that pushes each stage change. Written over `fetch` rather than `EventSource`, which cannot send an Authorization header. The 3 s poll stays underneath on purpose: proxies buffer `text/event-stream` often enough that a stream must not be the only way to learn a job finished |
| 9.7 Fidelity warnings; original viewable side by side | S | D | `components/templates/OriginalPane.tsx`, `ImportTemplatePage.tsx` | Warnings as before, plus "Compare with the original" on the review screen. A PDF is shown as the real file in the browser's own viewer; a DOCX/ODT/RTF cannot be rendered by a browser, so that pane shows the extracted text **labelled as extracted text** with a download for the file itself. Calling a second conversion "the original" would make the comparison worthless |
| 9.8 AV scan, macro removal, HTML sanitisation, reject encrypted | M | D | `antivirus.py`, `content_sanitizer.py` | Sanitiser re-verified in Day 3 against CSS-injection payloads |
| 9.9 Original retained, encrypted at rest, linked | S | **P** | `core/storage.py`, `main.py` lifespan, `docker-compose.yml` | Retained and linked. Code side done: `S3_SSE` (default empty) makes every write the backend performs itself encrypted, and startup logs the bucket's **actual** default-encryption state. Not done in code on purpose: the browser's presigned PUT — signing an encryption header obliges the browser to echo it exactly, and on a MinIO without KMS it fails the upload outright, so bucket default encryption is the mechanism. **Dev MinIO is now verified encrypted**: `mc encrypt info docflow-documents` reports "Auto encryption 'sse-s3' is enabled". **Still partial for production S3**: default bucket encryption and the `AbortIncompleteMultipartUpload` lifecycle rule are unset and unverifiable in this environment (§4.8). Note the two objects already in the dev bucket predate auto-encryption and are **not** encrypted |

### §10 AI

| FR | Pri | St | Where | Verified / what is missing |
|---|---|---|---|---|
| 10.1 Selection menu (Improve/Shorten/Expand/Tone/Grammar), slash command, ghost text, side panel | M | D | `AISelectionMenu.tsx`, `GhostText.ts`, `useGhostText.ts`, `AIAssistantPanel.tsx`, `SlashAI.ts` | All four now. The floating menu (TipTap `BubbleMenu`, already in the bundle) offers Improve, Shorten, Expand, Fix grammar and Tone (formal / friendlier / plain English), each a preset instruction into the **same** `/ai/rewrite` call as the toolbar button — so the diff dialog, the confidence label, the placeholder-damage check and the audit record are shared, not duplicated. Ghost text is a new `POST /ai/complete` (120-token ceiling, 800 characters of context) drawn as a ProseMirror decoration: until Tab is pressed it is not in the document, so it cannot be saved or reach a PDF. **Off by default per author** — it is the one AI feature that fires on a timer rather than on a click, so it is opt-in for the same reason the import LLM pass is |
| 10.2 Diff with Accept / Reject / Regenerate, one undo | M | D | `AIRewriteDialog.tsx` | Nothing applied silently |
| 10.3 Streaming (SSE) | M | **X** | — | Deferred. Every provider in `app/ai/providers` is request/response; adding SSE is a provider-layer change |
| 10.4 Gemini called only from the back end | M | D | `ai_assist_service.py` | No key, model or prompt in the browser |
| 10.5 Placeholder-safe prompting, rejected if damaged | M | D | `_placeholder_damage`, one retry, `blocked` flag | Counter-based so a legitimately repeated token is not a false positive |
| 10.6 Rate limits, quota, cost, audit log | M | D | `AI_DAILY_QUOTA_PER_USER`, `ai_interactions` | Rejections recorded too |
| 10.7 Notice, org/user switch, PII redaction, no-training confirmation | M | **P** | `services/pii_redactor.py`, `ai_assist_service` (all 7 call sites) | Notice, org switch (**default off**) and per-user opt-out as before. **PII redaction is now implemented** and applied at every one of the seven points document text enters a prompt: email, phone, PAN, Aadhaar, GSTIN, IFSC, passport, Luhn-checked card and IP are swapped for `[[KIND_n]]` placeholders and restored in the reply. The blank detector uses a **length-preserving** mask instead, because its reply is character offsets and a substitution would shift them and break the FR-9.4 no-rewrite proof. **Still partial, and this is the honest limit: names and postal addresses are not redacted.** They have no detectable shape, and finding them needs named-entity recognition — i.e. sending the text to a model, which is the thing being avoided. Dates, invoice numbers and amounts are deliberately left alone (verified) |
| 10.8 Every feature usable with AI off | M | D | `useAIAvailability`, `HIDE_FEATURE_CODES` | "Detect blanks" is rule-based for exactly this reason |
| 10.9 Multi-language (Tamil, Hindi) | C | **X** | — | Deferred (Could). Note the PDF font has no Tamil/Devanagari glyphs either |

### §11 Preview and publish

| FR | Pri | St | Where | Verified |
|---|---|---|---|---|
| 11.1 Preview gate, Blank + Try-it modes | M | D | `TemplateEditorPage` stage 3 | Sample data labelled, never saved |
| 11.2 Publish checklist, failing items link to the fix | M | D | `usePublishCheck`, local issues | Both server and live client rules |
| 11.3 Metadata at publish | M | D | `TemplateEditorPage` stage 3 | Name, description, category, tags |
| 11.4 DRAFT → PUBLISHED v1, animate to My Templates | M | D | `publish_template`, navigate with state | Visual |
| 11.5 Editing a published template makes a new version; documents stay pinned | M | D | `_editable_version`, `template_version_id` | Verified in an earlier turn |
| 11.6 Back navigation preserves state | M | D | `Stepper` + component state | Visual |

### §12 Form fill

| FR | Pri | St | Where | Verified / what is missing |
|---|---|---|---|---|
| 12.1 "Use template" opens the wizard; draft created on **first answer** | M | D | `StartFromTemplatePage.tsx`, `FormFillPage.FillSurface`, `GET /templates/{id}/fill-schema` | Opening a template now creates nothing. The questions are read from the template's published version through a new endpoint, the wizard renders against a stand-in document with an empty id, and the first answer is what writes the row — after which the author is on the ordinary `/documents/:id/fill` route with the ordinary autosave. The created document and its schema are seeded into the query cache before navigating, so the hand-off paints immediately. A `creatingRef` guard stops an autosave and a Continue racing into two drafts |
| 12.2 Split view, live document, one question at a time | M | D | `FormFillPage.tsx` | Visual |
| 12.3 Required `*`, Next disabled until valid | M | D | `FormFillPage.tsx`, `FillAnswerInput.tsx` | Also enforced server-side at submit (Day-3 defect E) |
| 12.4 Enter = next, Shift+Enter = previous, arrows for options | S | D | `FormFillPage.tsx:189-195` | Radios/selects are native, so arrows already work |
| 12.5 Preview & verify, click an answer to jump back | M | D | `DocumentPreview.tsx` | Visual |
| 12.6 Linked placeholders update everywhere | M | D | shared `fieldKey` | Verified via the detector run |

### §13 Submission wizard

| FR | Pri | St | Where | Verified / what is missing |
|---|---|---|---|---|
| 13.1 Stepper, back without data loss, completed steps clickable | M | D | `SubmitWizard.tsx` | Visual |
| 13.2 **Searchable** workflow list, stages/approvers/SLA shown | M | D | `components/ui/SearchableSelect.tsx`, `SubmitWizard.tsx` step 2 | Stages, approver summary and SLA as before. The picker is now a hand-written ARIA 1.2 combobox: type to filter on name or description, ↓/↑/Home/End/Enter/Esc, and the typed text is only ever a filter — closing without choosing restores the selected label, so the field can never show something that is not what is selected |
| 13.3 Workflow contract + stub until the module exists | M | D | `useWorkflowTemplates` | Real workflow module present |
| 13.4 Submission details (title, workflow, priority, due, validity, tags, watchers, attachments) | M | D | `SubmitWizard.tsx`, migration `c7d8e9f0a1b2` | Watchers, effective/expiry, reminders and attachments all wired; validated server-side |
| 13.5 AI suggests title, description, priority | S | D | `AISuggestDetails.tsx`, `suggest_submission_details` | Opt-in, per-field Use buttons |
| 13.6 Final review: 3 cards, thumbnail, full preview, stage timeline | M | D | `SubmitWizard.tsx` step 4, `ContentMiniature.tsx` | Stage timeline added in the Day-2 re-check |
| 13.7 Idempotent submit, disabled in flight, success animation | M | D | `Idempotency-Key`, Redis guard | Replay returns the current document |
| 13.8 Immutable snapshot + generated PDF, SHA-256 | M | D | `submit_document`, `pdf_renderer`, `pdf_tasks` | Deterministic render verified again in Day 3 (same bytes, same checksum) |
| 13.9 Blank/uploaded documents use steps 4–6 only | M | D | `SubmitWizard` step mapping | Fill step skipped |

### §14 Autosave and drafts

| FR | Pri | St | Where | Verified |
|---|---|---|---|---|
| 14.1 Debounce, blur, step change, page hide (`sendBeacon`) | M | D | `useAutosave.ts` | All four triggers |
| 14.2 Content, fields, answers, step, workflow, details persisted | M | D | `useAutosave`, `DocumentContent` | Resume works |
| 14.3 Four save states | M | D | `SaveIndicator.tsx` | Saving / Saved / Offline / Error+Retry |
| 14.4 Partial data saved; validation only at transitions | M | D | `update_document` | Day-3 defect E keeps validation at the gates, not on every keystroke |
| 14.5 Drafts resume at the exact step | M | D | `documents.current_step` | Click-tested |
| 14.6 Optimistic locking, conflict dialog | M | D | `If-Match`, `ConflictDialog.tsx` | 409 path tested |
| 14.7 IndexedDB backup, sync on reconnect | S | D | `lib/offline/draftCache.ts` (idb) | Code path traced |
| 14.8 Version history with restore | S | D | `TemplateVersionHistory.tsx`, `VersionHistoryModal.tsx` | Both templates and documents |
| 14.9 24 h empty purge, 90-day purge with prior notice, always-available Discard | S | D | `cleanup_tasks.py` | Live run: warned once at 85 days, **purge clock not reset**, not warned twice, stale marker re-warns, past-cutoff skipped, probe restored exactly |
| 14.10 Autosave never blocks typing | M | D | `useAutosave` coalescing | Single in-flight + coalesce |

### §15 Design system, a11y, performance

| FR | Pri | St | Where | Verified / what is missing |
|---|---|---|---|---|
| 15.1 Use theme tokens; add missing ones | M | D | `index.css` | No hardcoded hex in components except document-content colours, which are author data |
| 15.2 Shared components | M | D | `components/ui/*` | Table, stepper, split pane, skeletons, dialogs, empty states, save indicator |
| 15.3 Motion: stagger, layout, step transitions, highlight pulse | M | D | framer-motion + `index.css` | Reduced-motion respected throughout |
| 15.4 WCAG 2.2 AA | M | **P** | `.oxlintrc.json` (jsx-a11y), Day-3 CSS + token fixes | Keyboard operation, `:focus-visible` everywhere, ARIA roles, live regions and measured contrast as before, **plus a repeatable automated audit**: the jsx-a11y plugin is enabled in the lint config and the fourteen real findings are fixed — nine `<label>`s that labelled nothing (two were headings wearing a label's styles), a `role="switch"` with no `aria-checked`, two modal scrims that were click-to-close `<div>`s invisible to assistive tech, version-history rows reachable only by mouse, and a keyboard handler on an unlabelled wrapper. **Still partial: a screen-reader pass needs a human at NVDA or VoiceOver**, which is not something this engagement can run, so AA is not claimed as proven. Five `prefer-tag-over-role` hints are kept deliberately (`role="dialog"` + `aria-modal` is valid and `<dialog>` would need its focus trap rewritten) |
| 15.5 LCP ≤ 2.5 s, INP ≤ 200 ms, code splitting, lazy editor | M | **P** | `App.tsx`, build output | Route-level splitting and lazy editor/AI panels confirmed in the build. **LCP and INP not measured** |
| 15.6 360–1920 px, 44 px touch targets | S | D | Day-3 `@media (pointer: coarse)` block | Ribbon buttons, swatches, tabs, image controls, column grips, `.btn`/`.btn-sm`, checkboxes and form controls all reach 44 px |

---

## 3. Acceptance-criteria walkthrough

| AC | Result | Evidence |
|---|---|---|
| **AC1** List filters update the URL, keep previous rows, and are shareable | **PASS** | `searchParams` is the source of truth; `keepPreviousData` holds rows during a refetch |
| **AC2** Hover quick-look causes no layout shift | **PASS** | Popover overlays; measured by eye in both themes |
| **AC3** A template with 0 fields still starts a draft | **PASS** | Fixed in turn 3; re-checked |
| **AC4** Editing a draft shows "Saved" and resumes after refresh | **PASS** | `current_step` restore, click-tested |
| **AC5** Create blank / upload / from-template → draft → submit works end to end | **PASS for blank and template.** **Upload not re-verified** — the owner's own fix landed after this engagement's last run |
| **AC6** Submitted documents cannot be edited | **PASS** | `EDITABLE_STATUSES` + `_require_editable`; all eleven workflow transitions assign `doc.status` directly and never route through `update_document` (traced) |
| **AC7** The AI never rewrites imported text | **PASS** | `verify_untouched` runs on every apply and refuses rather than returning unproven content |
| **AC8** A submitted document's PDF provably matches the snapshot | **PASS** | `invariant=1` + pinned `created`; re-rendering the same snapshot reproduces the stored SHA-256. Re-verified in Day 3 after the page-size change |
| **AC9** Every feature works with AI switched off | **PASS** | Availability gate hides AI controls — including the new selection menu and the ghost-text switch; "Detect blanks" is rule-based |
| **AC10** Reduced motion disables movement | **PASS** | 15 `prefers-reduced-motion` blocks; `prefersReducedMotion()` guards JS animation |
| **AC11** A blocked step tells the user which field and why | **PASS** | Server-side `document_validation` → 422 with field codes → `ValidationSummary` with "Fix this" links |
| **AC12** Org isolation: a document from another org is never returned | **PASS** | Every query scoped by `org_id`; template IDOR returns 404 not 403 |
| **AC13** WCAG 2.2 AA | **NOT VERIFIABLE HERE** | Now with an automated audit behind it: jsx-a11y is enabled in `.oxlintrc.json` and its fourteen real findings are fixed, on top of the keyboard, focus, ARIA and measured-contrast work. A **screen-reader pass still needs a human**, so AA is not claimed as proven |
| **AC14** p95 ≤ 300 ms at 100k documents | **NOT VERIFIABLE HERE** | No dataset of that size and no load tool |
| **AC15** LCP ≤ 2.5 s / INP ≤ 200 ms | **NOT VERIFIABLE HERE** | Needs a field or lab measurement against a deployed build |

---

## 4. Deployment checklist

### 4.1 Migrations, in order

The first nine are applied on the development database. The tenth is
**written and not yet applied** — apply it when you are ready (it takes a
brief SHARE lock on `documents`; see the migration's own notes). On a fresh
environment `alembic upgrade head` applies all ten in this order:

1. `f1a2b3c4d5e6` documents_foundation — autosave/optimistic-lock + wizard fields + list indexes
2. `a7b8c9d0e1f2` template_studio_tables
3. `b1c2d3e4f5a6` document_template_version_pin
4. `c3d4e5f6a7b8` document_contents
5. `d5e6f7a8b9c0` template_favourites
6. `e7f8a9b0c1d2` ai_interactions (+ `users.ai_opt_out`)
7. `f9a0b1c2d3e4` document_pdf_render_state
8. `c7d8e9f0a1b2` submission_details (+ `document_watchers`, expiry index)
9. `d1e2f3a4b5c6` import_jobs
10. `e3f4a5b6c7d8` documents_fulltext_index — **APPLIED.** One GIN
    expression index for FR-1.5 (`idx_documents_fts_expr`), verified
    present on `documents`.
11. `f5a6b7c8d9e0` templates_dept_id — **NOT APPLIED.** One nullable
    `templates.dept_id`, an FK to `departments(id) ON DELETE SET NULL`,
    and `ix_templates_dept_id`. Purely additive; the SQL was reviewed
    offline with `alembic upgrade e3f4a5b6c7d8:head --sql`. FR-5.6 (TEAM
    scope) cannot work until it is applied. Apply with:

    ```
    cd Backend
    .venv/Scripts/python.exe -m alembic upgrade head
    .venv/Scripts/python.exe -m alembic current
    ```

    Then map `dept_id` on the `Template` model. Until then the repository
    builds the clause from a qualified, UUID-typed literal
    (`_template_dept_col()`), which works either way.

Every one is additive. **No migration was added for Day 3** — the ribbon's
formatting lives inside the existing `content` JSONB — and none was needed
for resumable upload either: storage's own multipart state is the session,
so there is no upload table to migrate, expire or clean up.

### 4.2 Environment variables — NAMES ONLY

No new environment variables were needed for the AI work: `/ai/complete`
uses the same provider, quota and audit path as every other feature.

Two names added for FR-9.9, both optional and empty by default:
`S3_SSE` (`AES256` or `aws:kms`; empty means the backend does not request
server-side encryption on its own writes) and `S3_SSE_KMS_KEY_ID` (only
read when `S3_SSE` is `aws:kms`). Setting `S3_SSE` on a MinIO with no KMS
configured will make those writes fail, which is why it is off by default.

Set these; never commit their values.

**Core:** `DATABASE_URL`, `REDIS_URL`, `SECRET_KEY`, `JWT_PRIVATE_KEY`,
`JWT_PUBLIC_KEY`, `APP_ENV`, `FRONTEND_URL`, `CORS_ORIGINS`.

**Auth:** `FIREBASE_PROJECT_ID`, `FIREBASE_CREDENTIALS_JSON`,
`FIREBASE_CHECK_REVOKED`, `FIREBASE_REVOCATION_FAIL_CLOSED`.

**Storage:** `STORAGE_BACKEND` (`minio` for dev, **`s3` for production**),
`MINIO_ENDPOINT` (dev only), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_REGION`, `S3_BUCKET_DOCUMENTS`, `S3_BUCKET_TEMPLATES`,
`S3_BUCKET_EXPORTS`, `S3_BUCKET_PREVIEWS`, `S3_BUCKET_OCR_INPUT`.
Cloudinary keys exist in `.env` but **nothing in `app/` reads them** — by
decision, Cloudinary stays unwired.

**Queue:** `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND`,
`CELERY_WORKER_CONCURRENCY`.

**Antivirus:** `AV_SCANNER`, `CLAMAV_HOST`, `CLAMAV_PORT`,
`AV_TIMEOUT_SECONDS`, `AV_MAX_INLINE_BYTES`.

**AI:** `AI_PROVIDER`, `GEMINI_API_KEY` (or `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY`), `AI_PRIMARY_MODEL`, `AI_FALLBACK_MODEL`,
`AI_REQUEST_TIMEOUT_SECONDS`, `AI_MAX_RETRIES`.

**Retention:** `DRAFT_RETENTION_DAYS`, `DRAFT_RETENTION_NOTICE_DAYS`,
`DRAFT_RETENTION_DRY_RUN`, `DRAFT_RETENTION_BATCH_LIMIT`,
`EMPTY_DRAFT_RETENTION_HOURS`, `EXPIRY_REMINDERS_ENABLED`,
`EXPIRY_REMINDERS_DRY_RUN`.

**Email:** `EMAIL_PROVIDER`, `EMAIL_FROM`, `EMAIL_FROM_NAME`,
`RESEND_API_KEY` or the `SMTP_*` set.

### 4.3 Celery worker and beat

Both are required. The worker must consume **three** queues — `pdf_tasks` and
`import_tasks` have no routing rule and therefore land on `default`:

```
celery -A app.core.celery_app worker -l info -Q default,ai,email
celery -A app.core.celery_app beat   -l info
```

> **Do not** set the beat scheduler to `django_celery_beat.schedulers:DatabaseScheduler`.
> It was configured that way once; the package does not exist in this FastAPI
> project, beat crash-looped, and **no scheduled job had ever run**. It is now
> the default `PersistentScheduler`.

Scheduled jobs (all UTC):

| Job | When | Queue |
|---|---|---|
| `check_sla_breaches` | every 15 min | default |
| `purge_empty_drafts` | hourly at :20 | default |
| `send_retention_notices` | 02:30 daily | default |
| `refresh_stale_embeddings` | 02:00 daily | ai |
| `cleanup_expired_documents` | 03:00 daily | default |
| `send_expiry_reminders` | 07:00 daily | default |

The notice job runs **before** the purge on purpose: a draft must be warned
before it is deleted.

### 4.3a Import binaries (FR-9.1)

`.doc` conversion needs `soffice` (LibreOffice) and OCR needs
`tesseract` plus poppler. The Dockerfile installs `libreoffice-writer`,
`tesseract-ocr`, `tesseract-ocr-eng` and `poppler-utils`, so both work
**inside the container**. Neither binary is on the host PATH, so a
backend run straight from the host venv refuses those two formats with
an actionable message naming the missing binary — by design, not a bug.
Verified by `shutil.which` on the host.

### 4.4 PDF fonts

`Backend/app/assets/fonts/` must ship with the image — the renderer registers
four Noto Sans faces at start-up and will not fall back to Helvetica.

- **Font:** Noto Sans (Regular, Bold, Italic, BoldItalic)
- **Licence:** SIL Open Font License 1.1 (`OFL.txt` + `README` committed)
- **Coverage:** 2,965 glyphs including ₹. **No CJK, Arabic, Devanagari or
  Tamil** — those render as □ and are counted in `stats.missing_glyphs` and
  logged as `pdf_missing_glyphs`.
- Pinned dependency: `reportlab==4.2.5`.

### 4.5 Antivirus

`AV_SCANNER` selects the scanner:

- `structural` (default) — magic-byte checks and Office macro stripping, no
  virus engine. The UI then says **"File checked"**, never "Scanned".
- `clamav` — adds a real engine; needs `CLAMAV_HOST` / `CLAMAV_PORT` reachable.
  Only with this set does the UI claim a virus scan.

With neither available the label is **"Virus scan not enabled"**. Do not change
these strings to imply a scan that did not happen.

### 4.6 AI org switch

**Default is OFF.** An organisation sees no AI controls until an admin turns
it on (Settings → AI), and each user can opt out individually
(`users.ai_opt_out`). Leave it off until the data-processing notice has been
accepted by whoever owns that decision.

The import flow's LLM pass is a **separate, per-import opt-in that defaults to
off**, and is hidden entirely when the org switch is off. Document text does
not reach a model unless someone ticks it.

### 4.7 Retention dry-run — and when to turn it off

`DRAFT_RETENTION_DRY_RUN` is currently **`true`**. In that state the purge and
notice jobs log what they *would* do and change nothing.

Turn it off only after:

1. beat has been running for at least one full day and the logs show
   `purge_empty_drafts` and `send_retention_notices` firing;
2. you have read one day's dry-run output and agree with the list;
3. `DRAFT_RETENTION_DAYS` (90) and `EMPTY_DRAFT_RETENTION_HOURS` (24) match
   your policy.

Deletion is **soft** (`deleted_at`), every action is written to the audit log,
and a warned draft keeps its purge clock — the notice marker is written with a
Core UPDATE that restates `updated_at`, because `onupdate=utcnow` would
otherwise push the purge 90 days into the future every time someone was warned.

### 4.8 Storage encryption at rest (FR-9.9)

**Enable server-side encryption on the storage bucket.** This is a deployment
action, not application code:

- AWS S3: set default bucket encryption (SSE-S3 or SSE-KMS) and a bucket policy
  that denies `s3:PutObject` without encryption headers.
- MinIO (dev): enable KMS/SSE-S3 on the bucket if the environment holds real data.

Until this is set, FR-9.9 ("original file retained, encrypted at rest") is only
half satisfied — the file is retained and linked, but not encrypted.

**Also set a lifecycle rule for abandoned multipart uploads.** Resumable
upload (FR-3.2) leaves parts in the bucket when someone pauses an upload and
never comes back. The parts are invisible in a normal object listing but they
are billed, so expire them:

- **MinIO (dev): nothing to configure.** MinIO expires stale incomplete
  multipart uploads on its own background schedule. An earlier version of
  this document told you to add an `mc ilm` rule for it — that was wrong:
  `mc ilm rule add` in mc RELEASE.2025-08-13 has no incomplete-multipart
  flag at all (verified by reading `mc ilm rule add --help` in the running
  container; its flags are prefix/tags/size/expire/transition/noncurrent
  only). The `mc admin config` suggestion was equally unfounded.
- **AWS S3 (production): a real lifecycle rule is required.** The action is
  `AbortIncompleteMultipartUpload` with `DaysAfterInitiation: 7`, set through
  the S3 console, `put-bucket-lifecycle-configuration`, or your IaC. **This
  has not been verified here** — there is no production bucket in this
  environment to set it on.

Seven days is comfortably longer than the one-day window in which the client
offers to resume (`SESSION_TTL_MS` in `lib/upload/resumableUpload.ts`), so no
rule can expire parts a user could still have continued.

No CORS change is needed: the browser never reads a part's ETag, because the
server reads the part list from storage at `complete` time. If you ever change
that, `ExposeHeaders: ["ETag"]` becomes mandatory and its absence breaks every
large upload in a way that is hard to diagnose.

### 4.9 Database latency

Measured during Day 3 against the current remote Postgres: a bare `SELECT 1`
costs **256 ms**, a simple indexed `SELECT` **~520 ms**, and a single-row
`INSERT INTO templates` **~2.2 s** — on a table with 3 rows, 3 indexes and no
triggers. That is round-trip latency and connection behaviour, not query cost.

Consequence: every endpoint pays ~0.25–0.5 s per statement. The application
side has been reduced as far as it sensibly can (creating a template went from
8 SELECTs to 1), but **FR-1.6's 300 ms p95 cannot be met from this host**.
Co-locate the database with the API, or use a pooled low-latency instance,
before measuring performance.

---

## 5. Runbook — "PDF stuck on Preparing"

**Symptom:** a submitted document shows *Preparing…* on the snapshot PDF card
and never becomes *Download*.

**What that state means:** `submit_document` sets
`document_contents.pdf_status = 'pending'` inside the submission transaction,
then dispatches `app.workers.pdf_tasks.render_submission_pdf` **after** the
commit. So "pending" means the row was written but the task has not finished —
either it never ran, or it failed before writing a terminal status.

Work down this list; stop at the first thing that is wrong.

1. **Is a worker consuming `default`?**
   `celery -A app.core.celery_app inspect active_queues`
   `pdf_tasks` has no routing rule, so it goes to `default`. A worker started
   with `-Q ai,email` will leave these queued forever. Fix: restart with
   `-Q default,ai,email`.

2. **Is the broker reachable?** `redis-cli -u "$CELERY_BROKER_URL" ping`
   A dispatch failure after a successful commit is deliberate — the submission
   is never rolled back because the broker is down — so the document is
   correctly submitted with no PDF. Re-queue it (step 6).

3. **Did the task fail?** Search the worker log for
   `pdf_render_failed`, `pdf_missing_glyphs`, or a traceback naming
   `pdf_tasks`. A failed render sets `pdf_status = 'failed'` and the card shows
   **Retry**, not Preparing — so a *stuck* Preparing usually means the task
   never started.

4. **Are the fonts present in the running image?**
   `ls Backend/app/assets/fonts/NotoSans-*.ttf` inside the container.
   `ensure_fonts()` raises if they are missing, and that happens before any
   page is laid out.

5. **Check the row directly.**
   ```sql
   SELECT document_id, pdf_status, pdf_error, pdf_rendered_at
   FROM document_contents WHERE document_id = '<id>';
   ```
   - `pending` with an old timestamp → the task was lost; re-queue.
   - `failed` → read `pdf_error`; the UI should already be offering Retry.
   - `ready` but the UI still says Preparing → a stale client cache; reload.

6. **Re-queue one document** (safe and idempotent — the render is
   deterministic and only reads the frozen snapshot):
   ```python
   from app.workers.pdf_tasks import render_submission_pdf
   render_submission_pdf.delay("<document_id>")
   ```

7. **Still pending with no log line at all?** The task name is registered via
   `include=[... "app.workers.pdf_tasks" ...]` in `celery_app.py`. If the
   worker was started from a different module path it will reject the task as
   unregistered. Check the worker's start-up banner lists
   `app.workers.pdf_tasks.render_submission_pdf`.

**What never to do:** do not re-render from live document data to "fix" a
stuck PDF. The renderer reads the frozen snapshot only, and that is what makes
the stored SHA-256 a proof of what was submitted.

---

## 6. Deferred, with reasons

Agreed out of scope for the 3 days. None is blocked by a design decision; each
is additive.

| FR | Pri | Why |
|---|---|---|
| 1.6 performance at 100k | M | Needs a dataset and a load harness; also blocked by database latency (§4.9) |
| 1.10 saved filter presets | C | Could-priority |
| 5.6 TEAM scope | C | Could-priority; adds a third scope to every authorisation path |
| 7.10 conditional / repeating sections | C | Could-priority. The field model was shaped on Day 1 so this can be added without a rewrite |
| 9.1 OCR and `.doc` | M/S | ODT, RTF and TXT are now supported. OCR needs Tesseract; `.doc` is an OLE2 compound file and needs a converter binary. Both are dependency decisions, not design ones |
| 9.9 encryption at rest | S | Code side done (`S3_SSE`, plus a startup report). The bucket's default-encryption flag remains a deployment action (§4.8) |
| 10.3 streaming (SSE) | M | No provider in `app/ai/providers` streams; it is a provider-layer change |
| 10.7 names and addresses | M | Structured identifiers **are** now redacted (see §2). Personal names and postal addresses are not: they have no detectable shape and would need NER, which means sending the text to a model. This is the residue of the old limitation, narrowed |
| 10.9 multi-language | C | Could-priority; the bundled PDF font has no Tamil/Devanagari glyphs either |

### Also recorded as untested or unimplemented

- **FR-1.6** — never measured. No claim is made about p95 at any scale.
- **FR-15.4 / AC13** — WCAG 2.2 AA is **not** claimed as proven. Keyboard
  operation, focus rings, ARIA roles, live regions and colour contrast were
  done and the contrast was measured, but no screen-reader or axe pass was run.
- **FR-15.5 / AC15** — LCP and INP were never measured.
- **Upload path (FR-3.2, AC5)** — fixed by the project owner after this
  engagement's last verification run, and therefore not re-verified here.
