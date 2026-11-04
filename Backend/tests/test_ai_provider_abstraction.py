"""
Covers the provider-independent AI layer: the registry seam that makes
Gemini/OpenAI/Anthropic interchangeable, graceful handling of missing
configuration, and the embedding-compatibility rules.

These tests never reach the network. The provider ADAPTERS are exercised
against their request/response contracts by monkeypatching the shared HTTP
helper, so a wrong field name or a mis-handled error code is caught here
rather than at runtime against a live key.
"""
from __future__ import annotations

import pytest

from app.ai import base, registry
from app.ai.errors import (
    AINotConfiguredError,
    AIRateLimitError,
    AIRequestError,
    AITransientError,
    AIUnsupportedCapabilityError,
)
from app.ai.providers import anthropic as anthropic_mod
from app.ai.providers import gemini as gemini_mod
from app.ai.providers import openai as openai_mod
from app.config import settings


@pytest.fixture
def ai_env(monkeypatch):
    """Helper to set AI settings for one test."""

    def _set(**kwargs):
        for key, value in kwargs.items():
            monkeypatch.setattr(settings, key, value, raising=False)

    # Start from a clean slate so a real key in .env can't leak into a test.
    _set(
        AI_PROVIDER="gemini",
        AI_EMBEDDING_PROVIDER="",
        GEMINI_API_KEY="",
        OPENAI_API_KEY="",
        ANTHROPIC_API_KEY="",
        AI_MODEL="",
        AI_EMBEDDING_MODEL="",
        AI_EMBEDDING_DIM=0,
    )
    return _set


# ── Registry / provider selection ───────────────────────────────────────────

def test_each_provider_is_selectable_by_configuration(ai_env):
    """Switching vendor is an env change — the registry returns the matching
    adapter and nothing else in the app needs to know which one it is."""
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="k")
    assert isinstance(registry.get_llm_provider(), gemini_mod.GeminiProvider)

    ai_env(AI_PROVIDER="openai", OPENAI_API_KEY="k")
    assert isinstance(registry.get_llm_provider(), openai_mod.OpenAIProvider)

    ai_env(AI_PROVIDER="anthropic", ANTHROPIC_API_KEY="k")
    assert isinstance(registry.get_llm_provider(), anthropic_mod.AnthropicProvider)


def test_every_provider_implements_the_interface(ai_env):
    ai_env(GEMINI_API_KEY="k", OPENAI_API_KEY="k", ANTHROPIC_API_KEY="k")
    for name in registry.SUPPORTED_PROVIDERS:
        provider = registry.get_llm_provider(name)
        assert isinstance(provider, base.LLMProvider)
        assert provider.chat_model  # a default model is always resolvable


def test_missing_key_raises_not_configured_not_a_crash(ai_env):
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="")
    with pytest.raises(AINotConfiguredError) as exc:
        registry.get_llm_provider()
    # The message must tell the operator exactly what to set.
    assert "GEMINI_API_KEY" in str(exc.value)


def test_unknown_provider_is_rejected_clearly(ai_env):
    ai_env(AI_PROVIDER="llama-via-carrier-pigeon")
    with pytest.raises(AINotConfiguredError) as exc:
        registry.get_llm_provider()
    assert "Unknown AI_PROVIDER" in str(exc.value)


def test_anthropic_embeddings_are_reported_as_unsupported(ai_env):
    """Anthropic has no embeddings endpoint — that must surface as a clear
    capability error naming the fix, not fail deep inside the RAG pipeline."""
    ai_env(AI_PROVIDER="anthropic", ANTHROPIC_API_KEY="k", AI_EMBEDDING_PROVIDER="anthropic")
    with pytest.raises(AIUnsupportedCapabilityError) as exc:
        registry.get_embedding_provider()
    assert "does not offer embeddings" in str(exc.value)
    assert "AI_EMBEDDING_PROVIDER" in str(exc.value)


def test_generation_and_embeddings_can_use_different_providers(ai_env):
    """A deployment may generate with one vendor and embed with another."""
    ai_env(
        AI_PROVIDER="anthropic",
        ANTHROPIC_API_KEY="k",
        AI_EMBEDDING_PROVIDER="gemini",
        GEMINI_API_KEY="k",
    )
    assert isinstance(registry.get_llm_provider(), anthropic_mod.AnthropicProvider)
    assert isinstance(registry.get_embedding_provider(), gemini_mod.GeminiProvider)


def test_models_and_dimensions_are_env_configurable(ai_env):
    ai_env(
        AI_PROVIDER="gemini",
        GEMINI_API_KEY="k",
        AI_MODEL="gemini-custom-x",
        AI_EMBEDDING_MODEL="embed-custom-x",
        AI_EMBEDDING_DIM=256,
    )
    llm = registry.get_llm_provider()
    emb = registry.get_embedding_provider()
    assert llm.chat_model == "gemini-custom-x"
    assert emb.embedding_model == "embed-custom-x"
    assert emb.embedding_dim == 256


def test_describe_configuration_never_leaks_the_key(ai_env):
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="super-secret-key-value")
    caps = registry.describe_configuration()
    blob = repr(caps)
    assert "super-secret-key-value" not in blob
    assert caps.provider == "gemini"
    assert caps.supports_generation is True


def test_describe_configuration_reports_missing_config_without_raising(ai_env):
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="")
    caps = registry.describe_configuration()
    assert caps.supports_generation is False
    assert caps.supports_embeddings is False
    assert any("GEMINI_API_KEY" in n for n in caps.notes)


def test_ai_enabled_checks_the_selected_provider_not_any_key(ai_env):
    """`ai_enabled` must reflect the SELECTED provider: having an OpenAI key
    while AI_PROVIDER=gemini is not a working configuration."""
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="", OPENAI_API_KEY="k")
    assert settings.ai_enabled is False
    ai_env(GEMINI_API_KEY="k")
    assert settings.ai_enabled is True


# ── Adapter request/response contracts ──────────────────────────────────────

@pytest.fixture
def capture_http(monkeypatch):
    """Intercept the shared HTTP helper; return (calls, set_response)."""
    calls: list[dict] = []
    state: dict = {"response": {}, "raise": None}

    async def fake_post_json(url, payload, *, headers=None, params=None, provider="ai", **kw):
        calls.append(
            {"url": url, "payload": payload, "headers": headers or {}, "provider": provider}
        )
        if state["raise"]:
            raise state["raise"]
        return state["response"]

    for mod in (gemini_mod, openai_mod, anthropic_mod):
        monkeypatch.setattr(mod, "post_json", fake_post_json)

    def set_response(resp=None, raise_=None):
        state["response"] = resp or {}
        state["raise"] = raise_

    return calls, set_response


async def test_gemini_generation_contract(ai_env, capture_http):
    calls, set_response = capture_http
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="k")
    set_response(
        {
            "candidates": [
                {"content": {"parts": [{"text": "Hello there"}]}, "finishReason": "STOP"}
            ],
            "usageMetadata": {"promptTokenCount": 7, "candidatesTokenCount": 3},
        }
    )

    provider = registry.get_llm_provider()
    result = await provider.generate(
        [base.ChatMessage(role="user", content="hi")], system="be brief"
    )

    assert result.text == "Hello there"
    assert result.provider == "gemini"
    assert result.input_tokens == 7 and result.output_tokens == 3
    assert result.truncated is False

    call = calls[-1]
    # Key travels in a header, never the query string (no access-log leak).
    assert call["headers"]["x-goog-api-key"] == "k"
    assert "key=" not in call["url"]
    # System prompt uses Gemini's systemInstruction, and assistant turns are
    # renamed to Gemini's "model" role.
    assert call["payload"]["systemInstruction"]["parts"][0]["text"] == "be brief"
    assert call["payload"]["contents"][0]["role"] == "user"


async def test_gemini_renames_assistant_role_to_model(ai_env, capture_http):
    calls, set_response = capture_http
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="k")
    set_response({"candidates": [{"content": {"parts": [{"text": "ok"}]}}]})

    provider = registry.get_llm_provider()
    await provider.generate(
        [
            base.ChatMessage(role="user", content="q1"),
            base.ChatMessage(role="assistant", content="a1"),
            base.ChatMessage(role="user", content="q2"),
        ]
    )
    roles = [c["role"] for c in calls[-1]["payload"]["contents"]]
    assert roles == ["user", "model", "user"]


async def test_gemini_blocked_prompt_surfaces_as_request_error(ai_env, capture_http):
    _calls, set_response = capture_http
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="k")
    set_response({"candidates": [], "promptFeedback": {"blockReason": "SAFETY"}})

    provider = registry.get_llm_provider()
    with pytest.raises(AIRequestError) as exc:
        await provider.generate([base.ChatMessage(role="user", content="hi")])
    assert "SAFETY" in str(exc.value)


async def test_gemini_embedding_contract_and_task_types(ai_env, capture_http):
    calls, set_response = capture_http
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="k", AI_EMBEDDING_DIM=3)
    set_response({"embeddings": [{"values": [0.1, 0.2, 0.3]}]})

    provider = registry.get_embedding_provider()
    out = await provider.embed(["some text"], purpose="query")

    assert out.vectors == [[0.1, 0.2, 0.3]]
    assert out.dim == 3
    assert out.provider == "gemini"
    # Query vs document side of the asymmetric retrieval pair.
    assert calls[-1]["payload"]["requests"][0]["taskType"] == "RETRIEVAL_QUERY"

    await provider.embed(["some text"], purpose="document")
    assert calls[-1]["payload"]["requests"][0]["taskType"] == "RETRIEVAL_DOCUMENT"


async def test_embedding_dimension_mismatch_is_refused(ai_env, capture_http):
    """Storing vectors of an unexpected width is exactly how an index ends up
    with mixed, incomparable spaces — it must fail loudly instead."""
    _calls, set_response = capture_http
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="k", AI_EMBEDDING_DIM=768)
    set_response({"embeddings": [{"values": [0.1, 0.2, 0.3]}]})  # only 3 dims

    provider = registry.get_embedding_provider()
    with pytest.raises(AIRequestError) as exc:
        await provider.embed(["x"])
    assert "768" in str(exc.value) and "AI_EMBEDDING_DIM" in str(exc.value)


async def test_embedding_count_mismatch_is_refused(ai_env, capture_http):
    _calls, set_response = capture_http
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="k", AI_EMBEDDING_DIM=3)
    set_response({"embeddings": [{"values": [0.1, 0.2, 0.3]}]})  # 1 for 2 inputs

    provider = registry.get_embedding_provider()
    with pytest.raises(AIRequestError) as exc:
        await provider.embed(["a", "b"])
    assert "1 embeddings for 2 inputs" in str(exc.value)


async def test_empty_embed_batch_short_circuits(ai_env, capture_http):
    calls, set_response = capture_http
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="k")
    set_response({})
    provider = registry.get_embedding_provider()
    out = await provider.embed([])
    assert out.vectors == []
    assert calls == []  # no pointless network call


async def test_openai_generation_contract(ai_env, capture_http):
    calls, set_response = capture_http
    ai_env(AI_PROVIDER="openai", OPENAI_API_KEY="k")
    set_response(
        {
            "choices": [{"message": {"content": "Hi"}, "finish_reason": "length"}],
            "usage": {"prompt_tokens": 4, "completion_tokens": 1},
        }
    )
    provider = registry.get_llm_provider()
    result = await provider.generate(
        [base.ChatMessage(role="user", content="hi")], system="sys"
    )
    assert result.text == "Hi"
    assert result.truncated is True  # finish_reason == length
    assert calls[-1]["headers"]["Authorization"] == "Bearer k"
    # OpenAI takes the system prompt as the first message.
    assert calls[-1]["payload"]["messages"][0] == {"role": "system", "content": "sys"}


async def test_anthropic_generation_contract(ai_env, capture_http):
    calls, set_response = capture_http
    ai_env(AI_PROVIDER="anthropic", ANTHROPIC_API_KEY="k")
    set_response(
        {
            "content": [{"type": "text", "text": "Sure"}],
            "usage": {"input_tokens": 5, "output_tokens": 2},
            "stop_reason": "end_turn",
        }
    )
    provider = registry.get_llm_provider()
    result = await provider.generate(
        [base.ChatMessage(role="user", content="hi")], system="sys"
    )
    assert result.text == "Sure"
    assert result.truncated is False
    assert calls[-1]["headers"]["x-api-key"] == "k"
    assert calls[-1]["headers"]["anthropic-version"]
    # Anthropic takes system as a TOP-LEVEL parameter, not a message.
    assert calls[-1]["payload"]["system"] == "sys"
    assert all(m["role"] != "system" for m in calls[-1]["payload"]["messages"])


@pytest.mark.parametrize(
    "error",
    [
        AIRateLimitError("quota", retry_after_seconds=12),
        AITransientError("502"),
        AIRequestError("bad model"),
    ],
)
async def test_provider_errors_propagate_as_typed_ai_errors(ai_env, capture_http, error):
    """Callers react to the CLASS of failure without knowing the vendor."""
    _calls, set_response = capture_http
    ai_env(AI_PROVIDER="gemini", GEMINI_API_KEY="k")
    set_response(raise_=error)

    provider = registry.get_llm_provider()
    with pytest.raises(type(error)):
        await provider.generate([base.ChatMessage(role="user", content="hi")])


def test_rate_limit_error_carries_retry_hint():
    err = AIRateLimitError("slow down", retry_after_seconds=30)
    assert err.retryable is True
    assert err.retry_after_seconds == 30
    assert AIRequestError("nope").retryable is False
