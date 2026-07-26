"""Gemini 3.6 Flash reviewer (Google fast tier).

Thin subclass of GeminiAdapter — see gemini31pro.py for rationale.
Flash is the cheap, low-latency tier; same prompt and parser as Pro.
"""
from __future__ import annotations

from app.adapters.gemini import GeminiAdapter


class Gemini36FlashAdapter(GeminiAdapter):
    adapter_key = "gemini-3.6-flash"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "gemini-3.6-flash", "temperature": 0.2, **(config or {})}
        super().__init__(cfg)
