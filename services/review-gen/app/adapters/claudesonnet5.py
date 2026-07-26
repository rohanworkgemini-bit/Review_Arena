"""Claude Sonnet 5 reviewer (Anthropic mid tier).

Thin subclass of ClaudeAdapter — see claudeopus5.py for rationale.
Sonnet is the faster, cheaper tier; same prompt and parser as Opus.
"""
from __future__ import annotations

from app.adapters.claude import ClaudeAdapter


class ClaudeSonnet5Adapter(ClaudeAdapter):
    adapter_key = "claude-sonnet-5"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "claude-sonnet-5", "thinking": True, **(config or {})}
        super().__init__(cfg)
