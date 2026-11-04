# PROJECT_CONTEXT — what DocFlow is and the rules it enforces
> Purpose: product, roles, lifecycle and business rules, as implemented in code (not as wished).
> Read: before changing any workflow/approval rule, role/permission, document type or lifecycle status. Technical layout is in `ARCHITECTURE.md`.

## Product
- Multi-tenant platform where an **organization** creates documents (leave requests, POs, contracts… configurable **document types** with dynamic form schemas), routes them through admin-configured **approval workflows**, and keeps a signed, auditable trail.
- Differentiators actually in code: configurable multi-stage templates with rule-based approver resolution; RSA-PSS signature on every decision; revocation/recall + explicit finalize; per-document workflow chat; org-scoped RAG "Agent" over admin-managed legal knowledge; AI-assisted draft generation (draft only, never auto-submitted).
- Origin: internship project (see old `AUDIT/PROJECT_CONTEXT.md` §1 for the academic framing). Target users: staff of an org (workers, trainees, HR, admin).
- Many comments cite "requirements report §x.y" / "architecture §x". TODO(verify): the source documents (`DocFlow-System-Architecture.md`, requirements report) are not in the repo.

## Roles (source: `Backend/app/domain/enums.py::SYSTEM_ROLES`, fixed set, no custom-role builder)
Role names in DB/JWT: `admin` (Main Administrator), `hr`, `worker`, `trainee`. Plus platform `is_superadmin` (bypasses ALL permission/role checks; `AuthUser` in `domain/permissions.py`). "Approver/Manager" is NOT a role: approver = whoever a `StageApproverRule` resolves to on a step. Legacy `UserRole` enum (member/department_admin/super_admin) is unused for org RBAC.

| Permission | admin | hr | worker | trainee |
|---|:-:|:-:|:-:|:-:|
| documents:create / read / edit / submit / comment | ✓ | ✓ | ✓ | ✓ |
| documents:cancel | ✓ | ✓ | ✓ | – |
| documents:delete | ✓ | – | – | – |
| workflows:read | ✓ | ✓ | ✓ | ✓ |
| workflows:admin | ✓ | – | – | – |
| approvals:decide / approvals:delegate | ✓ | ✓ | ✓ | – |
| chat:read / chat:send, uploads:create | ✓ | ✓ | ✓ | ✓ |
| analytics:read | ✓ | ✓ | ✓ (own scope) | ✓ (own scope) |
| analytics:export, admin:audit | ✓ | – | – | – |
| admin:users, admin:orgs, admin:doc_types, admin:workflow_templates | ✓ | ✓ | – | – |
| admin:roles | ✓ | ✓ (read-only in practice) | – | – |
| members:invite_standard (worker/trainee) | ✓ | ✓ | – | – |
| members:invite_hr, members:delete, agent:knowledge_manage | ✓ | – | – | – |

Other verified role rules:
- Roles are fixed: every mutating role endpoint in `routers/organizations.py` rejects all callers (TODO(verify) exact status/behavior at lines ~288-360). Main-Admin-only screens: Roles & Perms and Agent Knowledge (`App.tsx` + `admin.py::_require_main_admin` + `AgentService.assert_can_manage_knowledge`).
- JWT embeds a role/permission snapshot (valid up to `ACCESS_TOKEN_EXPIRE_MINUTES`=120). Approval authority checks re-read the role live from DB.
- Frontend route guards (`ProtectedRoute`) are UX only; the backend is the enforcement point.

## Document lifecycle
`DocumentStatus` (`models/document.py`, VARCHAR column — adding values needs no migration):

| Status | How reached (verified) |
|---|---|
| `draft` | `DocumentService.create_document` (unless `submit_immediately`) |
| `submitted` | transient inside `submit_document` before the workflow engine takes over |
| `pending` | `WorkflowService.start_workflow` (instance `in_progress`) |
| `sent_back` | an approver decides `changes_requested` (instance `changes_requested`) |
| `approved` | last stage gate passed (`advance_stage`; instance `approved`) |
| `rejected` | an approver rejects (instance `rejected`) |
| `revoked` | approval revoked/recall approved (`approval_service.revoke_decision` / `resolve_recall`) |
| `finalized` | explicit `finalize_workflow` (only from `approved`) |
| `cancelled` | `WorkflowService.cancel` |
| `ready`, `archived`, `expired` | defined, no writer found. TODO(verify) intended use |

Flow: `draft → (submit) → submitted → pending → approved → finalized`; `pending → sent_back → (revise-and-resume) → pending`; `pending → rejected`; `pending/approved → revoked/recall`.
`WorkflowInstanceStatus` adds `recall_requested`, `escalated`, legacy `active/completed/suspended`. Only `draft` documents can be submitted. Revise-and-resume only from `sent_back`/`submitted`.

## Key business rules (all verified in code)
**Routing** (`services/workflow_service.py`)
- Template = ordered `WorkflowStage`s (`sequence_order`); the template is **frozen as a snapshot** onto each instance at start.
- Approver resolution per stage via `StageApproverRule.rule_type`: `specific_user`, `role_in_department`, `manager_of_requester` (department head), `dynamic_by_amount_threshold` (**NOT implemented**, returns no approvers and logs a warning; a stage with only this rule stalls).
- Trainees are stripped from resolved approvers AND rejected at template validation (`template_service._reject_trainee_approvers`).
- Stage gate: stage passes when counted approvals ≥ `min_approvals_required`; then next stage, else instance → `approved`.
- Stage `requires_signature` ⇒ approving needs a `signature` payload (422 otherwise). Regardless, every decision is cryptographically signed (RSA-PSS-SHA256, `core/signing.py`).
- SLA: `sla_hours` sets `due_at` on steps; Celery beat `check_sla_breaches` (every 15 min) writes `SLAEvent` rows and notifies.
- "Peer-to-peer" routing is not a named feature in code; routing is rule-based as above. TODO(verify) what the requirement means.

**Deciding** (`services/approval_service.py::decide`)
- Only the step's assigned approver or an **active delegate** may decide; a step already decided → 409.
- Trainees can never decide (checked live in DB). Self-approval (actor == submitter) blocked unless `Organization.settings["allow_self_approval"]` is true.
- `changes_requested`: instance + doc → sent back, current stage unchanged, a `workflow_context` conversation is auto-created for requester + approver. Resume continues at the SAME stage (earlier approvals untouched).
- `rejected`: instance + doc → rejected, no further stages.

**Revocation / finalize** (§6.5/6.6)
- Only the deciding approver (or delegate) may revoke; finalized workflows cannot be revoked; step rows are never deleted/rewritten (`revoked_at` flag, `is_counted`).
- Nothing downstream yet ⇒ immediate revoke, doc `revoked` back to owner. Already moved on ⇒ recall **request**, instance `recall_requested`; resolved only by admin/hr/superadmin (approve invalidates the decision + downstream ones; deny resumes).
- Finalize requires instance `approved`, no pending steps, no open recalls, all signatures verify; allowed for a final-stage approver, admin/hr, superadmin.
- Cancel: document owner only, and not for approved/rejected/cancelled instances.

**Orgs & membership**
- Org names are unique; a signed-in user with no org either creates one (becomes `admin`, default setup seeded via `AccountService._seed_default_setup`) or sends a **join request** by org name; admin/hr review (`join_request_service`). Account states are computed by `AccountService.get_account_state`.
- Notifications are fired only from `app/subscribers.py` (via `EventBus`) for status/chat events, to avoid duplicates.
- Documents are visible to: submitter, anyone in-org with `documents:read` (see `can_access_document`; `document_service.can_user_access_document` adds department logic, TODO(verify) exact scope).

## Glossary
| Term | Meaning |
|---|---|
| Org | Tenant; all data scoped by `org_id` |
| Document type | Org-defined category + `form_schema` (dynamic form) |
| Workflow template / stage | Reusable approval route / one step-group in it |
| Workflow instance | A template run attached to one document |
| Approval step | One approver's pending/decided row for a stage and round |
| Round | Increments when work resumes after changes requested |
| Delegation | Approver lets another user decide their steps |
| Recall | Request to undo an approval after the doc moved on |
| Finalize | Explicit closing of an approved workflow |
| Agent | Org-scoped RAG assistant over admin-uploaded legal knowledge |
| Main Admin | Role `admin` |

## How to use this when asked to…
- **Change a workflow rule:** edit the service (`approval_service.py`/`workflow_service.py`), not the router or frontend; keep the live-DB trainee/self-approval gates; add a test in `Backend/tests/` (see `test_approval_authorization.py`, `test_signatures_and_revocation.py`, `test_workflow_ownership.py`); update the lifecycle table above.
- **Add a role/permission:** ask first (RBAC). A permission = add to `Permission` enum + `SYSTEM_ROLES` + a data migration for existing orgs (see `d4a1f0c2b7e9_migrate_legacy_roles_to_four_roles.py`) + `require_permission(...)` on routes + frontend `hasPermission` gating. Roles are intentionally fixed at 4.
- **Add a document type:** types are data (admin UI `DocumentTypesAdminPage`, `POST /document-types`); no code change needed unless the form field kinds change (`DynamicFormRenderer.tsx`, `validate_form_data` in `document_service.py`).
- **Add a lifecycle status:** add to `DocumentStatus` (no migration), set it in exactly one service, update `analytics_service` status grouping and frontend status badges/filters.
