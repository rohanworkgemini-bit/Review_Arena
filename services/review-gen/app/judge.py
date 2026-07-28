"""LLM-as-judge utilities used by the metrics pipeline.

API-based. Dispatches on model name:
  - "gemini-*"  →  Google GenAI (requires GEMINI_API_KEY).
  - everything else  →  OpenAI Chat Completions (requires OPENAI_API_KEY).

If the relevant key is missing the call raises loudly — there's no mock
fallback. The judge runs in the background per review (see
scoreOneReview), so a silent fake would pollute the leaderboard with
nonsense; better to fail and surface a config error.

Methodology references:
  - Zheng et al. 2023 (MT-Bench, arXiv:2306.05685) — reference-guided
    single-answer grading is our base paradigm.
  - Liu et al. 2023 (G-Eval, arXiv:2303.16634) — CoT + form-filling
    paradigm; the reasoning_per_dimension field below implements this.
  - Self-consistency: we run the judge JUDGE_PASSES times and average
    scores to reduce per-call stochasticity (model isn't perfectly
    deterministic even at temperature=0).
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("review-gen.judge")

# Number of judge calls to average per review. 2 catches most outlier
# scores at ~2x the cost; higher N has diminishing returns. Even at
# temperature=0 the model can return scores ±0.5 across calls.
JUDGE_PASSES = 2

# Retry tuning for transient OpenAI errors (rate limits, timeouts,
# malformed JSON). Matches FastChat's pattern at lower scale: 5 attempts
# with exponential backoff = max ~30s wait before giving up.
JUDGE_RETRY_MAX = 5
JUDGE_RETRY_BASE_SEC = 1.0


@dataclass
class JudgeResult:
    """Bundle returned by the judge for a single review."""

    overall_score: float            # 1-10
    dimension_scores: dict[str, float]


# Keep in sync with VOTE_DIMENSIONS in packages/shared-types/src/dimensions.ts
# and the vote_dimension pgEnum in apps/api/src/db/schema.ts. The human
# voters compare these same eight axes pairwise, so the judge must score
# the same construct for the human-vs-judge agreement analysis (RQ1) to
# mean anything.
_DIMENSIONS = (
    "CONTRIBUTION_ACCURACY",
    "RESULTS_INTERPRETATION",
    "COMPARATIVE_ANALYSIS",
    "EVIDENCE_BASED_CRITIQUE",
    "CRITIQUE_CLARITY",
    "COMPLETENESS_COVERAGE",
    "CONSTRUCTIVE_TONE",
    "FALSE_CLAIMS",
)

# The rubric each dimension is scored against. This is the ONLY copy — the
# voter-facing wording lives in DIMENSION_DESCRIPTIONS (shared-types), phrased
# as the pairwise question. Keep the two semantically aligned so the
# human-vs-judge agreement analysis (RQ1) compares the same construct.
_DIMENSION_RUBRIC = {
    "CONTRIBUTION_ACCURACY": (
        "Whether the review correctly understands the paper's main contributions "
        "and methodological innovations without misrepresenting them."
    ),
    "RESULTS_INTERPRETATION": (
        "Whether tables, figures, metrics, statistical comparisons, and "
        "experimental results are interpreted correctly without exaggeration."
    ),
    "COMPARATIVE_ANALYSIS": (
        "Whether the review appropriately discusses the paper's baselines and "
        "related-work comparisons without making unsupported claims."
    ),
    "EVIDENCE_BASED_CRITIQUE": (
        "Whether criticisms are supported by identifiable evidence from sections, "
        "equations, algorithms, tables, or figures."
    ),
    "CRITIQUE_CLARITY": (
        "Whether weaknesses and questions are concrete enough for authors to "
        "understand the issue and how it could be addressed."
    ),
    "COMPLETENESS_COVERAGE": (
        "Whether the review covers the major parts of the paper, including "
        "methodology, theory, experiments, and related work."
    ),
    "CONSTRUCTIVE_TONE": (
        "Whether the review is professional, balanced, respectful, and focused "
        "on helping improve the work."
    ),
    "FALSE_CLAIMS": (
        "Whether the review avoids inventing content, claiming an existing "
        "experiment is missing, or contradicting the paper's methods or "
        "reported findings. NOTE: higher score = FEWER such problems."
    ),
}


# The judge reads the COMPLETE paper and review (changed 2026-07-28;
# previously paper[:12000] / review[:6000]). Rationale: FALSE_CLAIMS and
# EVIDENCE_BASED_CRITIQUE ask whether the review's claims are grounded in
# the paper — with a 12k-char cap the judge never saw the experiments
# section it was supposed to verify claims against, so those scores were
# partly guesses. gemini-3.6-flash has a 1M-token window; a full canonical
# paper (~23k tokens) fits with a wide margin.
#
# The caps below are SAFETY LIMITS against pathological inputs (a 400-page
# scanned PDF), not evaluation truncation — no real paper or review comes
# near them. ~4 chars/token ⇒ 400k chars ≈ 100k tokens.
#
# Cost at Flash pricing ($1.50/M in, $7.50/M out, 2 passes): ≈ $0.05-0.09
# per review vs ≈ $0.026 truncated — accepted for grounded scores.
# Do not change these mid-study: judge inputs must be one regime across
# all collected data or the RQ1 correlation is incomparable.
PAPER_CHAR_CAP = 400_000
REVIEW_CHAR_CAP = 50_000


def _build_prompts(paper_text: str, review_text: str) -> tuple[str, str]:
    """System + user prompt for one judge pass. Pure function so both the
    single-pass call and the multi-pass loop produce byte-identical
    inputs to the model (matters for prompt-caching hit rate)."""
    system_prompt = (
        "You are a strict meta-reviewer evaluating an automated peer review. "
        "Given the original paper text and a candidate review, return a JSON "
        "object with this exact shape:\n"
        "{\n"
        '  "reasoning_per_dimension": {DIM: str (1-2 sentences explaining the score) for DIM in ['
        f'{",".join(repr(d) for d in _DIMENSIONS)}'
        "]},\n"
        '  "dimension_scores": {DIM: float in [1,10] for DIM in ['
        f'{",".join(repr(d) for d in _DIMENSIONS)}'
        "]},\n"
        '  "overall_score": float in [1,10]\n'
        "}\n\n"
        "Dimension definitions — score each against exactly this rubric:\n"
        + "".join(
            f"- {dim}: {_DIMENSION_RUBRIC[dim]}\n" for dim in _DIMENSIONS
        )
        + "\n"
        "Methodology — follow in order:\n"
        "1. For each dimension, write 1-2 sentences of reasoning grounded in "
        "specific parts of the review and paper. This goes in "
        "`reasoning_per_dimension`. (Chain-of-thought before scoring, "
        "per Liu et al. 2023 G-Eval, improves score calibration.)\n"
        "2. Then assign each dimension a 1-10 score consistent with your "
        "reasoning. 1=very poor, 5=adequate, 8=strong, 10=exemplary. For "
        "EVERY dimension a higher score means the review is BETTER on that "
        "axis — including FALSE_CLAIMS, where 10 means no false or "
        "contradictory claims and 1 means many.\n"
        "3. Set `overall_score` as a holistic 1-10 judgment of the review's "
        "value to a paper author (NOT a mean of the dimensions).\n"
        "4. Do NOT reward verbose or padded reviews. Length without "
        "substance should LOWER the COMPLETENESS_COVERAGE and "
        "CRITIQUE_CLARITY scores."
    )
    user_prompt = (
        f"=== PAPER ===\n{paper_text[:PAPER_CHAR_CAP]}\n\n"
        f"=== REVIEW ===\n{review_text[:REVIEW_CHAR_CAP]}\n"
    )
    return system_prompt, user_prompt


def _is_gemini(model: str) -> bool:
    return model.lower().startswith("gemini")


def _openai_judge_pass(
    client: Any,
    *,
    system_prompt: str,
    user_prompt: str,
    model: str,
) -> dict:
    response = client.chat.completions.create(
        model=model,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    raw = response.choices[0].message.content or "{}"
    data: dict = json.loads(raw)
    return data


def _gemini_judge_pass(
    *,
    system_prompt: str,
    user_prompt: str,
    model: str,
) -> dict:
    """One Gemini judge call. Uses google.generativeai with
    response_mime_type=application/json so the model returns parseable
    JSON without a code fence."""
    import google.generativeai as genai

    # generativeai is module-global by design — `configure()` sets the
    # API key for the process. Repeated calls are cheap and idempotent.
    genai.configure(api_key=os.environ["GEMINI_API_KEY"])
    gm = genai.GenerativeModel(
        model_name=model,
        system_instruction=system_prompt,
    )
    response = gm.generate_content(
        user_prompt,
        generation_config={
            "temperature": 0,
            "response_mime_type": "application/json",
        },
    )
    raw = (response.text or "{}").strip()
    data: dict = json.loads(raw)
    return data


def _one_judge_pass(
    client: Any,
    *,
    system_prompt: str,
    user_prompt: str,
    model: str,
) -> dict:
    """Single judge call with retry on transient errors. Dispatches by
    model name. Returns the parsed JSON dict. Raises RuntimeError if all
    retries fail. `client` is the OpenAI client (unused for Gemini)."""
    last_err: Exception | None = None
    for attempt in range(JUDGE_RETRY_MAX):
        try:
            if _is_gemini(model):
                return _gemini_judge_pass(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    model=model,
                )
            return _openai_judge_pass(
                client,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                model=model,
            )
        except Exception as e:  # noqa: BLE001 — retry on anything transient-looking
            last_err = e
            if attempt < JUDGE_RETRY_MAX - 1:
                # Exponential backoff: 1s, 2s, 4s, 8s. Caps total wait
                # at ~15s before raising.
                sleep_s = JUDGE_RETRY_BASE_SEC * (2 ** attempt)
                logger.warning(
                    "judge call failed (attempt %d/%d): %s — sleeping %.1fs",
                    attempt + 1, JUDGE_RETRY_MAX, e, sleep_s,
                )
                time.sleep(sleep_s)
    raise RuntimeError(f"judge call failed after {JUDGE_RETRY_MAX} attempts: {last_err}")


# Default judge model — Gemini 3.6 Flash (set 2026-07-27).
#
# KNOWN, ACCEPTED CONFLICT: this is the SAME model id the
# `gemini-3.6-flash` leaderboard system is pinned to (see
# apps/api/scripts/seed.ts), and a same-family sibling of
# `gemini-3.1-pro`. The judge therefore grades its own output for 1 of
# the 10 systems.
#
# This is not an oversight. Since the 2026-07 lineup refresh the board
# spans five vendors (OpenAI, Anthropic, Google, DeepSeek, Mistral), so
# no frontier judge is free of vendor overlap — moving the judge would
# relocate the conflict, not remove it. The thesis's primary claim rests
# on *human* Elo; the judge is a secondary correlate for RQ1.
#
# Flash vs Pro: the judge runs on EVERY generated review (2 passes each),
# so it is the highest-volume model call in the system. Flash is the
# cheap, low-latency tier; the trade is a weaker grader scoring stronger
# models' output, which biases toward noisier scores rather than toward
# any one system. Report the human-judge correlation with that caveat.
#
# Required mitigation (docs/FAIRNESS.md B3): report judge scores for the
# two Google systems separately and check whether judge-human correlation
# differs for them. Do NOT change this model again mid-study — that would
# make the RQ1 correlation incomparable across collected data.
DEFAULT_JUDGE_MODEL = "gemini-3.6-flash"


def judge_review(
    review_text: str,
    paper_text: str,
    *,
    model: str = DEFAULT_JUDGE_MODEL,
) -> JudgeResult:
    """Score a review against the paper.

    Returns overall + per-dimension scores. Raises RuntimeError if the
    relevant API key (GEMINI_API_KEY for gemini-*, OPENAI_API_KEY
    otherwise) is missing — no fake-data fallback.

    Runs the judge JUDGE_PASSES times and averages numeric scores to
    reduce stochasticity (even at temperature=0 the model is not
    perfectly deterministic, ~±0.5 variance observed).
    """
    using_gemini = _is_gemini(model)
    if using_gemini:
        if not os.environ.get("GEMINI_API_KEY"):
            raise RuntimeError(
                f"judge_review with model={model!r} requires GEMINI_API_KEY "
                "in the environment. There is no mock fallback."
            )
        client = None  # not used on the Gemini path
    else:
        if not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError(
                f"judge_review with model={model!r} requires OPENAI_API_KEY "
                "in the environment. There is no mock fallback."
            )
        from openai import OpenAI
        client = OpenAI()

    system_prompt, user_prompt = _build_prompts(paper_text, review_text)

    # Multi-pass averaging. If all passes fail we surface the error;
    # if some succeed we average over successes (still informative).
    pass_data: list[dict] = []
    for pass_idx in range(JUDGE_PASSES):
        try:
            pass_data.append(_one_judge_pass(
                client,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                model=model,
            ))
        except RuntimeError as e:
            logger.warning("judge pass %d/%d failed: %s", pass_idx + 1, JUDGE_PASSES, e)
    if not pass_data:
        raise RuntimeError(f"all {JUDGE_PASSES} judge passes failed")

    # Average numeric scores across successful passes.
    def _avg(values: list[float]) -> float:
        return sum(values) / len(values) if values else 5.0

    overall = _avg([float(d.get("overall_score", 5)) for d in pass_data])
    dimension_scores: dict[str, float] = {}
    for dim in _DIMENSIONS:
        dimension_scores[dim] = _avg([
            float(d.get("dimension_scores", {}).get(dim, 5))
            for d in pass_data
        ])

    return JudgeResult(
        overall_score=overall,
        dimension_scores=dimension_scores,
    )
