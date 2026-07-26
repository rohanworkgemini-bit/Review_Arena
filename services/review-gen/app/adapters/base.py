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

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Iterator, Literal

from app.schemas import ParsedPaper, StructuredReview


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
        claude, deepseek) override this. The default
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
