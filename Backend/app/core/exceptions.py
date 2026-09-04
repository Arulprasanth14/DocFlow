"""
DocFlow Backend — Core: Custom Exceptions
All custom HTTP exceptions with consistent error shapes.
Import and raise these throughout the codebase — never use raw HTTPException.
"""
from __future__ import annotations

from fastapi import HTTPException, status


class DocFlowException(HTTPException):
    """Base class for all DocFlow HTTP exceptions."""
    def __init__(self, detail: str, **kwargs):
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

    def __init__(self, detail: str = "Authentication required"):
        super().__init__(detail=detail, headers={"WWW-Authenticate": "Bearer"})


class ForbiddenException(DocFlowException):
    """403 — Authenticated but not permitted."""
    status_code = status.HTTP_403_FORBIDDEN

    def __init__(self, detail: str = "You do not have permission to perform this action"):
        super().__init__(detail=detail)


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


class RateLimitException(DocFlowException):
    """429 — Rate limit exceeded."""
    status_code = status.HTTP_429_TOO_MANY_REQUESTS

    def __init__(self, detail: str = "Rate limit exceeded. Please slow down."):
        super().__init__(detail=detail)


class ServiceUnavailableException(DocFlowException):
    """503 — External dependency unavailable."""
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    def __init__(self, service: str = "Service"):
        super().__init__(detail=f"{service} is temporarily unavailable")


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
