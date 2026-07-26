"""GPT-5.5 Pro reviewer (OpenAI pro tier).

DISABLED in the current lineup (enabled=false via RETIRED_SLUGS in
apps/api/scripts/seed.ts). Kept registered on purpose: the DB row and any
reviews/Elo history it produced stay usable, admin re-score / regenerate
still resolves an adapter for them, and re-enabling is a one-line seed
change.

IMPORTANT: the pro tier is NOT a chat model. /v1/chat/completions answers
404 "This is not a chat model and thus not supported in the
v1/chat/completions endpoint", so it must go through /v1/responses —
that is what `use_responses_api` switches on in GPTAdapter, and this is
the only system that sets it. Verified 2026-07-26.

Why it was withdrawn from the live lineup, all measured:
  - 50k TPM / 50 RPM on this account, against 200k-500k for every other
    OpenAI model. A single 25k-token paper plus reasoning output nearly
    consumes the whole minute, so pairing it with any second OpenAI
    system 429s by construction.
  - 100-150s time-to-first-token, delivered as ONE buffered delta
    (measured 61s and 149s on the same paper, so unpredictable). Beside
    a system that streams live that is a primacy confound — FAIRNESS B2.
  - $30/$180 per 1M made it ~74% of the entire lineup's generation cost.
"""
from __future__ import annotations

from app.adapters.gpt import GPTAdapter


class GPT55ProAdapter(GPTAdapter):
    adapter_key = "gpt-5.5-pro"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gpt-5.5-pro", "use_responses_api": True, **(config or {})}
        super().__init__(cfg)
