"""Shared OUTPUT contract for markdown-emitting adapters.

The commercial reviewer adapters emit a markdown
review with `## Summary` / `## Strengths` / ... headings. This module is
the single place that turns that markdown into the canonical
`StructuredReview`, replacing the byte-for-byte-duplicated
`_markdown_to_structured` that lived in both adapters.

Two responsibilities:

1. **Parse** — split on headings, map heading aliases to canonical
   fields, bulletize list sections, pull the score out of each numeric
   section (first non-empty line only, so a stray "2024" in prose can't
   be mistaken for a rating).

2. **Normalize presentation** — strip inline markdown emphasis so both
   panels of a blind comparison are typographically identical (see
   strip_inline_emphasis below for why this is a fairness control, not a
   cosmetic one). Nothing else about the wording is altered.

3. **Normalize scores to a common scale** — different venues score
   differently. ICLR rates Soundness/Presentation/Contribution on 1-4;
   GPT/Gemini are prompted for 1-10. For a fair cross-system leaderboard
   we rescale everything to StructuredReview's ranges (dims + rating
   1-10, confidence 1-5) and CLAMP, so an out-of-range number from any
   model can never raise a Pydantic ValidationError and 502 the request.
"""
from __future__ import annotations

import re
from enum import Enum

from app.schemas import StructuredReview


class ScoreScale(str, Enum):
    """How a model's raw section scores map onto StructuredReview ranges."""

    #: dims + rating already 1-10 (GPT/Gemini-style prompting).
    TEN_POINT = "ten_point"
    #: ICLR-style: Soundness/Presentation/Contribution on 1-4, overall
    #: Rating on the 1-10 ICLR set, Confidence 1-5. We rescale the 1-4
    #: dims up to 1-10 so they're comparable with the 10-point systems.
    ICLR = "iclr"


# Canonical field <- heading alias map. Lowercased, punctuation-stripped.
#
# The three venue forms (prompts/review/*.md) use different section names
# for the same concepts; this map folds them all onto StructuredReview's
# canonical fields. NeurIPS's Quality/Clarity mirror ICLR's Soundness/
# Presentation; both venues' Significance plays Contribution's role.
# Deliberately UNMAPPED headings — "Strengths And Weaknesses" (its content
# lives in the ### Strengths/### Weaknesses subsections the prompt asks
# for), "Originality" (StructuredReview has one novelty slot and
# Significance fills it), "Flag For Ethics Review" — stay visible in
# rawOutput, which is what raters read; the structured fields feed the
# judge and analysis.
_HEADER_MAP = {
    "summary": "summary",
    "strength": "strengths",
    "strengths": "strengths",
    "weakness": "weaknesses",
    "weaknesses": "weaknesses",
    "limitation": "weaknesses",
    "limitations": "weaknesses",
    "question": "questions",
    "questions": "questions",
    "questions for authors": "questions",
    "key questions for authors": "questions",
    "questions and suggestions": "questions",
    "soundness": "soundness",
    "quality": "soundness",
    "presentation": "presentation",
    "clarity": "presentation",
    "contribution": "contribution",
    "significance": "contribution",
    "rating": "rating",
    "overall": "rating",
    "overall_rating": "rating",
    "overall recommendation": "rating",
    "score": "rating",
    "confidence": "confidence",
}

_HEADING_RX = re.compile(r"^#{1,4}\s*(.+?)\s*$", re.MULTILINE)
_NUMBER_RX = re.compile(r"(\d+(?:\.\d+)?)")

# Inline markdown emphasis, stripped from every user-facing field.
#
# FAIRNESS (presentation symmetry). Some models open each bullet with a
# bold lead-in ("**Robustness**: ..."), others write plain prose. The
# comparison UI renders bullets as text, so the markers used to reach the
# screen literally as "**" — one panel cluttered, the other clean. Either
# way that is a presentation artifact influencing a vote that is supposed
# to measure review CONTENT: rendering the bold would hand one system
# visual salience its opponent lacks, and the review form never asks for
# emphasis in the first place ("Concise bullet list").
#
# Normalising here rather than in the web layer keeps ONE definition of
# the text: score-paper.ts judges renderReviewText(structured), so the
# LLM judge and the human rater now read exactly the same string. The
# verbatim model output is untouched in reviews.rawOutput and remains
# available behind the panel's Raw toggle.
#
# Only the asterisk forms are handled. Underscore emphasis is left alone
# on purpose — reviews routinely mention snake_case identifiers, and
# `__init__` must not silently become `init`.
_BOLD_RX = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", re.S)
_ITALIC_RX = re.compile(r"(?<!\*)\*(?=\S)([^*]+?)(?<=\S)\*(?!\*)")


def strip_inline_emphasis(text: str) -> str:
    """Drop markdown bold/italic markers, keeping the words they wrap."""
    if not text:
        return text
    return _ITALIC_RX.sub(r"\1", _BOLD_RX.sub(r"\1", text))


def parse_markdown_review(md: str, *, scale: ScoreScale = ScoreScale.ICLR) -> StructuredReview:
    """Turn a markdown review into a normalized StructuredReview."""
    sections = _split_sections(md)

    def pick(key: str) -> str:
        return sections.get(key, "").strip()

    return StructuredReview(
        summary=strip_inline_emphasis(pick("summary")) or "(no summary)",
        strengths=_bulletize(pick("strengths")),
        weaknesses=_bulletize(pick("weaknesses")),
        questions=_bulletize(pick("questions")),
        soundness=normalize_dim(_first_number(pick("soundness")), scale),
        presentation=normalize_dim(_first_number(pick("presentation")), scale),
        contribution=normalize_dim(_first_number(pick("contribution")), scale),
        overallRating=_rating(pick("rating")),
        confidence=_confidence(pick("confidence")),
    )


# ─── section splitting ────────────────────────────────────────────────────


def _split_sections(md: str) -> dict[str, str]:
    out: dict[str, str] = {}
    headings = list(_HEADING_RX.finditer(md))
    for i, h in enumerate(headings):
        name = h.group(1).strip().lower().replace(":", "").replace("-", "_")
        name = re.sub(r"^\d+[.)]\s*", "", name).strip()
        canonical = _HEADER_MAP.get(name)
        if not canonical:
            continue
        body_start = h.end()
        body_end = headings[i + 1].start() if i + 1 < len(headings) else len(md)
        body = md[body_start:body_end].strip()
        # Two headings can fold onto one canonical field (Weaknesses +
        # Limitations both → weaknesses). Append rather than keep-longest
        # so neither section is lost; numeric fields are unaffected
        # because _first_number only reads the FIRST occurrence's first
        # line.
        if canonical in out and body:
            out[canonical] = f"{out[canonical]}\n{body}".strip()
        elif canonical not in out:
            out[canonical] = body
    return out


def _bulletize(text: str) -> list[str]:
    if not text:
        return []
    items: list[str] = []
    for raw in text.split("\n"):
        cleaned = raw.strip().lstrip("-*•").lstrip("0123456789. )").strip()
        cleaned = strip_inline_emphasis(cleaned)
        if cleaned:
            items.append(cleaned)
    return items


def _first_number(text: str) -> float | None:
    """First number on the first non-empty line. Scanning only the first
    line stops a stray year/count in prose ("the 2024 paper, rating 7")
    from being read as the score."""
    if not text:
        return None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        m = _NUMBER_RX.search(line)
        return float(m.group(1)) if m else None
    return None


# ─── score normalization ──────────────────────────────────────────────────


def _clamp(value: float | None, lo: float, hi: float) -> float | None:
    if value is None:
        return None
    return max(lo, min(hi, value))


def normalize_dim(value: float | None, scale: ScoreScale) -> float | None:
    """Soundness/Presentation/Contribution → 1-10.

    ICLR dims come on a 1-4 scale; rescale 1→1, 2→4, 3→7, 4→10 so they're
    comparable with the natively-10-point systems. Out-of-range inputs
    are clamped, never raised."""
    if value is None:
        return None
    if scale is ScoreScale.ICLR:
        # Map [1,4] → [1,10]. Values outside [1,4] are clamped first.
        value = max(1.0, min(4.0, value))
        value = 1.0 + (value - 1.0) * 3.0
    return _clamp(value, 1.0, 10.0)


def _rating(text: str) -> float | None:
    # Lower bound 0: the ICLR 2026 overall scale includes 0 (Strong
    # reject). Other venues' minima (1) are enforced by the prompt.
    return _clamp(_first_number(text), 0.0, 10.0)


def _confidence(text: str) -> float | None:
    return _clamp(_first_number(text), 1.0, 5.0)
