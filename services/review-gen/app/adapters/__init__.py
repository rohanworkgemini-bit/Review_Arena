"""Adapter registry. Lazy so we don't import heavy SDKs unless asked.

Live adapter keys (must match `review_systems.adapter_key` in the DB) —
the controlled study's six systems, one per provider:
  gemini-3.8-flash — Google Gemini 3.8 Flash (native SDK)
  gpt-5.6-terra    — OpenAI GPT-5.6 Terra
  claude-sonnet-5  — Anthropic Claude Sonnet 5 (native SDK)
  mistral-medium-3.5 — Mistral Medium 3.5 via its OpenAI-compatible endpoint
  glm-5.2          — Zhipu GLM-5.2 via Z.ai's OpenAI-compatible endpoint
  kimi-k3          — Moonshot Kimi K3 via its OpenAI-compatible endpoint

The 2026-09 lineup cut (10 systems → these 6) matches the study design's
six-system balanced rotation and frees DeepSeek to serve as the
LLM-as-judge (deepseek-v4-flash, see app/judge.py) with no vendor
overlap against any system under test. The previous lineup's adapters
and DB rows were REMOVED, not disabled — the study starts from a clean
database, so there is no history to preserve. Model ids for the four new
systems verified against provider docs 2026-09-03.

Standardized integration framework (so every system gets the same input
budgeting + output normalization, and adding a new one is minimal):
  - _budget.py        — canonical paper rendering + one reference tokenizer
  - _review_parse.py  — markdown/JSON → StructuredReview + score clamping

To add a provider, copy the closest adapter: glm.py or kimik3.py for
anything with an OpenAI-compatible /chat/completions endpoint (the
openai SDK pointed at a different base_url), claude.py or gemini.py for
a native SDK, then a thin per-system subclass pinning the model id
(gemini38flash.py) — or a single-file adapter when the provider
contributes only one system.
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
    # adapter, not at process startup.
    def _gemini38flash_factory(cfg: dict) -> Adapter:
        from app.adapters.gemini38flash import Gemini38FlashAdapter

        return Gemini38FlashAdapter(cfg)

    def _gpt56terra_factory(cfg: dict) -> Adapter:
        from app.adapters.gpt56terra import GPT56TerraAdapter

        return GPT56TerraAdapter(cfg)

    def _claude_sonnet5_factory(cfg: dict) -> Adapter:
        from app.adapters.claudesonnet5 import ClaudeSonnet5Adapter

        return ClaudeSonnet5Adapter(cfg)

    def _mistral_medium35_factory(cfg: dict) -> Adapter:
        from app.adapters.mistralmedium35 import MistralMedium35Adapter

        return MistralMedium35Adapter(cfg)

    def _glm_factory(cfg: dict) -> Adapter:
        from app.adapters.glm import GLMAdapter

        return GLMAdapter(cfg)

    def _kimik3_factory(cfg: dict) -> Adapter:
        from app.adapters.kimik3 import KimiK3Adapter

        return KimiK3Adapter(cfg)

    register("gemini-3.8-flash", _gemini38flash_factory)
    register("gpt-5.6-terra", _gpt56terra_factory)
    register("claude-sonnet-5", _claude_sonnet5_factory)
    register("mistral-medium-3.5", _mistral_medium35_factory)
    register("glm-5.2", _glm_factory)
    register("kimi-k3", _kimik3_factory)


_bootstrap()
