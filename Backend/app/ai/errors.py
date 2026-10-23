"""
DocFlow Backend — AI: typed provider errors.

Providers translate vendor-specific failures into these so callers can react
to the CLASS of failure without knowing which vendor is configured. None of
these messages ever include the API key or the raw request body.
"""
from __future__ import annotations


class AIError(Exception):
    """Base for every AI failure."""

    # Whether retrying the same request could plausibly succeed.
    retryable: bool = False


class AINotConfiguredError(AIError):
    """
    No API key (or no usable model) for the selected provider.

    Raised instead of attempting a call, so the UI can show "the Agent is
    not configured on this server" rather than a generic 500 — and so the
    rest of the app keeps working with AI features cleanly disabled.
    """


class AIRateLimitError(AIError):
    """Provider returned 429 / quota exhausted. Retryable after a delay."""

    retryable = True

    def __init__(self, message: str, retry_after_seconds: float | None = None) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class AITransientError(AIError):
    """5xx, timeout, or connection failure — worth retrying."""

    retryable = True


class AIRequestError(AIError):
    """
    The request itself was rejected (400, unknown model, input too long,
    safety block). Retrying unchanged will fail the same way.
    """


class AIUnsupportedCapabilityError(AIError):
    """
    The configured provider cannot do what was asked — e.g. embeddings from
    a provider that only offers generation. Surfaced explicitly so the fix
    (point AI_EMBEDDING_PROVIDER at a provider that supports it) is obvious.
    """
