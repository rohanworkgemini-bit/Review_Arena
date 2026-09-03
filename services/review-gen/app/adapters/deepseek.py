"""DeepSeek base adapter.

Native DeepSeek API access via DeepSeek's OpenAI-compatible endpoint.
We use the openai SDK pointed at https://api.deepseek.com/v1 — the
DeepSeek docs explicitly recommend this and their schema matches.

This is the provider-level base class; the per-system subclasses
(deepseekv4pro.py, deepseekv4flash.py) only pin a model string and an
adapter_key.

A dedicated adapter (vs one config-driven generic adapter shared by
every provider) gives the thesis a clean 1:1 mapping between
review_systems rows and adapter source, and leaves room for
DeepSeek-specific behaviour without touching anyone else:
  - cache-hit pricing (DeepSeek bills cached prefix tokens at a steep
    discount; logging both separately matters for the cost chapter)
  - reasoning-mode support when we switch to deepseek-reasoner
  - any future API quirks specific to DeepSeek

Requires DEEPSEEK_API_KEY in the environment. Falls back loudly if
missing — no silent mock so a stale leaderboard doesn't accumulate
fake votes against missing data.
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

_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"

# The review-form system prompt is built per selected conference in
# __init__ — see app/conference_scales.py (single source for the form
# shared by all commercial adapters; only ## Rating varies by venue).


class DeepSeekAdapter(Adapter):
    adapter_key = "deepseek"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        self._system_prompt = build_system_prompt(
            self.config.get('conference', DEFAULT_CONFERENCE)
        )
        api_key = os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            raise RuntimeError(
                "DeepSeekAdapter requires DEEPSEEK_API_KEY. "
                "Get one at https://platform.deepseek.com/ and add it to .env."
            )
        # Lazy import so the rest of the service starts without the
        # openai SDK installed.
        from openai import OpenAI

        # DeepSeek exposes an OpenAI-compatible endpoint at api.deepseek.com/v1.
        # Same chat-completions schema, same auth shape — we just point the
        # client at their base URL instead of OpenAI's.
        self._client = OpenAI(
            api_key=api_key,
            base_url=_DEEPSEEK_BASE_URL,
            max_retries=PROVIDER_MAX_RETRIES,
            timeout=PROVIDER_TIMEOUT_S,
        )
        self._model = self.config.get("model", "deepseek-v4-pro")
        self._temperature = self.config.get("temperature", 0.2)
        # DeepSeek V4 has a 128k context window per their docs.
        self._context_window = int(self.config.get("context_window", 128_000))

    def _kwargs(self, prompt: str, *, stream: bool) -> dict:
        return {
            "model": self._model,
            "messages": [
                {"role": "system", "content": self._system_prompt},
                {"role": "user", "content": prompt},
            ],
            # DeepSeek defaults max_tokens to 4k when omitted — sending
            # the provider maximum so the model is effectively uncapped.
            "max_tokens": 8_192,
            "temperature": self._temperature,
            "stream": stream,
        }

    def _metrics(self, prompt: str, raw: str) -> GenerationMetrics:
        return GenerationMetrics(
            input_tokens=count_tokens(prompt),
            output_tokens=count_tokens(raw),
            context_window=self._context_window,
            fair_input_tokens=count_tokens(prompt),
            fair_output_tokens=0,  # 0 = uncapped (8192 = provider max)
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
