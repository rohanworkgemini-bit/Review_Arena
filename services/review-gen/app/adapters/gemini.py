"""Gemini prompting baseline.

Requires GEMINI_API_KEY in the environment. Emits the same ICLR-style
markdown every other adapter produces, so all systems go through
parse_markdown_review and the comparison UI never branches on adapter.
"""
from __future__ import annotations

import os

from typing import Any, Iterator

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
    StreamEvent,
    friendly_error,
)
from app.schemas import ParsedPaper

# The review-form system prompt is built per selected conference in
# __init__ — see app/prompts/review/ (single source for the form
# shared by all commercial adapters; only ## Rating varies by venue).


class GeminiAdapter(Adapter):
    adapter_key = "gemini"

    def __init__(self, config: dict | None = None) -> None:
        super().__init__(config)
        self._system_prompt = build_system_prompt(
            self.config.get('conference', DEFAULT_CONFERENCE),
        )
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GeminiAdapter requires GEMINI_API_KEY. "
                "Set it in services/review-gen/.env for local development."
            )
        # Lazy import — only loaded when this adapter is actually used.
        import google.generativeai as genai

        genai.configure(api_key=api_key)
        self._model_name = self.config.get("model", "gemini-1.5-flash")
        self._model = genai.GenerativeModel(
            model_name=self._model_name,
            system_instruction=self._system_prompt,
        )
        # dict form is accepted at runtime across google-generativeai versions;
        # typed as Any so newer stub-shipping versions don't reject it.
        self._generation_config: Any = {
            "temperature": self.config.get("temperature", 0.4),
        }
        self._context_window = int(self.config.get("context_window", 1_000_000))

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
        response = self._model.generate_content(
            prompt,
            generation_config=self._generation_config,
            request_options={"timeout": PROVIDER_TIMEOUT_S},
        )
        raw = response.text or ""
        review = parse_markdown_review(raw, scale=ScoreScale.ICLR)
        return GenerationResult(review=review, raw_output=raw, metrics=self._metrics(prompt, raw))

    def generate_stream(self, paper: ParsedPaper) -> Iterator[StreamEvent]:
        """Gemini streaming via generate_content(stream=True). Emits ICLR
        markdown — same parse path as every other adapter."""
        try:
            prompt = self._render_prompt(paper)
            if not prompt.strip():
                yield StreamEvent(type="error", error="Empty paper text")
                return
            chunks: list[str] = []
            for chunk in self._model.generate_content(
                prompt,
                generation_config=self._generation_config,
                stream=True,
                request_options={"timeout": PROVIDER_TIMEOUT_S},
            ):
                delta = getattr(chunk, "text", "") or ""
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
