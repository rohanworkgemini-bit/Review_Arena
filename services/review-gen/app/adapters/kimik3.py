"""Kimi K3 reviewer (Moonshot AI).

Moonshot exposes an OpenAI-compatible chat-completions endpoint, so this
is the same shape as mistral.py / glm.py: the openai SDK pointed at a
different base_url. Kimi K3 (2.8T-parameter open-weight reasoning model,
1M context) is the flagship; the id "kimi-k3" is the documented model
parameter.

Reasoning-family model: like OpenAI's 5.x reasoning tiers it manages its
own sampling, so temperature defaults to None (omitted) rather than 0.2.
Reasoning depth is the provider default; pin it explicitly via
config {"reasoning_effort": "..."} if the study needs it fixed.

Single-file adapter — Moonshot contributes exactly one system.

Requires MOONSHOT_API_KEY in the environment. Raises loudly if missing.
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

_MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1"


class KimiK3Adapter(Adapter):
    adapter_key = "kimi-k3"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        self._system_prompt = build_system_prompt(
            self.config.get('conference', DEFAULT_CONFERENCE)
        )
        api_key = os.environ.get("MOONSHOT_API_KEY")
        if not api_key:
            raise RuntimeError(
                "KimiK3Adapter requires MOONSHOT_API_KEY. "
                "Get one at https://platform.kimi.ai/ and add it to .env."
            )
        # Lazy import so the rest of the service starts without the
        # openai SDK installed.
        from openai import OpenAI

        self._client = OpenAI(
            api_key=api_key,
            base_url=_MOONSHOT_BASE_URL,
            max_retries=PROVIDER_MAX_RETRIES,
            timeout=PROVIDER_TIMEOUT_S,
        )
        self._model = self.config.get("model", "kimi-k3")
        # None = omit temperature (reasoning models reject or ignore it).
        self._temperature = self.config.get("temperature")
        self._reasoning_effort = self.config.get("reasoning_effort")
        # Moonshot documents a 1M-token window for K3; logged for
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
        if self._reasoning_effort is not None:
            # Moonshot's top-level reasoning-depth knob ("low"/"high"/"max").
            kwargs["extra_body"] = {"reasoning_effort": self._reasoning_effort}
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
