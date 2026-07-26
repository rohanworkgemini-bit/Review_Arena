"""GPT-5.5 reviewer (OpenAI).

Thin subclass of GPTAdapter — per-system files give the thesis a clean
1:1 mapping between DB review_systems rows and Python source. Reasoning-
family model: rejects a non-default temperature, so we omit it.

DISABLED in the current lineup (enabled=false via RETIRED_SLUGS in
apps/api/scripts/seed.ts) — gpt-5.2 holds the OpenAI top slot at
$1.75/$14.00 per 1M against GPT-5.5's $5.00/$30.00. The adapter is kept
registered on purpose: the DB row and its reviews/Elo history survive,
so re-enabling is a one-line seed change and admin re-score / regenerate
on existing gpt-5.5 reviews still resolves an adapter.
"""
from __future__ import annotations

from app.adapters.gpt import GPTAdapter


class GPT55Adapter(GPTAdapter):
    adapter_key = "gpt-5.5"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gpt-5.5", "use_max_completion_tokens": True, **(config or {})}
        super().__init__(cfg)
