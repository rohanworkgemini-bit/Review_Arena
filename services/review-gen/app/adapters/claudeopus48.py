"""Claude Opus 4.8 reviewer (Anthropic top tier).

Thin subclass of ClaudeAdapter — per-system file so the thesis has a
clean 1:1 mapping between review_systems rows and adapter source.
Adaptive thinking stays on (effort=high): peer review is exactly the
multi-criterion judgment task it helps with.

NOTE ON COST: Opus 4.8 and Opus 5 are priced identically ($5/MTok input,
$25/MTok output) and both sit on Anthropic's post-4.7 tokenizer, which
emits ~30% more tokens for the same text than the 4.6-and-earlier one.
Choosing 4.8 over 5 therefore changes the model, not the bill — see
docs/FAIRNESS.md if a cheaper Anthropic slot is ever needed (Opus 4.6
would drop to the older tokenizer at the same per-token price).
"""
from __future__ import annotations

from app.adapters.claude import ClaudeAdapter


class ClaudeOpus48Adapter(ClaudeAdapter):
    adapter_key = "claude-opus-4-8"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "claude-opus-4-8", "thinking": True, **(config or {})}
        super().__init__(cfg)
