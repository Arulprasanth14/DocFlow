# DECISIONS.md — decisions taken during the Workflow Module build

> One line of reasoning per decision, for later review.
> Context: `docs/DocFlow_Workflow_Implementation_Plan.md` (the §3 Discovery Report).
> Rule applied where the spec was silent or conflicted with existing code: **least privilege —
> when unsure, choose the safer option.**
>
> **Permission-impact legend:** `=` no change · `↓` tightened (safer) · `↑` loosened (**must be
> flagged in the phase report**).

---

## Delegated to the agent (Q3–Q7)

### Q3 — `Delegation` exists but §2.1 lists delegation as out of scope ` ↓ `
**Decision:** Keep the `Delegation` model, its data and its endpoint — delete nothing. Add the same
hard authority guards that `ApprovalService.decide()` already applies (`_enforce_approval_authority`:
no trainees, no self-approval, active member of the org) to `ApprovalService.delegate()`, which
currently lacks them. Do **not** present delegation as a Workflow-Module v1 feature; admin
reassignment (`AP-SLA-06`) is the documented and only supported way to change an active stage's
approver.
**Why:** AP-SLA-06 says reassignment is "the only supported way to change the approver of an active
stage in v1", but §3.2 forbids deleting existing functionality without written approval — so the
safe intersection is to keep it working while closing the gap that let a step be delegated to
someone who could never have been assigned it in the first place.
**Permission effect:** tightened only. Nobody gains the ability to approve or sign.

### Q4 — Trainees can never be approvers, but §5.5 field B assumes any org user ` = `
**Decision:** Keep DocFlow's exclusion. Trainees stay unselectable in the approver picker and
rejected at save time and at runtime resolution. Record it as a documented DocFlow narrowing of
§5.5 field B, and make the preflight blocker message name it explicitly rather than failing with a
generic "no approver resolved".
**Why:** `SYSTEM_ROLES` states a trainee "never sees the Approvals module, approval notifications,
or approval APIs"; granting them approval authority to satisfy the spec would be a real privilege
escalation, and least privilege decides it.
**Permission effect:** none — preserves existing behaviour.

### Q5 — `DocumentStatus` has ten values; §4.3 B names six ` = `
**Decision:** Keep all ten. Map the spec's six onto existing values rather than renaming or
dropping anything: `DRAFT`→Draft, `PENDING`→In Review, `SENT_BACK`→Changes Requested,
`APPROVED`→Approved, `REJECTED`→Rejected, `CANCELLED`→Withdrawn. `READY`, `SUBMITTED`, `ARCHIVED`,
`EXPIRED`, `REVOKED` and `FINALIZED` remain DocFlow extensions with no spec counterpart. The UI
labels the six; the enum keeps the ten.
**Why:** Renaming or removing enum values is a destructive migration on live data, which is both
outside the approved additive-only scope and unnecessary — a presentation-layer mapping satisfies
§4.3 B without touching a single row.
**Permission effect:** none.

### Q6 — Do sub-departments inherit `requires_signature`? (§15.1 asks; departments are hierarchical) ` ↓ `
**Decision:** **Yes — inherit.** A department requires signing if it, or **any ancestor** via
`Department.parent_id`, has `requires_signature = true`. Resolution walks up the tree with a depth
cap and is computed server-side.
**Why:** The alternative fails unsafely — "Finance → Accounts Payable" would silently accept an
approval with no signature, which is exactly the signing bypass G9 warns about ("Signing bypass via
manager rule or name change"). Inheriting fails toward requiring a signature.
**Permission effect:** tightened — strictly more stages will demand a signature, never fewer.

### Q7 — `ApprovalRevocation` / recall and `FINALIZED` go beyond the spec ` = `
**Decision:** Keep both, unchanged, and document them as DocFlow features outside the spec's model.
Revocation already honours BR-09 — it never rewrites the original `decision` field, marking it
revoked or superseded instead and preserving it for audit — so it is compatible with the
specification rather than in conflict with it. One guard added in Phase 2: a recall must not be
usable to reopen a run that is already terminal (`Rejected` / `Withdrawn`) except through an Org
Admin's explicit resolution, which is how the `requested` path already works.
**Why:** It is additional control rather than a loosening, and BR-09 compliance means there is
nothing to fix; removing it would destroy an audit capability the organisation may already rely on.
**Permission effect:** none; one terminal-state guard tightened.

---

## Taken before planning (confirmed by the user)

| # | Decision | Why |
|---|---|---|
| D1 | `users.manager_id` with a department-head fallback when NULL | A real per-person manager is what WF-STG-23/24 need; the fallback stops every existing org from breaking on day one |
| D2 | Full workflow treatment for state-changing requirements, compact steps for UI ones | Keeps the plan executable without a 450-section document |
| D3 | `pdfjs-dist`, pinned, added only when Phase 3 needs it | AP-VWR-01 names it; text-anchored highlights need a text layer |
| D4 | Keep bulk approve, but route it through the hardened single-decision service; skip signing-required stages and report them | §2.1 excludes it, but it already exists and works; routing it through one code path means it cannot bypass authorization or signing |

---

## Answered by the audit rather than by decision

| ID | Question | Finding |
|---|---|---|
| O-1 | Does a signing process exist that binds to a document hash? | **Yes** — `app/core/signing.py`, RSA-PSS-SHA256 over a canonical payload binding approver, document-version hash, decision, step and timestamp. No provider integration needed |
| O-6 | Can chat render custom cards for sharing? | **No** — `ChatMessage` has only `body` + `attachment_ids`, so the deep-link text message is forced, not chosen |
| O-15 | Is email a notification channel today? | **Yes** — Celery → SMTP with templates, Mailpit in dev, per-org channel flags |

---

## Still with Product (not the agent's to decide)

`O-2` rejection policy (**blocking Phase 2**) · `O-4` approved AI provider and data-processing
terms (**blocking the AI work**) · `O-7` cross-department approvers · `O-9` calendar vs business
hours · `O-10` whether Org Admins may read private workflow definitions (today they can — see the
flag in the Phase 1 report).
