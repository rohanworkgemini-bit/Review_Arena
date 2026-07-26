"""Gemini 3.1 Pro reviewer (Google top tier).

Thin subclass of GeminiAdapter — per-system file so the thesis has a
clean 1:1 mapping. Default temperature 0.2 matches our other Gemini
configuration (low but not zero, for stable but not deterministic
output across runs of the same paper).

NOTE: "gemini-3.1-pro-preview" is the only callable id for this tier —
Google ships no non-preview 3.1 Pro. Verified against the live
ListModels endpoint 2026-07-26. It is pinned so the whole study uses one
model snapshot.
"""
from __future__ import annotations

from app.adapters.gemini import GeminiAdapter


class Gemini31ProAdapter(GeminiAdapter):
    adapter_key = "gemini-3.1-pro"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gemini-3.1-pro-preview", "temperature": 0.2, **(config or {})}
        super().__init__(cfg)
