"""DeepSeek V4 Flash reviewer (DeepSeek fast tier).

Thin subclass of DeepSeekAdapter — see deepseekv4pro.py for rationale.
"""
from __future__ import annotations

from app.adapters.deepseek import DeepSeekAdapter


class DeepSeekV4FlashAdapter(DeepSeekAdapter):
    adapter_key = "deepseek-v4-flash"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "deepseek-v4-flash", "temperature": 0.2, **(config or {})}
        super().__init__(cfg)
