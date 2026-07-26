"""GPT-5.5 Pro reviewer (OpenAI top tier).

Thin subclass of GPTAdapter — same OpenAI SDK call shape, same prompt,
same response parser. Only the model string and adapter_key differ.
Per-system files give the thesis a clean 1:1 mapping between DB
review_systems rows and Python adapter source.

IMPORTANT: the "pro" tier is NOT a chat model. /v1/chat/completions
returns 404 "This is not a chat model"; it must go through
/v1/responses. That is what `use_responses_api` switches on in
GPTAdapter. Verified against the live API 2026-07-26.
"""
from __future__ import annotations

from app.adapters.gpt import GPTAdapter


class GPT55ProAdapter(GPTAdapter):
    adapter_key = "gpt-5.5-pro"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gpt-5.5-pro", "use_responses_api": True, **(config or {})}
        super().__init__(cfg)
