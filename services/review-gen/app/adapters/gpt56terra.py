"""GPT-5.6 Terra reviewer (OpenAI, balanced tier of the 5.6 family).

Thin subclass of GPTAdapter. "gpt-5.6-terra" is the documented API id
(OpenAI ships 5.6 as three named tiers; Terra is the everyday-work
default, positioned as the GPT-5.5 drop-in at roughly half the cost).
Reasoning-family model: rejects a non-default temperature, so we omit it
and use max_completion_tokens like the rest of the 5.x line.
"""
from __future__ import annotations

from app.adapters.gpt import GPTAdapter


class GPT56TerraAdapter(GPTAdapter):
    adapter_key = "gpt-5.6-terra"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gpt-5.6-terra", "use_max_completion_tokens": True, **(config or {})}
        super().__init__(cfg)
