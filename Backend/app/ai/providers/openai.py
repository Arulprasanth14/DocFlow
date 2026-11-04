"""
DocFlow Backend — AI provider: OpenAI (REST v1).

Generation:  POST /v1/chat/completions
Embeddings:  POST /v1/embeddings
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

API_ROOT = "https://api.openai.com/v1"

DEFAULT_CHAT_MODEL = "gpt-4o-mini"
DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
DEFAULT_EMBEDDING_DIM = 1536


def _headers() -> dict[str, str]:
    key = settings.OPENAI_API_KEY
    if not key:
        raise AINotConfiguredError(
            "OPENAI_API_KEY is not set but AI_PROVIDER/AI_EMBEDDING_PROVIDER "
            "is 'openai'."
        )
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


class OpenAIProvider(LLMProvider, EmbeddingProvider):
    name = "openai"

    @property
    def chat_model(self) -> str:
        return settings.AI_MODEL or DEFAULT_CHAT_MODEL

    @property
    def embedding_model(self) -> str:
        return settings.AI_EMBEDDING_MODEL or DEFAULT_EMBEDDING_MODEL

    @property
    def embedding_dim(self) -> int:
        return settings.AI_EMBEDDING_DIM or DEFAULT_EMBEDDING_DIM

    async def generate(
        self,
        messages: list[ChatMessage],
        *,
        system: str | None = None,
        temperature: float = 0.2,
        max_output_tokens: int = 1024,
    ) -> GenerationResult:
        wire: list[dict] = []
        if system:
            wire.append({"role": "system", "content": system})
        wire.extend({"role": m.role, "content": m.content} for m in messages)

        model = self.chat_model
        data = await post_json(
            f"{API_ROOT}/chat/completions",
            {
                "model": model,
                "messages": wire,
                "temperature": temperature,
                "max_tokens": max_output_tokens,
            },
            headers=_headers(),
            provider="openai",
        )

        choices = data.get("choices") or []
        if not choices:
            raise AIRequestError("OpenAI returned no choices")
        choice = choices[0]
        usage = data.get("usage") or {}
        finish = choice.get("finish_reason")

        return GenerationResult(
            text=((choice.get("message") or {}).get("content") or "").strip(),
            model=model,
            provider=self.name,
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
            truncated=finish == "length",
            finish_reason=finish,
        )

    async def embed(
        self, texts: list[str], *, purpose: str = "document"
    ) -> EmbeddingResult:
        # OpenAI's embedding models are symmetric — no query/document split.
        if not texts:
            return EmbeddingResult(
                vectors=[], model=self.embedding_model, provider=self.name,
                dim=self.embedding_dim,
            )

        model = self.embedding_model
        payload: dict = {"model": model, "input": texts}
        # text-embedding-3-* support native dimension reduction; asking for
        # the configured width keeps stored vectors consistent.
        if settings.AI_EMBEDDING_DIM and model.startswith("text-embedding-3"):
            payload["dimensions"] = settings.AI_EMBEDDING_DIM

        data = await post_json(
            f"{API_ROOT}/embeddings", payload, headers=_headers(), provider="openai"
        )

        rows = sorted(data.get("data") or [], key=lambda r: r.get("index", 0))
        vectors = [list(r.get("embedding") or []) for r in rows]
        if len(vectors) != len(texts):
            raise AIRequestError(
                f"OpenAI returned {len(vectors)} embeddings for {len(texts)} inputs"
            )

        actual_dim = len(vectors[0]) if vectors and vectors[0] else self.embedding_dim
        if vectors and actual_dim != self.embedding_dim:
            raise AIRequestError(
                f"OpenAI model '{model}' returned {actual_dim}-dimensional vectors "
                f"but AI_EMBEDDING_DIM expects {self.embedding_dim}."
            )

        usage = data.get("usage") or {}
        return EmbeddingResult(
            vectors=vectors,
            model=model,
            provider=self.name,
            dim=actual_dim,
            input_tokens=usage.get("prompt_tokens"),
        )
