"""OpenAI base adapter.

Provider-level base class; the per-system subclasses (gpt52.py,
gpt54mini.py) only pin a model string and an adapter_key.

TWO OpenAI endpoints are supported, selected by the `use_responses_api`
config flag:
  - /v1/chat/completions — the default, used by ordinary chat models.
  - /v1/responses        — required by the "pro" reasoning tier, which
    is NOT a chat model: chat/completions answers 404 "This is not a
    chat model and thus not supported in the v1/chat/completions
    endpoint" (verified 2026-07-26). gpt55pro.py is the only adapter
    that sets use_responses_api; it is registered but disabled in the
    seed, so this branch is reachable only if that system is re-enabled.

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
from app.conference_scales import DEFAULT_CONFERENCE, build_system_prompt
from app.adapters._review_parse import ScoreScale, parse_markdown_review
from app.adapters.base import (
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
                "Set it in services/review-gen/.env for local development."
            )
        # Lazy import so the rest of the service starts without the OpenAI
        # client installed.
        from openai import OpenAI

        self._client = OpenAI(api_key=api_key, max_retries=PROVIDER_MAX_RETRIES)
        self._model = self.config.get("model", "gpt-4o-mini")
        # GPT-5 reasoning models reject any temperature != 1; keep it optional
        # so the seed config can omit it for those models.
        self._temperature = self.config.get("temperature")  # may be None
        self._context_window = int(self.config.get("context_window", 128_000))
        # "pro"-tier reasoning models are Responses-API only (see module
        # docstring). Set by the seed config, not sniffed from the model
        # name, so a future rename can't silently route to a dead endpoint.
        self._use_responses = bool(self.config.get("use_responses_api"))

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

    def _responses_kwargs(self, prompt: str) -> dict:
        """Request shape for /v1/responses. The system prompt becomes
        `instructions` and the paper becomes `input` — the Responses API
        has no `messages` array."""
        kwargs: dict = {
            "model": self._model,
            "instructions": self._system_prompt,
            "input": prompt,
        }
        if self._temperature is not None:
            kwargs["temperature"] = self._temperature
        return kwargs

    def generate(self, paper: ParsedPaper) -> GenerationResult:
        prompt = self._render_prompt(paper)
        if not prompt.strip():
            raise ValueError(
                "Empty paper content — refusing to call the model. "
                "The PDF probably contains no extractable text."
            )
        if self._use_responses:
            response = self._client.responses.create(**self._responses_kwargs(prompt))
            raw = response.output_text or ""
        else:
            response = self._client.chat.completions.create(**self._kwargs(prompt, stream=False))
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
            if self._use_responses:
                # Responses API: deltas arrive as typed events rather than
                # choice objects. Only output_text deltas are user-facing;
                # reasoning-summary events are skipped.
                with self._client.responses.stream(**self._responses_kwargs(prompt)) as stream:
                    # Distinct loop variable per branch: the two APIs yield
                    # unrelated event types, and reusing one name makes mypy
                    # union them and reject `.choices` below.
                    for resp_event in stream:
                        if getattr(resp_event, "type", None) != "response.output_text.delta":
                            continue
                        # getattr, not `.delta`: the SDK types this stream as a
                        # ~50-member event union and the string check above
                        # does not narrow it, so direct attribute access fails
                        # type-checking on every member without a delta.
                        delta = getattr(resp_event, "delta", "") or ""
                        if delta:
                            chunks.append(delta)
                            yield StreamEvent(type="token", text=delta)
            else:
                for chat_event in self._client.chat.completions.create(
                    **self._kwargs(prompt, stream=True)
                ):
                    if not chat_event.choices:
                        continue
                    delta = chat_event.choices[0].delta.content or ""
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
