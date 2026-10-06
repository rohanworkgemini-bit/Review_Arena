"""Mistral base adapter.

Native Mistral API access via Mistral's OpenAI-compatible endpoint. We
use the openai SDK pointed at https://api.mistral.ai/v1 — same
chat-completions schema, same auth shape, so no extra SDK dependency.

This is the provider-level base class; the per-system subclasses
(mistrallarge3.py, mistralmedium35.py) only pin a model string and an
adapter_key, matching the 1:1 review_systems ↔ source mapping the other
providers use.

Requires MISTRAL_API_KEY in the environment. Raises loudly if missing —
no silent mock, so a stale leaderboard can't accumulate votes against
missing data.
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
)
from app.schemas import ParsedPaper

_MISTRAL_BASE_URL = "https://api.mistral.ai/v1"

# The review-form system prompt is built per selected conference in
# __init__ — see app/prompts/review/ (single source for the form
# shared by all commercial adapters; only ## Rating varies by venue).


class MistralAdapter(Adapter):
    adapter_key = "mistral"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        self._system_prompt = build_system_prompt(
            self.config.get('conference', DEFAULT_CONFERENCE),
        )
        api_key = os.environ.get("MISTRAL_API_KEY")
        if not api_key:
            raise RuntimeError(
                "MistralAdapter requires MISTRAL_API_KEY. "
                "Get one at https://console.mistral.ai/ and add it to .env."
            )
        # Lazy import so the rest of the service starts without the
        # openai SDK installed.
        from openai import OpenAI

        self._client = OpenAI(
            api_key=api_key,
            base_url=_MISTRAL_BASE_URL,
            max_retries=PROVIDER_MAX_RETRIES,
            timeout=PROVIDER_TIMEOUT_S,
        )
        self._model = self.config.get("model", "mistral-large-2512")
        self._temperature = self.config.get("temperature", 0.2)
        # Both seeded Mistral models report a 262144-token window via
        # GET /v1/models; logged for transparency, not used to size input.
        self._context_window = int(self.config.get("context_window", 262_144))

    def _kwargs(self, prompt: str, *, stream: bool) -> dict:
        return {
            "model": self._model,
            "messages": [
                {"role": "system", "content": self._system_prompt},
                {"role": "user", "content": prompt},
            ],
            # Mistral defaults max_tokens to the model ceiling when
            # omitted; we leave it out so the response is uncapped
            # (fairness: caps removed by design).
            "temperature": self._temperature,
            "stream": stream,
        }

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
        raw = response.choices[0].message.content or ""
        review = parse_markdown_review(raw, scale=ScoreScale.ICLR)
        return GenerationResult(review=review, raw_output=raw, metrics=self._metrics(prompt, raw))

    def generate_stream(self, paper: ParsedPaper) -> Iterator[StreamEvent]:
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
            yield StreamEvent(type="error", error=friendly_error(e))

    def _render_prompt(self, paper: ParsedPaper) -> str:
        # FAIRNESS A1: identical canonical input across every system.
        return paper.canonicalText or render_canonical(paper)
