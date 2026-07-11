"""GPT-4o-mini prompting baseline.

Requires OPENAI_API_KEY in the environment. Falls back to the mock adapter
(via a runtime exception caller can catch) if missing — we don't want to
silently degrade in production.
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
from app.adapters.base import Adapter, GenerationMetrics, GenerationResult, StreamEvent
from app.schemas import ParsedPaper

# The review-form system prompt is built per selected conference in
# __init__ — see app/conference_scales.py (single source for the form
# shared by all commercial adapters; only ## Rating varies by venue).


class GPTAdapter(Adapter):
    adapter_key = "gpt-4o-mini"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        self._system_prompt = build_system_prompt(
            self.config.get('conference', DEFAULT_CONFERENCE)
        )
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GPTAdapter requires OPENAI_API_KEY. "
                "Use the mock adapter for offline development."
            )
        # Lazy import so the rest of the service starts without the OpenAI
        # client installed.
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key)
        self._model = self.config.get("model", "gpt-4o-mini")
        # GPT-5 reasoning models reject any temperature != 1; keep it optional
        # so the seed config can omit it for those models.
        self._temperature = self.config.get("temperature")  # may be None
        self._context_window = int(self.config.get("context_window", 128_000))

    def _kwargs(self, prompt: str, *, stream: bool) -> dict:
        # Reasoning models (GPT-5, o1) reject `max_tokens` and require
        # `max_completion_tokens`. Switched via the `use_max_completion_tokens`
        # flag on the system's DB config. We send it via `extra_body` rather
        # than as a typed kwarg so it works on OpenAI SDKs pre-1.45 (which
        # don't have a `max_completion_tokens` parameter in their signature).
        # Either way, the cap is enforced — the fairness contract holds.
        use_mct = bool(self.config.get("use_max_completion_tokens"))
        kwargs: dict = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": self._system_prompt},
                {"role": "user", "content": prompt},
            ],
            "stream": stream,
        }
        # No output cap (design decision): we omit max_tokens /
        # max_completion_tokens entirely so the model may use its native
        # maximum. use_mct is retained in config for compatibility but no
        # longer sends anything.
        _ = use_mct
        if self._temperature is not None:
            kwargs["temperature"] = self._temperature
        return kwargs

    def _metrics(self, prompt: str, raw: str) -> GenerationMetrics:
        return GenerationMetrics(
            input_tokens=count_tokens(prompt),
            output_tokens=count_tokens(raw),
            context_window=self._context_window,
            fair_input_tokens=count_tokens(prompt),
            fair_output_tokens=0,  # 0 = uncapped
        )

    def generate(self, paper: ParsedPaper, *, pdf_bytes: bytes | None = None) -> GenerationResult:
        prompt = self._render_prompt(paper)
        if not prompt.strip():
            raise ValueError(
                "Empty paper content — refusing to call the model. "
                "The PDF probably contains no extractable text."
            )
        response = self._client.chat.completions.create(**self._kwargs(prompt, stream=False))
        raw = response.choices[0].message.content or ""
        # Unified ICLR markdown — same parser path as DeepReviewer/OpenReviewer.
        # ScoreScale.ICLR rescales the 1-4 dimension scores back to the 1-10
        # ranges that StructuredReview persists.
        review = parse_markdown_review(raw, scale=ScoreScale.ICLR)
        return GenerationResult(review=review, raw_output=raw, metrics=self._metrics(prompt, raw))

    def generate_stream(
        self,
        paper: ParsedPaper,
        *,
        pdf_bytes: bytes | None = None,
    ) -> Iterator[StreamEvent]:
        """OpenAI streaming. The token stream is the literal markdown the
        browser will render — same format as the specialist adapters, so
        the comparison UI doesn't need to branch on parser type."""
        try:
            prompt = self._render_prompt(paper)
            if not prompt.strip():
                yield StreamEvent(type="error", error="Empty paper text")
                return
            chunks: list[str] = []
            for event in self._client.chat.completions.create(**self._kwargs(prompt, stream=True)):
                if not event.choices:
                    continue
                delta = event.choices[0].delta.content or ""
                if delta:
                    chunks.append(delta)
                    yield StreamEvent(type="token", text=delta)
            raw = "".join(chunks).strip()
            review = parse_markdown_review(raw, scale=ScoreScale.ICLR)
            yield StreamEvent(
                type="done", result=review, raw_output=raw, metrics=self._metrics(prompt, raw)
            )
        except Exception as e:  # noqa: BLE001
            yield StreamEvent(type="error", error=str(e))

    def _render_prompt(self, paper: ParsedPaper) -> str:
        # FAIRNESS A1: identical canonical input across every system.
        return paper.canonicalText or render_canonical(paper)
