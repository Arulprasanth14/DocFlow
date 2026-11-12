"""
DocFlow Backend — Core: Custom Exceptions
All custom HTTP exceptions with consistent error shapes.
Import and raise these throughout the codebase — never use raw HTTPException.
"""
from __future__ import annotations

from typing import NamedTuple, Sequence

from fastapi import HTTPException, status


class DocFlowException(HTTPException):
    """Base class for all DocFlow HTTP exceptions.

    `code` is an optional machine-readable error code (e.g.
    ACCOUNT_DEACTIVATED, SESSION_REVOKED). The frontend reacts differently to
    those two than to a plain 401/403 - it must not retry, and it must show
    "your access was changed" rather than "session expired" - and a prose
    detail string cannot carry that distinction. Omitted everywhere it is not
    needed, and the response body only grows a `code` field when it is set.
    """

    #: Default for subclasses whose own __init__ does not take a code.
    code: str | None = None

    def __init__(self, detail: str, *, code: str | None = None, **kwargs):
        self.code = code
        super().__init__(status_code=self.status_code, detail=detail, **kwargs)


class NotFoundException(DocFlowException):
    """404 — Resource not found."""
    status_code = status.HTTP_404_NOT_FOUND

    def __init__(self, resource: str = "Resource", resource_id: str | None = None):
        detail = f"{resource} not found"
        if resource_id:
            detail = f"{resource} '{resource_id}' not found"
        super().__init__(detail=detail)


class UnauthorizedException(DocFlowException):
    """401 — Not authenticated."""
    status_code = status.HTTP_401_UNAUTHORIZED

    def __init__(self, detail: str = "Authentication required", *, code: str | None = None):
        super().__init__(detail=detail, code=code, headers={"WWW-Authenticate": "Bearer"})


class ForbiddenException(DocFlowException):
    """403 — Authenticated but not permitted."""
    status_code = status.HTTP_403_FORBIDDEN

    def __init__(
        self,
        detail: str = "You do not have permission to perform this action",
        *,
        code: str | None = None,
    ):
        super().__init__(detail=detail, code=code)


class ConflictException(DocFlowException):
    """409 — Business rule conflict."""
    status_code = status.HTTP_409_CONFLICT

    def __init__(self, detail: str = "Conflict with current state"):
        super().__init__(detail=detail)


class ValidationException(DocFlowException):
    """422 — Semantic validation error (beyond Pydantic schema)."""
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY

    def __init__(self, detail: str = "Validation error"):
        super().__init__(detail=detail)


UnprocessableEntityException = ValidationException


class FieldError(NamedTuple):
    """
    One blocked field, in the shape the UI needs to point at it.

    `field` is the form control's name (the client maps it to an element id so
    a "Fix this" link can focus it), `code` is stable and machine-readable so
    the wording can change without breaking the client, and `message` is what
    the person reads.
    """
    field: str
    code: str
    message: str

    def as_dict(self) -> dict[str, str]:
        return {"field": self.field, "code": self.code, "message": self.message}


class FieldValidationException(ValidationException):
    """
    422 with a per-field breakdown.

    The plain `detail` string stays populated so every existing caller that
    only reads `error` still shows something sensible; `fields` is additive.
    """

    def __init__(self, fields: Sequence[FieldError], detail: str | None = None):
        self.fields = list(fields)
        if detail is None:
            detail = (
                self.fields[0].message if len(self.fields) == 1
                else f"{len(self.fields)} things need fixing before you can continue."
            )
        super().__init__(detail=detail)


class GoneException(DocFlowException):
    """410 — the endpoint existed and has been removed.

    Distinct from 404 on purpose: a client calling a deprecated endpoint needs
    to know it is gone for good, not that it might be a typo.
    """
    status_code = status.HTTP_410_GONE

    def __init__(self, detail: str = "This endpoint has been removed", *, code: str | None = None):
        super().__init__(detail=detail, code=code)


class RateLimitException(DocFlowException):
    """429 — Rate limit exceeded."""
    status_code = status.HTTP_429_TOO_MANY_REQUESTS

    def __init__(
        self,
        detail: str = "Rate limit exceeded. Please slow down.",
        *,
        code: str | None = None,
        headers: dict[str, str] | None = None,
    ):
        # `headers` carries Retry-After: the client is told how long to wait
        # rather than being left to guess or hammer.
        super().__init__(detail=detail, code=code, headers=headers)


class ServiceUnavailableException(DocFlowException):
    """503 — External dependency unavailable."""
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    def __init__(self, service: str = "Service", *, code: str | None = None):
        super().__init__(detail=f"{service} is temporarily unavailable", code=code)


class WorkflowException(ConflictException):
    """409 — Workflow-specific conflict (invalid state transition)."""
    def __init__(self, detail: str = "Invalid workflow operation"):
        super().__init__(detail=detail)


class DocumentStatusException(ConflictException):
    """409 — Document cannot be modified in its current status."""
    def __init__(self, current_status: str, allowed_statuses: list[str]):
        detail = (
            f"Document is in '{current_status}' status. "
            f"Operation requires status in: {allowed_statuses}"
        )
        super().__init__(detail=detail)
