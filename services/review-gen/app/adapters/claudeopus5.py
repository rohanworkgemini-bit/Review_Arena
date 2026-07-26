"""Claude Opus 5 reviewer (Anthropic top tier).

Thin subclass of ClaudeAdapter — per-system file so the thesis has a
clean 1:1 mapping between review_systems rows and adapter source.
Adaptive thinking stays on (effort=high): peer review is exactly the
multi-criterion judgment task it helps with.
"""
from __future__ import annotations

from app.adapters.claude import ClaudeAdapter


class ClaudeOpus5Adapter(ClaudeAdapter):
    adapter_key = "claude-opus-5"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "claude-opus-5", "thinking": True, **(config or {})}
        super().__init__(cfg)
