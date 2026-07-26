"""GPT-5.4-mini reviewer (OpenAI small tier).

Thin subclass of GPTAdapter — see gpt55.py for the rationale on
per-system files.

Replaced gpt-5.5-pro in the 2026-07 lineup. The pro tier was withdrawn
for three measured reasons: a 50k TPM cap (every other OpenAI model on
this account has 200k-500k, so a single 25k-token paper nearly consumed
the whole minute), a 100-150s time-to-first-token that arrived as ONE
buffered blob (a streaming-primacy confound against systems that write
live — docs/FAIRNESS.md B2), and $30/$180 per 1M, which made it ~74% of
the entire lineup's generation cost on its own.
"""
from __future__ import annotations

from app.adapters.gpt import GPTAdapter


class GPT54MiniAdapter(GPTAdapter):
    adapter_key = "gpt-5.4-mini"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gpt-5.4-mini", "use_max_completion_tokens": True, **(config or {})}
        super().__init__(cfg)
