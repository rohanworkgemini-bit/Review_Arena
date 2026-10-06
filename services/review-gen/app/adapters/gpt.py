"""OpenAI base adapter.

Provider-level base class; the per-system subclass (gpt56terra.py) only
pins a model string and an adapter_key. Uses /v1/chat/completions.

Requires OPENAI_API_KEY in the environment. Raises at generate() time
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
from app.prompts import DEFAULT_CONFERENCE, build_system_prompt
from app.adapters._review_parse import ScoreScale, parse_markdown_review
from app.adapters.base import (
    PROVIDER_TIMEOUT_S,
    Adapter,
    GenerationMetrics,
    GenerationResult,
    PROVIDER_MAX_RETRIES,
    StreamEvent,
    friendly_error,
    raise_if_truncated,
)
from app.schemas import ParsedPaper

# The review-form system prompt is built per selected conference in
# __init__ — see app/prompts/review/ (single source for the form
# shared by all commercial adapters; only ## Rating varies by venue).


class GPTAdapter(Adapter):
    adapter_key = "gpt-4o-mini"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        self._system_prompt = build_system_prompt(
            self.config.get('conference', DEFAULT_CONFERENCE),
        )
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GPTAdapter requires OPENAI_API_KEY. "
                "Set it in services/review-gen/.env for local development."
            )
        # Lazy import so the rest of the service starts without the OpenAI
        # client installed.
        from openai import OpenAI

        self._client = OpenAI(
            api_key=api_key,
            max_retries=PROVIDER_MAX_RETRIES,
            timeout=PROVIDER_TIMEOUT_S,
        )
        self._model = self.config.get("model", "gpt-4o-mini")
        # GPT-5 reasoning models reject any temperature != 1; keep it optional
        # so the seed config can omit it for those models.
        self._temperature = self.config.get("temperature")  # may be None
        self._context_window = int(self.config.get("context_window", 128_000))

    def _kwargs(self, prompt: str, *, stream: bool) -> dict:
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
        # maximum.
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

    def generate(self, paper: ParsedPaper) -> GenerationResult:
        prompt = self._render_prompt(paper)
        if not prompt.strip():
            raise ValueError(
                "Empty paper content — refusing to call the model. "
                "The PDF probably contains no extractable text."
            )
        response = self._client.chat.completions.create(**self._kwargs(prompt, stream=False))
        raise_if_truncated(response.choices[0].finish_reason)
        raw = response.choices[0].message.content or ""
        # Unified ICLR markdown — same parser path as every other adapter.
        # ScoreScale.ICLR rescales the 1-4 dimension scores back to the 1-10
        # ranges that StructuredReview persists.
        review = parse_markdown_review(raw, scale=ScoreScale.ICLR)
        return GenerationResult(review=review, raw_output=raw, metrics=self._metrics(prompt, raw))

    def generate_stream(self, paper: ParsedPaper) -> Iterator[StreamEvent]:
        """OpenAI streaming. The token stream is the literal markdown the
        browser will render — the same format every other adapter emits, so
        the comparison UI doesn't need to branch on parser type."""
        try:
            prompt = self._render_prompt(paper)
            if not prompt.strip():
                yield StreamEvent(type="error", error="Empty paper text")
                return
            chunks: list[str] = []
            finish_reason = None
            # `with` so an abandoned stream (generator close()) shuts the
            # HTTP response instead of leaving it to GC.
            with self._client.chat.completions.create(**self._kwargs(prompt, stream=True)) as stream:
                for event in stream:
                    if not event.choices:
                        continue
                    finish_reason = event.choices[0].finish_reason or finish_reason
                    delta = event.choices[0].delta.content or ""
                    if delta:
                        chunks.append(delta)
                        yield StreamEvent(type="token", text=delta)
            raise_if_truncated(finish_reason)
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
