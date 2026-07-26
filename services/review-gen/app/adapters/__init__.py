"""Adapter registry. Lazy so we don't import heavy SDKs unless asked.

Live adapter keys (must match `review_systems.adapter_key` in the DB) —
ten systems across five providers, two tiers each:
  gpt-5.5-pro        — OpenAI GPT-5.5 Pro
  gpt-5.5            — OpenAI GPT-5.5
  claude-opus-5      — Anthropic Claude Opus 5 (native SDK)
  claude-sonnet-5    — Anthropic Claude Sonnet 5 (native SDK)
  gemini-3.1-pro     — Google Gemini 3.1 Pro
  gemini-3.6-flash   — Google Gemini 3.6 Flash
  deepseek-v4-pro    — DeepSeek V4 Pro via its OpenAI-compatible endpoint
  deepseek-v4-flash  — DeepSeek V4 Flash
  mistral-large-3    — Mistral Large 3 via its OpenAI-compatible endpoint
  mistral-medium-3.5 — Mistral Medium 3.5

Every model id above was verified callable against the provider's live
model-list endpoint on 2026-07-26; the exact ids live in each per-system
file (they differ from the display names in two cases — see
gemini31pro.py and mistrallarge3.py).

Scope: the thesis benchmarks **frontier commercial LLMs only**. The
open-weight specialist reviewers (DeepReviewer, OpenReviewer,
CycleReviewer, SEA) and their Modal/vLLM GPU serving code have been
removed — they required self-hosted GPUs, which is out of scope. Their
historical DB rows are disabled (not deleted) so past reviews, votes and
Elo snapshots remain intact for analysis; see apps/api/scripts/seed.ts.

Standardized integration framework (so every system gets the same input
budgeting + output normalization, and adding a new one is minimal):
  - _budget.py        — canonical paper rendering + one reference tokenizer
  - _review_parse.py  — markdown/JSON → StructuredReview + score clamping

To add a provider, copy the closest base adapter: deepseek.py or
mistral.py for anything with an OpenAI-compatible /chat/completions
endpoint (both are the openai SDK pointed at a different base_url),
claude.py or gemini.py for a native SDK. Then add a thin per-system
subclass that pins the model id, following gpt55pro.py.
"""
from __future__ import annotations

from typing import Callable

from app.adapters.base import Adapter

_FACTORIES: dict[str, Callable[[dict], Adapter]] = {}


def register(adapter_key: str, factory: Callable[[dict], Adapter]) -> None:
    _FACTORIES[adapter_key] = factory


def get(adapter_key: str, config: dict | None = None) -> Adapter:
    if adapter_key not in _FACTORIES:
        raise KeyError(f"unknown adapter_key: {adapter_key!r}")
    return _FACTORIES[adapter_key](config or {})


def known_keys() -> list[str]:
    return sorted(_FACTORIES.keys())


def _bootstrap() -> None:
    # Per-system adapter factories, wrapped lazily so the missing-API-key
    # error only surfaces when /generate is actually called for that
    # adapter, not at process startup. Each commercial reviewer system
    # has its own file so the thesis has a clean 1:1 mapping between DB
    # review_systems rows and Python source.
    def _gpt55pro_factory(cfg: dict) -> Adapter:
        from app.adapters.gpt55pro import GPT55ProAdapter

        return GPT55ProAdapter(cfg)

    def _gpt55_factory(cfg: dict) -> Adapter:
        from app.adapters.gpt55 import GPT55Adapter

        return GPT55Adapter(cfg)

    def _claude_opus5_factory(cfg: dict) -> Adapter:
        from app.adapters.claudeopus5 import ClaudeOpus5Adapter

        return ClaudeOpus5Adapter(cfg)

    def _claude_sonnet5_factory(cfg: dict) -> Adapter:
        from app.adapters.claudesonnet5 import ClaudeSonnet5Adapter

        return ClaudeSonnet5Adapter(cfg)

    def _gemini31pro_factory(cfg: dict) -> Adapter:
        from app.adapters.gemini31pro import Gemini31ProAdapter

        return Gemini31ProAdapter(cfg)

    def _gemini36flash_factory(cfg: dict) -> Adapter:
        from app.adapters.gemini36flash import Gemini36FlashAdapter

        return Gemini36FlashAdapter(cfg)

    def _deepseek_v4pro_factory(cfg: dict) -> Adapter:
        from app.adapters.deepseekv4pro import DeepSeekV4ProAdapter

        return DeepSeekV4ProAdapter(cfg)

    def _deepseek_v4flash_factory(cfg: dict) -> Adapter:
        from app.adapters.deepseekv4flash import DeepSeekV4FlashAdapter

        return DeepSeekV4FlashAdapter(cfg)

    def _mistral_large3_factory(cfg: dict) -> Adapter:
        from app.adapters.mistrallarge3 import MistralLarge3Adapter

        return MistralLarge3Adapter(cfg)

    def _mistral_medium35_factory(cfg: dict) -> Adapter:
        from app.adapters.mistralmedium35 import MistralMedium35Adapter

        return MistralMedium35Adapter(cfg)

    register("gpt-5.5-pro", _gpt55pro_factory)
    register("gpt-5.5", _gpt55_factory)
    register("claude-opus-5", _claude_opus5_factory)
    register("claude-sonnet-5", _claude_sonnet5_factory)
    register("gemini-3.1-pro", _gemini31pro_factory)
    register("gemini-3.6-flash", _gemini36flash_factory)
    register("deepseek-v4-pro", _deepseek_v4pro_factory)
    register("deepseek-v4-flash", _deepseek_v4flash_factory)
    register("mistral-large-3", _mistral_large3_factory)
    register("mistral-medium-3.5", _mistral_medium35_factory)


_bootstrap()
