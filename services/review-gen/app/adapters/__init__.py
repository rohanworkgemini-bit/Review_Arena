"""Adapter registry. Lazy so we don't import heavy SDKs unless asked.

Live adapter keys (must match `review_systems.adapter_key` in the DB):
  gpt-5             — OpenAI GPT-5 zero-shot prompted reviewer
  gpt-5-mini        — OpenAI GPT-5-mini zero-shot prompted reviewer
  gemini-3-pro      — Google Gemini 3 Pro zero-shot prompted reviewer
  gemini-2.5-flash  — Google Gemini 2.5 Flash zero-shot prompted reviewer
  claude            — Anthropic Claude Opus 4.8 (native SDK)
  deepseek-v3-2     — DeepSeek V3.2 via its OpenAI-compatible endpoint

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
  - openai_compat.py  — generic OpenAI-compatible adapter for any new
                        provider exposing a /chat/completions endpoint.
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
    # Real adapters are wrapped in thin lazy factories so the missing-
    # API-key error only surfaces when /generate is actually called for
    # that adapter, not at process startup.
    def _gpt_factory(cfg: dict) -> Adapter:
        from app.adapters.gpt import GPTAdapter

        return GPTAdapter(cfg)

    def _gemini_factory(cfg: dict) -> Adapter:
        from app.adapters.gemini import GeminiAdapter

        return GeminiAdapter(cfg)

    def _openai_compat_factory(cfg: dict) -> Adapter:
        from app.adapters.openai_compat import OpenAICompatAdapter

        return OpenAICompatAdapter(cfg)

    def _claude_factory(cfg: dict) -> Adapter:
        from app.adapters.claude import ClaudeAdapter

        return ClaudeAdapter(cfg)

    # Per-system adapter factories. Each commercial reviewer system has
    # its own file (gpt5.py, gpt5mini.py, gemini3pro.py, gemini25flash.py,
    # claude.py, deepseek.py) so the thesis has a clean 1:1 mapping
    # between DB review_systems rows and Python source.
    def _gpt5_factory(cfg: dict) -> Adapter:
        from app.adapters.gpt5 import GPT5Adapter

        return GPT5Adapter(cfg)

    def _gpt5mini_factory(cfg: dict) -> Adapter:
        from app.adapters.gpt5mini import GPT5MiniAdapter

        return GPT5MiniAdapter(cfg)

    def _gemini3pro_factory(cfg: dict) -> Adapter:
        from app.adapters.gemini3pro import Gemini3ProAdapter

        return Gemini3ProAdapter(cfg)

    def _gemini25flash_factory(cfg: dict) -> Adapter:
        from app.adapters.gemini25flash import Gemini25FlashAdapter

        return Gemini25FlashAdapter(cfg)

    def _deepseek_factory(cfg: dict) -> Adapter:
        from app.adapters.deepseek import DeepSeekAdapter

        return DeepSeekAdapter(cfg)

    # Legacy keys — kept registered so historical DB rows still resolve.
    # The "gpt-4o-mini" + "gemini" keys are the base adapters that the
    # per-system subclasses inherit from; left registered for backward
    # compatibility with any unmigrated row.
    register("gpt-4o-mini", _gpt_factory)
    register("gemini", _gemini_factory)
    # Generic OpenAI-compatible adapter — still useful for ad-hoc base_url
    # overrides; not used by any active seeded system now that DeepSeek
    # has its own dedicated adapter.
    register("openai-compat", _openai_compat_factory)
    # Per-system commercial reviewers (one file per system).
    register("gpt-5", _gpt5_factory)
    register("gpt-5-mini", _gpt5mini_factory)
    register("gemini-3-pro", _gemini3pro_factory)
    register("gemini-2.5-flash", _gemini25flash_factory)
    register("claude", _claude_factory)  # claude-opus-4-8 (only Claude system)
    register("deepseek-v3-2", _deepseek_factory)


_bootstrap()
