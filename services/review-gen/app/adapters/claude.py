"""Claude (Anthropic) base adapter.

Native Anthropic SDK — cheaper and more reliable than going through
OpenRouter. Uses adaptive thinking (thinking depth auto-tuned per
request, per Anthropic's recommendation for Opus 4.6+).

This is the provider-level base class; the per-system subclasses
(claudeopus5.py, claudesonnet5.py) only pin a model string and an
adapter_key.

Requires ANTHROPIC_API_KEY in the environment. Falls back loudly if
missing — we don't want to silently degrade on a billable model.

Methodology references:
  - claude-opus-5 / claude-sonnet-5 are the seeded tiers; both verified
    callable against GET /v1/models on 2026-07-26.
  - Adaptive thinking on Opus 4.6+ replaces the deprecated `budget_tokens`
    knob; effort=high is the default for intelligence-sensitive work.
  - We omit `thinking` entirely on models that don't support it (e.g. a
    user pointing this adapter at Sonnet 4.5 via config override).
"""
from __future__ import annotations

import os
from typing import Iterator

from app.adapters._budget import (
    count_tokens,
    render_canonical,
)
from app.conference_scales import DEFAULT_CONFERENCE, build_system_prompt
from app.adapters._review_parse import ScoreScale, parse_markdown_review
from app.adapters.base import (
    PROVIDER_TIMEOUT_S,
    Adapter,
    GenerationMetrics,
    GenerationResult,
    PROVIDER_MAX_RETRIES,
    StreamEvent,
    friendly_error,
)
from app.schemas import ParsedPaper

# The review-form system prompt is built per selected conference in
# __init__ — see app/conference_scales.py (single source for the form
# shared by all commercial adapters; only ## Rating varies by venue).


class ClaudeAdapter(Adapter):
    adapter_key = "claude"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        self._system_prompt = build_system_prompt(
            self.config.get('conference', DEFAULT_CONFERENCE),
        )
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise RuntimeError(
                "ClaudeAdapter requires ANTHROPIC_API_KEY. "
                "Set it in .env or disable the Claude systems."
            )
        # Lazy import so the rest of the service starts without the
        # anthropic SDK installed.
        from anthropic import Anthropic

        self._client = Anthropic(
            api_key=api_key,
            max_retries=PROVIDER_MAX_RETRIES,
            timeout=PROVIDER_TIMEOUT_S,
        )
        self._model = self.config.get("model", "claude-opus-5")
        # Opus 4.6+ supports adaptive thinking; pre-4.6 models don't.
        # Allow the seed to opt out via thinking=False if pointing at an
        # older model.
        self._thinking_enabled = bool(self.config.get("thinking", True))
        self._context_window = int(self.config.get("context_window", 200_000))

    def _kwargs(self, prompt: str, *, stream: bool) -> dict:
        # Anthropic's messages API: system is a top-level string, user
        # content is a single message. max_tokens is REQUIRED by the API,
        # so we send the provider's output ceiling — this is an API
        # constraint, not a fairness cap (caps removed by design).
        kwargs: dict = {
            "model": self._model,
            "max_tokens": 32_000,
            "system": self._system_prompt,
            "messages": [{"role": "user", "content": prompt}],
        }
        if self._thinking_enabled:
            # Adaptive thinking: model auto-tunes reasoning depth.
            # Effort=high pairs well with peer review (multi-criterion
            # judgment) without burning tokens unnecessarily.
            kwargs["thinking"] = {"type": "adaptive"}
            kwargs["output_config"] = {"effort": "high"}
        return kwargs

    def _metrics(self, prompt: str, raw: str) -> GenerationMetrics:
        return GenerationMetrics(
            input_tokens=count_tokens(prompt),
            output_tokens=count_tokens(raw),
            context_window=self._context_window,
            fair_input_tokens=count_tokens(prompt),
            fair_output_tokens=0,  # 0 = uncapped (32k = API-required ceiling)
        )

    def generate(self, paper: ParsedPaper) -> GenerationResult:
        prompt = self._render_prompt(paper)
        if not prompt.strip():
            raise ValueError(
                "Empty paper content — refusing to call the model. "
                "The PDF probably contains no extractable text."
            )
        # Streamed even though the caller wants one blob. The Anthropic SDK
        # REFUSES a non-streaming request whose max_tokens implies a
        # possible >10-minute run ("Streaming is required for operations
        # that may take longer than 10 minutes"), which our 32k ceiling
        # plus adaptive thinking always does — messages.create(stream=False)
        # raises ValueError before sending anything. Collecting the stream
        # here keeps /generate working for admin re-score and the
        # playground, and guarantees it produces byte-identical output to
        # the SSE path the participants see.
        chunks: list[str] = []
        with self._client.messages.stream(**self._kwargs(prompt, stream=True)) as stream:
            for delta in stream.text_stream:
                if delta:
                    chunks.append(delta)
        # text_stream yields only text blocks; thinking blocks are the
        # model's internal reasoning and never reach the user-facing output.
        raw = "".join(chunks).strip()
        # Unified ICLR markdown — same parser path as the other adapters.
        review = parse_markdown_review(raw, scale=ScoreScale.ICLR)
        return GenerationResult(review=review, raw_output=raw, metrics=self._metrics(prompt, raw))

    def generate_stream(self, paper: ParsedPaper) -> Iterator[StreamEvent]:
        """Anthropic streaming via the SDK helper. Emits per-token deltas
        as the model writes them; the browser renders markdown live."""
        try:
            prompt = self._render_prompt(paper)
            if not prompt.strip():
                yield StreamEvent(type="error", error="Empty paper text")
                return
            chunks: list[str] = []
            with self._client.messages.stream(**self._kwargs(prompt, stream=True)) as stream:
                for delta in stream.text_stream:
                    if delta:
                        chunks.append(delta)
                        yield StreamEvent(type="token", text=delta)
            raw = "".join(chunks).strip()
            review = parse_markdown_review(raw, scale=ScoreScale.ICLR)
            yield StreamEvent(
                type="done", result=review, raw_output=raw, metrics=self._metrics(prompt, raw)
            )
        except Exception as e:  # noqa: BLE001
            yield StreamEvent(type="error", error=friendly_error(e))

    def _render_prompt(self, paper: ParsedPaper) -> str:
        # FAIRNESS A1: identical canonical input across every system.
        return paper.canonicalText or render_canonical(paper)
