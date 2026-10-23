"""
DocFlow Backend — AI provider: Google Gemini (REST, v1beta).

Generation:  POST /v1beta/models/{model}:generateContent
Embeddings:  POST /v1beta/models/{model}:batchEmbedContents

The API key is sent as the `x-goog-api-key` header (not a query string) so
it never lands in an access log or a redirect URL.
"""
from __future__ import annotations

import structlog

from app.ai.base import (
    ChatMessage,
    EmbeddingProvider,
    EmbeddingResult,
    GenerationResult,
    LLMProvider,
)
from app.ai.errors import AINotConfiguredError, AIRequestError
from app.ai.providers._http import post_json
from app.config import settings

logger = structlog.get_logger(__name__)

API_ROOT = "https://generativelanguage.googleapis.com/v1beta"

# Chosen per the project's stated requirement ("Gemini 3.1 Flash Lite", free
# tier) and confirmed present in this API's /v1beta/models listing. Model ids
# move faster than code: AI_MODEL overrides this without a code change, and
# an unknown id surfaces as a clear AIRequestError naming the model rather
# than a silent failure.
DEFAULT_CHAT_MODEL = "gemini-3.1-flash-lite"

# gemini-embedding-001 is the embedding model this API version actually
# serves, and it returns 3072-dimensional vectors (verified against a live
# batchEmbedContents call — NOT 768: the older text-embedding-004 id is not
# offered on /v1beta here, so defaulting to it produced a 404).
DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001"
DEFAULT_EMBEDDING_DIM = 3072


def _api_key() -> str:
    key = settings.GEMINI_API_KEY
    if not key:
        raise AINotConfiguredError(
            "GEMINI_API_KEY is not set. Add it to Backend/.env to enable the "
            "AI Agent and AI-assisted document creation."
        )
    return key


def _headers() -> dict[str, str]:
    return {"x-goog-api-key": _api_key(), "Content-Type": "application/json"}


class GeminiProvider(LLMProvider, EmbeddingProvider):
    """Gemini supports both generation and embeddings, so one class
    implements both interfaces; the registry still hands callers the
    narrower type they asked for."""

    name = "gemini"

    @property
    def chat_model(self) -> str:
        return settings.AI_MODEL or DEFAULT_CHAT_MODEL

    @property
    def embedding_model(self) -> str:
        return settings.AI_EMBEDDING_MODEL or DEFAULT_EMBEDDING_MODEL

    @property
    def embedding_dim(self) -> int:
        return settings.AI_EMBEDDING_DIM or DEFAULT_EMBEDDING_DIM

    # ── Generation ──────────────────────────────────────────────────────────

    async def generate(
        self,
        messages: list[ChatMessage],
        *,
        system: str | None = None,
        temperature: float = 0.2,
        max_output_tokens: int = 1024,
    ) -> GenerationResult:
        contents = [
            {
                # Gemini uses "model" where the other vendors use "assistant".
                "role": "model" if m.role == "assistant" else "user",
                "parts": [{"text": m.content}],
            }
            for m in messages
        ]
        payload: dict = {
            "contents": contents,
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_output_tokens,
            },
        }
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}

        model = self.chat_model
        data = await post_json(
            f"{API_ROOT}/models/{model}:generateContent",
            payload,
            headers=_headers(),
            provider="gemini",
        )

        candidates = data.get("candidates") or []
        if not candidates:
            # Most commonly a safety block with no candidate returned.
            feedback = (data.get("promptFeedback") or {}).get("blockReason")
            raise AIRequestError(
                f"Gemini returned no answer"
                + (f" (blocked: {feedback})" if feedback else "")
            )

        candidate = candidates[0]
        parts = (candidate.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts).strip()
        finish = candidate.get("finishReason")
        usage = data.get("usageMetadata") or {}

        return GenerationResult(
            text=text,
            model=model,
            provider=self.name,
            input_tokens=usage.get("promptTokenCount"),
            output_tokens=usage.get("candidatesTokenCount"),
            truncated=finish == "MAX_TOKENS",
            finish_reason=finish,
        )

    # ── Embeddings ──────────────────────────────────────────────────────────

    async def embed(
        self, texts: list[str], *, purpose: str = "document"
    ) -> EmbeddingResult:
        if not texts:
            return EmbeddingResult(
                vectors=[],
                model=self.embedding_model,
                provider=self.name,
                dim=self.embedding_dim,
            )

        model = self.embedding_model
        # RETRIEVAL_DOCUMENT vs RETRIEVAL_QUERY measurably improves recall on
        # Gemini's embedding models — they are trained as an asymmetric pair.
        task_type = "RETRIEVAL_QUERY" if purpose == "query" else "RETRIEVAL_DOCUMENT"
        payload = {
            "requests": [
                {
                    "model": f"models/{model}",
                    "content": {"parts": [{"text": t}]},
                    "taskType": task_type,
                }
                for t in texts
            ]
        }
        data = await post_json(
            f"{API_ROOT}/models/{model}:batchEmbedContents",
            payload,
            headers=_headers(),
            provider="gemini",
        )

        raw = data.get("embeddings") or []
        vectors = [list(e.get("values") or []) for e in raw]
        if len(vectors) != len(texts):
            raise AIRequestError(
                f"Gemini returned {len(vectors)} embeddings for {len(texts)} inputs"
            )

        actual_dim = len(vectors[0]) if vectors and vectors[0] else self.embedding_dim
        if vectors and actual_dim != self.embedding_dim:
            # Don't silently store vectors of an unexpected width — that is
            # exactly how an index ends up with mixed, incomparable spaces.
            raise AIRequestError(
                f"Gemini model '{model}' returned {actual_dim}-dimensional vectors "
                f"but AI_EMBEDDING_DIM expects {self.embedding_dim}. Set "
                f"AI_EMBEDDING_DIM={actual_dim} (and re-embed existing sources)."
            )

        return EmbeddingResult(
            vectors=vectors,
            model=model,
            provider=self.name,
            dim=actual_dim,
        )
