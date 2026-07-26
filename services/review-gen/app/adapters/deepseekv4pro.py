"""DeepSeek V4 Pro reviewer (DeepSeek top tier).

Thin subclass of DeepSeekAdapter — per-system file so the thesis has a
clean 1:1 mapping between review_systems rows and adapter source.
"""
from __future__ import annotations

from app.adapters.deepseek import DeepSeekAdapter


class DeepSeekV4ProAdapter(DeepSeekAdapter):
    adapter_key = "deepseek-v4-pro"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "deepseek-v4-pro", "temperature": 0.2, **(config or {})}
        super().__init__(cfg)
