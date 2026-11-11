"""
DocFlow — Approval decision business rules

Workflow Module §6.9 (AP-REJ-01..06), E23, T15. Task P2-11.

Kept in `domain/` because these rules belong to the business, not to a route:
the reject endpoint, the bulk path and any future admin tool must all apply
the same test, and §9.4 requires the check to be server-side and independent
of whatever the client thinks it validated.
"""
from __future__ import annotations

MIN_REASON_CHARS = 10
MAX_REASON_CHARS = 2000
# Enough distinct characters to rule out "aaaaaaaaaa" and "----------"
# without rejecting a terse but real reason like "Wrong total".
MIN_DISTINCT_CHARS = 3


class RejectionReasonError(ValueError):
    """Raised with a message meant to be shown to the approver verbatim."""


def validate_rejection_reason(raw: str | None) -> str:
    """Return the cleaned rejection reason, or raise RejectionReasonError.

    AP-REJ-02 requires a rejection to carry a real explanation, because a
    rejection is terminal (BR-07): the owner cannot resubmit into the same
    run and has only this text to act on. The previous behaviour accepted
    `None` — `DecisionRequest.note` is optional and nothing validated it — so
    a document could be rejected with no reason at all (defect 5).

    "Meaningful" is counted over alphanumeric characters only, so padding a
    reason with spaces or punctuation does not get past the minimum. E23 calls
    out the specific cases: empty, whitespace-only, and a single character
    repeated.
    """
    if raw is None:
        raise RejectionReasonError(
            "A reason is required to reject a document. Explain what is wrong "
            "so the owner knows what to fix."
        )

    reason = raw.strip()
    if not reason:
        raise RejectionReasonError(
            "A reason is required to reject a document. Explain what is wrong "
            "so the owner knows what to fix."
        )

    if len(reason) > MAX_REASON_CHARS:
        raise RejectionReasonError(
            f"The reason is too long ({len(reason)} characters). "
            f"Keep it under {MAX_REASON_CHARS}."
        )

    meaningful = [c for c in reason if c.isalnum()]
    if len(meaningful) < MIN_REASON_CHARS:
        raise RejectionReasonError(
            f"Please give a reason of at least {MIN_REASON_CHARS} characters "
            "so the owner knows what to fix."
        )

    if len({c.casefold() for c in meaningful}) < MIN_DISTINCT_CHARS:
        raise RejectionReasonError(
            "Please give a real reason — repeated characters are not an "
            "explanation the owner can act on."
        )

    return reason
