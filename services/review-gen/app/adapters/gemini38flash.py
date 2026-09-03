"""Gemini 3.8 Flash reviewer (Google, current-generation fast tier).

Thin subclass of GeminiAdapter — per-system files give the thesis a
clean 1:1 mapping between DB review_systems rows and Python source.
"gemini-3.8-flash" is the documented model parameter for Google's
newest model (per ai.google.dev/gemini-api/docs/latest-model).
"""
from __future__ import annotations

from app.adapters.gemini import GeminiAdapter


class Gemini38FlashAdapter(GeminiAdapter):
    adapter_key = "gemini-3.8-flash"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gemini-3.8-flash", "temperature": 0.2, **(config or {})}
        super().__init__(cfg)
