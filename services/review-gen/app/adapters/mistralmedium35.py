"""Mistral Medium 3.5 reviewer (Mistral mid tier).

Thin subclass of MistralAdapter — see mistrallarge3.py for rationale.
"mistral-medium-3.5" is a callable id in its own right (it aliases the
dated "mistral-medium-2604"), verified 2026-07-26.
"""
from __future__ import annotations

from app.adapters.mistral import MistralAdapter


class MistralMedium35Adapter(MistralAdapter):
    adapter_key = "mistral-medium-3.5"

    def __init__(self, config: dict | None = None) -> None:
        cfg = {"model": "mistral-medium-2604", "temperature": 0.2, **(config or {})}
        super().__init__(cfg)
