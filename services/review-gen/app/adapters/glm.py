"""GLM-5.2 reviewer (Zhipu / Z.ai).

Z.ai exposes an OpenAI-compatible chat-completions endpoint, so this is
the same shape as mistral.py: the openai SDK pointed at a different
base_url. GLM-5.2 (744B MoE, MIT-licensed, released 2026-06-13) is the
current flagship; the id "glm-5.2" is the documented model parameter.

Single-file adapter (base + model pin in one) — Z.ai contributes exactly
one system to the lineup, so a provider base class with one subclass
would be ceremony.

Requires ZAI_API_KEY in the environment. Raises loudly if missing — no
silent mock, so a stale leaderboard can't accumulate votes against
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

_ZAI_BASE_URL = "https://api.z.ai/api/paas/v4"


class GLMAdapter(Adapter):
    adapter_key = "glm-5.2"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        self._system_prompt = build_system_prompt(
            self.config.get('conference', DEFAULT_CONFERENCE),
        )
        api_key = os.environ.get("ZAI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GLMAdapter requires ZAI_API_KEY. "
                "Get one at https://z.ai/ and add it to .env."
            )
        # Lazy import so the rest of the service starts without the
        # openai SDK installed.
        from openai import OpenAI

        self._client = OpenAI(
            api_key=api_key,
            base_url=_ZAI_BASE_URL,
            max_retries=PROVIDER_MAX_RETRIES,
            timeout=PROVIDER_TIMEOUT_S,
        )
        self._model = self.config.get("model", "glm-5.2")
        self._temperature = self.config.get("temperature", 0.2)
        # Z.ai documents a 1M-token window for GLM-5.2; logged for
        # transparency, not used to size input.
        self._context_window = int(self.config.get("context_window", 1_000_000))

    def _kwargs(self, prompt: str, *, stream: bool) -> dict:
        kwargs: dict = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": self._system_prompt},
                {"role": "user", "content": prompt},
            ],
            # max_tokens omitted on purpose — uncapped output (fairness:
            # caps removed by design).
            "stream": stream,
        }
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
