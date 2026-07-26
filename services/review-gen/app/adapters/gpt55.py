"""GPT-5.5 reviewer (OpenAI standard tier).

Thin subclass of GPTAdapter — per-system files give the thesis a clean
1:1 mapping between DB review_systems rows and Python source. Reasoning-
family model: rejects a non-default temperature, so we omit it.
"""
from __future__ import annotations

from app.adapters.gpt import GPTAdapter


class GPT55Adapter(GPTAdapter):
    adapter_key = "gpt-5.5"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gpt-5.5", "use_max_completion_tokens": True, **(config or {})}
        super().__init__(cfg)
