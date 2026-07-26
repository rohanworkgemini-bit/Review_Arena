"""Mistral Large 3 reviewer (Mistral top tier).

Thin subclass of MistralAdapter — per-system file so the thesis has a
clean 1:1 mapping between review_systems rows and adapter source.

NOTE: Mistral exposes no literal "mistral-large-3" id. The current Large
is "mistral-large-2512" (Dec 2025), which is what "mistral-large-latest"
resolves to — verified against GET /v1/models 2026-07-26. We pin the
dated id rather than the -latest alias so the whole study uses one model
snapshot; a silent upgrade mid-study would invalidate the comparison.
"""
from __future__ import annotations

from app.adapters.mistral import MistralAdapter


class MistralLarge3Adapter(MistralAdapter):
    adapter_key = "mistral-large-3"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "mistral-large-2512", "temperature": 0.2, **(config or {})}
        super().__init__(cfg)
