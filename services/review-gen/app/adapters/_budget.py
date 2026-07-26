"""Canonical paper text + token accounting.

DESIGN DECISION (2026-07-11): the fairness input/output caps were
REMOVED. Every commercial system now receives the COMPLETE canonical
paper text and no output-token cap (except provider-mandated ceilings,
e.g. Anthropic requires an explicit max_tokens). The thesis runs
commercial models only (GPT-5, Claude, Gemini, DeepSeek), all with
>=128k-token context windows, so full papers fit natively.

What remains shared:
  - The canonical text itself: rendered ONCE per paper, byte-identical
    for every system (adapters never re-render).
  - ONE reference tokenizer (tiktoken cl100k_base) for all token
    accounting, so recorded counts are comparable across systems.
"""
from __future__ import annotations

from math import ceil

from app.paper_render import render_paper_text
from app.schemas import ParsedPaper

# Conservative chars-per-token fallback when tiktoken is unavailable.
_CHARS_PER_TOKEN = 3.6

# Lazily-loaded reference tokenizer. One encoding for ALL systems so the
# token unit is consistent (fairness requires a common ruler, not each
# model's own tokenizer).
_ENCODER = None
_ENCODER_TRIED = False


def _encoder():
    global _ENCODER, _ENCODER_TRIED
    if _ENCODER_TRIED:
        return _ENCODER
    _ENCODER_TRIED = True
    try:
        import tiktoken

        _ENCODER = tiktoken.get_encoding("cl100k_base")
    except Exception:  # noqa: BLE001 — fall back to the char heuristic
        _ENCODER = None
    return _ENCODER


def count_tokens(text: str) -> int:
    """Reference token count. tiktoken cl100k_base when available, else a
    conservative char estimate. The SAME function is used for every system,
    so counts are comparable even if absolute values are approximate."""
    if not text:
        return 0
    enc = _encoder()
    if enc is not None:
        return len(enc.encode(text))
    return ceil(len(text) / _CHARS_PER_TOKEN)


def render_canonical(paper: ParsedPaper) -> str:
    """Render the ONE canonical paper string handed to every system.

    Deterministic from the parsed structure: same paper → same string.
    The FULL paper is rendered — no truncation at all. The cap argument
    and the token-trimming helper that used to live here were dropped
    with the open-weight specialists; every remaining system has a
    >=128k-token window and takes the whole paper.
    """
    return render_paper_text(paper, max_chars=100_000_000)
