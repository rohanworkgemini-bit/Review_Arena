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
  - Specialist (vLLM) adapters still trim input to fit their own
    context window — a hardware limit, not a fairness policy.

FAIR_INPUT_TOKENS / FAIR_OUTPUT_TOKENS survive only as legacy metric
labels; they no longer gate anything for commercial adapters.
"""
from __future__ import annotations

from math import ceil

from app.paper_render import render_paper_text
from app.schemas import ParsedPaper

# Legacy labels only — no longer enforced (see module docstring).
FAIR_INPUT_TOKENS = 30_000
FAIR_OUTPUT_TOKENS = 8_000

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


def _char_budget_for_tokens(max_tokens: int) -> int:
    return max(0, int(max_tokens * _CHARS_PER_TOKEN))


def render_canonical(paper: ParsedPaper, *, max_input_tokens: int = FAIR_INPUT_TOKENS) -> str:
    """Render the ONE canonical paper string handed to every system.

    Deterministic from the parsed structure: same paper → same string.
    The FULL paper is rendered — no fairness truncation (removed by
    design decision; commercial models all fit whole papers natively).
    """
    # No truncation: the complete paper, linearized deterministically.
    # (max_input_tokens is accepted for backwards compatibility but
    # ignored — trimming now happens only in specialist adapters that
    # must fit a hardware context window; see trim_to_tokens.)
    return render_paper_text(paper, max_chars=100_000_000)


# Reserve tokens for the truncation marker so the final string (marker
# included) still fits within the budget.
_TRUNCATION_MARKER = "\n\n[… truncated to fit this model's context window]"
_MARKER_TOKENS = 16


def trim_to_tokens(text: str, max_tokens: int) -> str:
    """Trim text to at most max_tokens reference tokens (marker included),
    on a paragraph boundary where possible so we never cut mid-word."""
    if count_tokens(text) <= max_tokens:
        return text
    body_budget = max(1, max_tokens - _MARKER_TOKENS)
    enc = _encoder()
    if enc is not None:
        toks = enc.encode(text)[:body_budget]
        out = enc.decode(toks)
    else:
        out = text[: _char_budget_for_tokens(body_budget)]
    # Back off to the last paragraph break so we end cleanly.
    cut = out.rfind("\n\n")
    if cut > len(out) * 0.6:
        out = out[:cut]
    return out.rstrip() + _TRUNCATION_MARKER
