"""
DocFlow Backend — AI provider: Anthropic (Messages API).

Generation: POST /v1/messages

Anthropic exposes no embeddings endpoint, so AnthropicProvider implements
LLMProvider only. A deployment that selects Anthropic for generation must
point AI_EMBEDDING_PROVIDER at a provider that does embeddings (gemini or
openai); the registry raises a clear AIUnsupportedCapabilityError
explaining exactly that rather than failing deep inside the RAG pipeline.
"""
from __future__ import annotations

import structlog

from app.ai.base import ChatMessage, GenerationResult, LLMProvider
from app.ai.errors import AINotConfiguredError, AIRequestError
from app.ai.providers._http import post_json
from app.config import settings

logger = structlog.get_logger(__name__)

API_ROOT = "https://api.anthropic.com/v1"
API_VERSION = "2023-06-01"

DEFAULT_CHAT_MODEL = "claude-sonnet-4-5"


def _headers() -> dict[str, str]:
    key = settings.ANTHROPIC_API_KEY
    if not key:
        raise AINotConfiguredError(
            "ANTHROPIC_API_KEY is not set but AI_PROVIDER is 'anthropic'."
        )
    return {
        "x-api-key": key,
        "anthropic-version": API_VERSION,
        "Content-Type": "application/json",
    }


class AnthropicProvider(LLMProvider):
    name = "anthropic"

    @property
    def chat_model(self) -> str:
        return settings.AI_MODEL or DEFAULT_CHAT_MODEL

    async def generate(
        self,
        messages: list[ChatMessage],
        *,
        system: str | None = None,
        temperature: float = 0.2,
        max_output_tokens: int = 1024,
    ) -> GenerationResult:
        model = self.chat_model
        payload: dict = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "max_tokens": max_output_tokens,
            "temperature": temperature,
        }
        if system:
            # Anthropic takes the system prompt as a top-level parameter,
            # not as a message in the conversation array.
            payload["system"] = system

        data = await post_json(
            f"{API_ROOT}/messages", payload, headers=_headers(), provider="anthropic"
        )

        blocks = data.get("content") or []
        text = "".join(
            b.get("text", "") for b in blocks if b.get("type") == "text"
        ).strip()
        if not text:
            raise AIRequestError("Anthropic returned no text content")

        usage = data.get("usage") or {}
        stop_reason = data.get("stop_reason")
        return GenerationResult(
            text=text,
            model=model,
            provider=self.name,
            input_tokens=usage.get("input_tokens"),
            output_tokens=usage.get("output_tokens"),
            truncated=stop_reason == "max_tokens",
            finish_reason=stop_reason,
        )
