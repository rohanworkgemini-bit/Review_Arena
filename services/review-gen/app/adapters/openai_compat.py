"""Generic OpenAI-compatible API reviewer.

One adapter for ANY provider that speaks the OpenAI chat-completions API:
OpenAI (gpt-4o, o1, …), DeepSeek, Groq, xAI/Grok, Mistral, Together, and
OpenRouter (which itself proxies Claude, Gemini, Llama, Qwen, …). A new
API-based "review system" is then just a seed row — no new code.

The system declares, via its DB `config`:
    {
      "model":        "gpt-4o",                       # required
      "base_url":     "https://api.openai.com/v1",    # optional, default OpenAI
      "api_key_env":  "OPENAI_API_KEY",               # which env var holds the key
      "temperature":  0.4,                            # optional
      "context_window": 16000, "max_output_tokens": 2048  # optional budget
    }

Output contract is the same ICLR-style markdown every dedicated adapter
emits. parse_markdown_review handles every system identically, so the
comparison UI never branches on adapter type.
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

# Shared zero-shot review prompt — identical ICLR markdown contract to
# gpt.py / gemini.py / the per-system adapters. Every system normalizes
# through parse_markdown_review(scale=ICLR).
# The review-form system prompt is built per selected conference in
# __init__ — see app/conference_scales.py (single source for the form
# shared by all commercial adapters; only ## Rating varies by venue).


class OpenAICompatAdapter(Adapter):
    """Talks to any OpenAI-compatible /chat/completions endpoint."""

    adapter_key = "openai-compat"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        self._system_prompt = build_system_prompt(
            self.config.get('conference', DEFAULT_CONFERENCE)
        )
        self._model = self.config.get("model")
        if not self._model:
            raise RuntimeError("openai-compat adapter requires `model` in config.")

        base_url = self.config.get("base_url") or "https://api.openai.com/v1"
        api_key_env = self.config.get("api_key_env", "OPENAI_API_KEY")
        api_key = os.environ.get(api_key_env)
        if not api_key:
            raise RuntimeError(
                f"openai-compat adapter for {self._model} requires {api_key_env} "
                f"in the environment."
            )

        from openai import OpenAI

        self._client = OpenAI(api_key=api_key, base_url=base_url)

        # Some models (OpenAI o1/GPT-5 reasoning) reject temperature != 1;
        # omit it by setting temperature: null in the config.
        self._temperature = self.config.get("temperature", 0.4)
        self._context_window = int(self.config.get("context_window", 16_000))
        self._max_output_tokens = int(self.config.get("max_output_tokens", 2048))

    def _kwargs(self, prompt: str, *, stream: bool) -> dict:
        kw: dict = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": self._system_prompt},
                {"role": "user", "content": prompt},
            ],
            # Equalized output cap (FAIRNESS A1/A4).
            # Optional per-system override; omitted by default so the
            # backend's model maximum applies (caps removed by design).
            **({"max_tokens": int(self.config["max_tokens"])} if self.config.get("max_tokens") else {}),
            "stream": stream,
        }
        if self._temperature is not None:
            kw["temperature"] = self._temperature
        if self.config.get("no_max_tokens"):
            kw.pop("max_tokens", None)
        return kw

    def _render_prompt(self, paper: ParsedPaper) -> str:
        # FAIRNESS A1: identical canonical input across every system.
        return paper.canonicalText or render_canonical(paper)

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
            raise ValueError("Empty paper content — refusing to call the model.")
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
            yield StreamEvent(type="error", error=str(e))
