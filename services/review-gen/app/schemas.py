"""Pydantic schemas. Mirror packages/shared-types/src so the wire format is
identical to what the Node API sends and expects back."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


# ─── ParsedPaper (input from Node) ─────────────────────────────────────────


class ParsedSection(BaseModel):
    heading: str
    level: int = Field(ge=1, le=6)
    text: str


class ParsedFigure(BaseModel):
    label: str
    caption: str
    page: int | None = None


class ParsedTable(BaseModel):
    label: str
    caption: str
    page: int | None = None
    # 2D cell grid. The current parsers (Chandra, arxiv2md) emit
    # tables inline in section markdown and leave this empty; kept for
    # forward-compat with structured-row parsers.
    rows: list[list[str]] = Field(default_factory=list)


class ParsedReference(BaseModel):
    raw: str
    title: str | None = None
    authors: list[str] | None = None
    year: int | None = None


class ParsedPaper(BaseModel):
    title: str | None
    abstract: str | None
    authors: list[str]
    sections: list[ParsedSection]
    figures: list[ParsedFigure]
    tables: list[ParsedTable]
    references: list[ParsedReference]
    pageCount: int | None
    source: Literal["arxiv2md", "chandra"]
    # ─── Fairness: canonical input (docs/FAIRNESS.md A1) ───────────────────
    # The ONE canonical paper string handed BYTE-IDENTICALLY to every
    # system, rendered once at parse time to the fair input budget. When
    # present, adapters use it verbatim (never re-render), guaranteeing
    # identical input. canonicalTokens = its reference-token count;
    # fullTokens = the untruncated paper's token count (for
    # fraction-of-paper-used accounting).
    canonicalText: str | None = None
    canonicalTokens: int | None = None
    fullTokens: int | None = None


# ─── StructuredReview (output to Node) ─────────────────────────────────────


class StructuredReview(BaseModel):
    summary: str
    strengths: list[str]
    weaknesses: list[str]
    questions: list[str]
    soundness: float | None = Field(default=None, ge=1, le=10)
    presentation: float | None = Field(default=None, ge=1, le=10)
    contribution: float | None = Field(default=None, ge=1, le=10)
    # ge=0: the ICLR 2026 overall scale includes 0 (Strong reject).
    overallRating: float | None = Field(default=None, ge=0, le=10)
    confidence: float | None = Field(default=None, ge=1, le=5)


# ─── HTTP envelopes ────────────────────────────────────────────────────────


class GenerateRequest(BaseModel):
    adapter_key: str
    paper: ParsedPaper
    config: dict = Field(default_factory=dict)
    # Venue whose review form / rating scale the review should follow
    # (see conference_scales.py). Chosen by the uploader; identical for
    # both systems in a battle.
    conference: str = "iclr"
    # Original PDF bytes, base64-encoded. Forwarded only for adapters
    # that need raw PDF input (MARG). Optional — None for everything else.
    pdf_b64: str | None = None


class GenerationMetricsOut(BaseModel):
    """Fairness token accounting returned with every generation (A4)."""

    input_tokens: int = 0
    output_tokens: int = 0
    context_window: int = 0
    fair_input_tokens: int = 0
    fair_output_tokens: int = 0


class GenerateResponse(BaseModel):
    review: StructuredReview
    raw_output: str
    generation_ms: int
    adapter_key: str
    metrics: GenerationMetricsOut | None = None
