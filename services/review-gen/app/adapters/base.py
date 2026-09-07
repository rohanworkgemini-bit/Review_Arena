"""Adapter contract every review system implements.

A single class per system. The adapter is responsible for:
  - mapping our ParsedPaper into whatever the model expects,
  - calling the model (streaming or not),
  - mapping the model's output into our StructuredReview shape,
  - returning the verbatim raw text alongside the structured payload.

Adapters are stateful and constructed once at process start (so HF models
get loaded once). Per-request work happens in `generate()` /
`generate_stream()`.

Two entry points:
  - generate(paper)        → GenerationResult       (blocking, full result)
  - generate_stream(paper) → Iterator[StreamEvent]  (yields tokens then final)

generate_stream is what /stream-generate exposes over SSE so the browser
can show tokens appearing live. generate() is still used by non-UI
consumers (admin re-score, smoke tests). Default base impl wraps
generate() into a single-chunk stream — adapters with native streaming
override generate_stream() for true token-level deltas.
"""
from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Iterator, Literal

from app.schemas import ParsedPaper, StructuredReview

# How many times a provider SDK retries a failed call before giving up.
#
# Both the OpenAI and Anthropic SDKs default to 2, which is too few here.
# A battle streams TWO systems concurrently, so when both are from the
# same provider their prompts land in the same tokens-per-minute window
# at the same instant — a full paper is ~25k tokens, and an org on the
# 50k TPM tier is then at the ceiling from a single pairing. The provider
# answers 429 with a retry-after of ~10s; two short retries expire before
# the window rolls over and the participant sees "generation failed".
#
# Both SDKs honour the retry-after header and back off exponentially, so
# raising this simply waits the rate limit out instead of failing the
# round. It costs nothing when there is no contention. Retries happen
# before the first token is emitted, so the streaming path is safe — no
# duplicated output.
PROVIDER_MAX_RETRIES = int(os.environ.get("PROVIDER_MAX_RETRIES", "3"))

# Hard per-attempt deadline for every provider call. Without it the OpenAI/
# Anthropic SDKs default to 600s per attempt and Gemini to NO deadline at
# all — one stalled connection then pins a worker thread indefinitely, and
# enough of them wedge the whole service (observed live: TCP accepted, no
# response headers, 0%% CPU). Retries times this is the worst-case hold.
PROVIDER_TIMEOUT_S = float(os.environ.get("PROVIDER_TIMEOUT_S", "180"))

_RATE_LIMIT_RX = re.compile(r"rate.?limit|429|tokens per min|TPM", re.I)


def friendly_error(exc: Exception) -> str:
    """Message shown in the UI when a generation fails.

    Rate limits are an operational condition, not a bug in the review, so
    they get a plain explanation instead of the provider's raw string
    (which quotes internal org ids and token counters at the participant).
    """
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    text = str(exc)
    if status == 429 or _RATE_LIMIT_RX.search(text):
        return (
            "This model is rate-limited right now and did not respond in time. "
            "Press Retry in a moment — the other review is unaffected."
        )
    return text


@dataclass
class GenerationMetrics:
    """Fairness accounting for one generation (docs/FAIRNESS.md A4).

    input_tokens:   reference-tokenizer count of the canonical text the
                    system was handed (the full canonical text for commercial adapters).
    output_tokens:  reference-tokenizer count of the produced review.
    context_window: the system's native window (logged for transparency;
                    NOT used to size the input — that is equalized).
    fair_input_tokens / fair_output_tokens: legacy cap columns. The caps
                    were removed (every system now gets the full paper and
                    an uncapped response), so fair_output_tokens is 0 for
                    all adapters and fair_input_tokens just mirrors the
                    canonical-prompt count. Kept so historical rows stay
                    comparable.
    """

    input_tokens: int = 0
    output_tokens: int = 0
    context_window: int = 0
    fair_input_tokens: int = 0
    fair_output_tokens: int = 0


@dataclass
class GenerationResult:
    review: StructuredReview
    raw_output: str
    metrics: GenerationMetrics | None = None


@dataclass
class StreamEvent:
    """One event emitted by generate_stream().

    type == "token":  `text` holds a delta chunk to render in the UI.
    type == "done":   `result` holds the final parsed StructuredReview;
                      `raw_output` is the concatenated stream;
                      `metrics` holds the fairness token accounting.
    type == "error":  `error` holds the failure message.
    """

    type: Literal["token", "done", "error"]
    text: str = ""
    result: StructuredReview | None = None
    raw_output: str = ""
    error: str = ""
    metrics: GenerationMetrics | None = None


class Adapter(ABC):
    """Subclass for each review system."""

    #: Stable key the Node service uses to route generation requests.
    adapter_key: str = "unknown"

    def __init__(self, config: dict | None = None) -> None:
        self.config = config or {}

    @abstractmethod
    def generate(self, paper: ParsedPaper) -> GenerationResult:
        """Produce a structured review for `paper`. Must be deterministic
        given the same paper + config when the underlying model permits.

        Everything the adapter needs comes from the parsed `paper` — the
        original PDF buffer is never forwarded, because every system is a
        text-in commercial API.
        """

    def generate_stream(self, paper: ParsedPaper) -> Iterator[StreamEvent]:
        """Yield token deltas, then a final 'done' event with the parsed
        StructuredReview. Adapters with native streaming (gpt, gemini,
        claude, and the OpenAI-compatible ones) override this. The default
        implementation falls back to a single-shot generate() — useful
        for adapters where the model produces output in one go.
        """
        try:
            result = self.generate(paper)
        except Exception as e:  # noqa: BLE001
            yield StreamEvent(type="error", error=str(e))
            return
        # Emit the whole raw output as a single token, then the done
        # event so SSE clients still get the structured payload.
        yield StreamEvent(type="token", text=result.raw_output)
        yield StreamEvent(
            type="done",
            result=result.review,
            raw_output=result.raw_output,
        )
