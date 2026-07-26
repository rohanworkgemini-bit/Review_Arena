"""GPT-5.2 reviewer (OpenAI, previous-frontier tier).

Thin subclass of GPTAdapter — per-system files give the thesis a clean
1:1 mapping between DB review_systems rows and Python source.
Reasoning-family model: rejects a non-default temperature, so we omit it.

Chosen over gpt-5.5 for the top OpenAI slot at $1.75/$14.00 per 1M
versus $5.00/$30.00 — roughly a third of the cost per review. OpenAI
describes it as their "previous frontier model" and points new work at
newer releases; it is not marked deprecated and carries no announced
retirement date, but that is worth re-checking before a long collection
run, because switching the model mid-study would break the
apples-to-apples comparison the pinning elsewhere protects.
"""
from __future__ import annotations

from app.adapters.gpt import GPTAdapter


class GPT52Adapter(GPTAdapter):
    adapter_key = "gpt-5.2"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gpt-5.2", "use_max_completion_tokens": True, **(config or {})}
        super().__init__(cfg)
