"""GPT-5.5 reviewer (OpenAI standard tier).

Thin subclass of GPTAdapter — see gpt55pro.py for the rationale on
per-system files. Same reasoning-family quirks as the Pro tier (no
temperature, `max_completion_tokens` required).
"""
from __future__ import annotations

from app.adapters.gpt import GPTAdapter


class GPT55Adapter(GPTAdapter):
    adapter_key = "gpt-5.5"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gpt-5.5", "use_max_completion_tokens": True, **(config or {})}
        super().__init__(cfg)
