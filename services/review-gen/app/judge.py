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
import re
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


def _is_deepseek(model: str) -> bool:
    return model.lower().startswith("deepseek")


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
        # No SDK default deadline exists for Gemini; without this a stalled
        # judge call pins a threadpool thread forever (observed live).
        request_options={"timeout": 180},
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
        except Exception as e:  # noqa: BLE001 — classified below
            # Only transient failures earn a retry. Auth errors, unknown
            # models, and context-length rejections fail identically on
            # every attempt — retrying them just burns ~15s of backoff per
            # pass while masking a hard config error as flakiness.
            transient = isinstance(e, json.JSONDecodeError) or bool(
                re.search(
                    r"rate.?limit|429|timeout|timed?.?out|connection|unavailable|"
                    r"overloaded|5\d\d|resource.?exhausted",
                    str(e),
                    re.I,
                )
            )
            if not transient:
                raise
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


# Default judge model — DeepSeek V4 Flash (set 2026-09-03, with the
# six-system lineup cut; changed BEFORE any study data was collected, so
# the mid-study-change prohibition below is not violated).
#
# Chosen because DeepSeek no longer appears anywhere in the review-system
# lineup (Google, OpenAI, Anthropic, Mistral, Zhipu, Moonshot) — the
# judge's vendor is fully disjoint from every system under test, which
# retires the docs/FAIRNESS.md B3 self-grading conflict the previous
# Gemini judge carried instead of merely relocating it.
#
# Flash tier on purpose: the judge runs on EVERY generated review
# (2 passes each), the highest-volume model call in the system. The trade
# is a cheaper grader scoring stronger models' output, which biases
# toward noisier scores rather than toward any one system. Report the
# human-judge correlation with that caveat.
#
# Do NOT change this model mid-study — that would make the RQ1
# correlation incomparable across collected data.
DEFAULT_JUDGE_MODEL = "deepseek-v4-flash"


def _client_for(model: str) -> Any:
    """Build the provider client for a judge model (None on the Gemini
    path — it uses the module-global google.generativeai). Raises if the
    required key is missing; no mock fallback."""
    if _is_gemini(model):
        if not os.environ.get("GEMINI_API_KEY"):
            raise RuntimeError(
                f"judge with model={model!r} requires GEMINI_API_KEY "
                "in the environment. There is no mock fallback."
            )
        return None
    if _is_deepseek(model):
        # DeepSeek's OpenAI-compatible endpoint: same chat-completions +
        # response_format shape, different base_url and key.
        if not os.environ.get("DEEPSEEK_API_KEY"):
            raise RuntimeError(
                f"judge with model={model!r} requires DEEPSEEK_API_KEY "
                "in the environment. There is no mock fallback."
            )
        from openai import OpenAI
        # Explicit deadline: the SDK default is 600s/attempt, which under a
        # burst quietly pins threadpool threads (see adapters/base.py).
        return OpenAI(
            api_key=os.environ["DEEPSEEK_API_KEY"],
            base_url="https://api.deepseek.com/v1",
            timeout=180.0,
            max_retries=3,
        )
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError(
            f"judge with model={model!r} requires OPENAI_API_KEY "
            "in the environment. There is no mock fallback."
        )
    from openai import OpenAI
    return OpenAI(timeout=180.0, max_retries=3)


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
    client = _client_for(model)

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
    # A pass only counts if it is COMPLETE and in range. The old behaviour
    # defaulted every missing value to 5 — so a judge pass that returned
    # `{}` produced a clean-looking all-5.0 row that silently polluted the
    # human-vs-judge correlation. Better no score (the review is excluded
    # by judge_status=FAILED) than a fabricated one.
    def _valid_pass(d: dict) -> bool:
        try:
            overall = float(d["overall_score"])
        except (KeyError, TypeError, ValueError):
            return False
        if not 1.0 <= overall <= 10.0:
            return False
        dims = d.get("dimension_scores")
        if not isinstance(dims, dict):
            return False
        for dim in _DIMENSIONS:
            try:
                v = float(dims[dim])
            except (KeyError, TypeError, ValueError):
                return False
            if not 1.0 <= v <= 10.0:
                return False
        return True

    valid = [d for d in pass_data if _valid_pass(d)]
    if len(valid) < len(pass_data):
        logger.warning(
            "discarded %d/%d judge passes with missing or out-of-range scores",
            len(pass_data) - len(valid), len(pass_data),
        )
    if not valid:
        raise RuntimeError(
            f"all {JUDGE_PASSES} judge passes failed or returned invalid scores"
        )

    def _avg(values: list[float]) -> float:
        return sum(values) / len(values)

    overall = _avg([float(d["overall_score"]) for d in valid])
    dimension_scores: dict[str, float] = {}
    for dim in _DIMENSIONS:
        dimension_scores[dim] = _avg([float(d["dimension_scores"][dim]) for d in valid])

    return JudgeResult(
        overall_score=overall,
        dimension_scores=dimension_scores,
    )


# ─── Pairwise judging (2026-09-04) ─────────────────────────────────────────
#
# The judge reads the paper + BOTH reviews in one request and emits the
# same construct the human raters give: a per-dimension A/B/TIE preference
# (plus per-review 1-10 scores for the radar chart, from the same call).
# Two calls per pair, with the review order SWAPPED between them — the
# position-bias control from Zheng et al. 2023 (MT-Bench): a verdict only
# stands where both orderings agree; disagreement records a TIE.
#
# Cost: 2 × (paper + both reviews) ≈ half the input tokens of the previous
# pointwise scheme (2 reviews × 2 passes, paper sent 4 times), and the
# shared paper prefix gets provider-side context caching on the second call.


@dataclass
class PairJudgeResult:
    """Verdict for one (review_a, review_b) pair, in the caller's A/B terms."""

    overall_preference: str                    # "A" | "B" | "TIE"
    dimension_preferences: dict[str, str]      # DIM -> "A" | "B" | "TIE"
    review_a: JudgeResult                      # scores averaged over passes
    review_b: JudgeResult
    passes_used: int                           # 2 = swap-consistent; 1 = degraded
    raw_passes: list[dict]                     # audit trail for the meta column


def _build_pair_prompts(
    paper_text: str, first_review: str, second_review: str
) -> tuple[str, str]:
    """System + user prompt for one pairwise pass. The caller controls
    which real review is REVIEW 1 vs REVIEW 2 (order is swapped between
    passes); the model only ever sees positional labels."""
    system_prompt = (
        "You are a strict meta-reviewer comparing two automated peer reviews "
        "of the same paper. Given the paper and the two candidate reviews, "
        "return a JSON object with this exact shape:\n"
        "{\n"
        '  "reasoning_per_dimension": {DIM: str (1-2 sentences comparing the two reviews) for DIM in ['
        f'{",".join(repr(d) for d in _DIMENSIONS)}'
        "]},\n"
        '  "preference_per_dimension": {DIM: "1" | "2" | "TIE" for the same DIMs},\n'
        '  "overall_preference": "1" | "2" | "TIE",\n'
        '  "review_1_scores": {"dimension_scores": {DIM: float in [1,10]}, "overall_score": float in [1,10]},\n'
        '  "review_2_scores": {"dimension_scores": {DIM: float in [1,10]}, "overall_score": float in [1,10]}\n'
        "}\n\n"
        "Dimension definitions — judge each against exactly this rubric:\n"
        + "".join(f"- {dim}: {_DIMENSION_RUBRIC[dim]}\n" for dim in _DIMENSIONS)
        + "\n"
        "Methodology — follow in order:\n"
        "1. For each dimension, write 1-2 sentences of comparative reasoning "
        "grounded in specific parts of both reviews and the paper.\n"
        '2. Then pick "1", "2", or "TIE" per dimension, consistent with your '
        "reasoning. Prefer TIE only when the reviews are genuinely "
        "indistinguishable on that dimension.\n"
        "3. Score each review 1-10 per dimension and overall (1=very poor, "
        "5=adequate, 8=strong, 10=exemplary; overall is holistic, NOT a "
        "mean). For EVERY dimension a higher score means better — including "
        "FALSE_CLAIMS, where 10 means no false or contradictory claims.\n"
        "4. Judge content, not presentation order: the labels 1 and 2 are "
        "arbitrary and must not influence any preference.\n"
        "5. Do NOT reward verbosity. Length without substance should LOWER "
        "COMPLETENESS_COVERAGE and CRITIQUE_CLARITY, and must never win a "
        "dimension by itself."
    )
    user_prompt = (
        f"=== PAPER ===\n{paper_text[:PAPER_CHAR_CAP]}\n\n"
        f"=== REVIEW 1 ===\n{first_review[:REVIEW_CHAR_CAP]}\n\n"
        f"=== REVIEW 2 ===\n{second_review[:REVIEW_CHAR_CAP]}\n"
    )
    return system_prompt, user_prompt


def _norm_pref(value: Any) -> str | None:
    """Accept '1'/'2'/'TIE' (and ints 1/2) → normalized, else None."""
    s = str(value).strip().upper()
    if s in ("1", "2", "TIE"):
        return s
    return None


def _valid_scores_block(block: Any) -> bool:
    if not isinstance(block, dict):
        return False
    try:
        overall = float(block["overall_score"])
    except (KeyError, TypeError, ValueError):
        return False
    if not 1.0 <= overall <= 10.0:
        return False
    dims = block.get("dimension_scores")
    if not isinstance(dims, dict):
        return False
    for dim in _DIMENSIONS:
        try:
            v = float(dims[dim])
        except (KeyError, TypeError, ValueError):
            return False
        if not 1.0 <= v <= 10.0:
            return False
    return True


def _valid_pair_pass(d: dict) -> bool:
    prefs = d.get("preference_per_dimension")
    if not isinstance(prefs, dict):
        return False
    for dim in _DIMENSIONS:
        if _norm_pref(prefs.get(dim)) is None:
            return False
    if _norm_pref(d.get("overall_preference")) is None:
        return False
    return _valid_scores_block(d.get("review_1_scores")) and _valid_scores_block(
        d.get("review_2_scores")
    )


def judge_pair(
    review_a_text: str,
    review_b_text: str,
    paper_text: str,
    *,
    model: str = DEFAULT_JUDGE_MODEL,
) -> PairJudgeResult:
    """Compare two reviews of one paper. Two order-swapped passes; a
    preference stands only where both orderings agree (else TIE). Raises
    RuntimeError if no pass returns a valid payload."""
    client = _client_for(model)

    # (first_review, second_review, position of review A in this pass)
    orders: list[tuple[str, str, str]] = [
        (review_a_text, review_b_text, "1"),  # pass 0: A is REVIEW 1
        (review_b_text, review_a_text, "2"),  # pass 1: A is REVIEW 2
    ]

    valid: list[tuple[dict, str]] = []  # (payload, a_position)
    raw_passes: list[dict] = []
    for first, second, a_pos in orders:
        system_prompt, user_prompt = _build_pair_prompts(paper_text, first, second)
        try:
            data = _one_judge_pass(
                client,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                model=model,
            )
        except RuntimeError as e:
            logger.warning("pairwise judge pass (A as %s) failed: %s", a_pos, e)
            continue
        raw_passes.append({"a_position": a_pos, "payload": data})
        if _valid_pair_pass(data):
            valid.append((data, a_pos))
        else:
            logger.warning(
                "discarded pairwise judge pass (A as %s): missing or "
                "out-of-range fields", a_pos,
            )

    if not valid:
        raise RuntimeError("both pairwise judge passes failed or returned invalid payloads")

    def to_ab(pref: str, a_pos: str) -> str:
        """'1'/'2'/'TIE' in pass coordinates → 'A'/'B'/'TIE'."""
        if pref == "TIE":
            return "TIE"
        return "A" if pref == a_pos else "B"

    # Preferences: agreement across passes, else TIE. With a single valid
    # pass the verdict is that pass alone (passes_used=1 marks the missing
    # position-bias control for the analysis).
    per_pass_dim: list[dict[str, str]] = []
    per_pass_overall: list[str] = []
    for data, a_pos in valid:
        per_pass_dim.append({
            dim: to_ab(_norm_pref(data["preference_per_dimension"][dim]) or "TIE", a_pos)
            for dim in _DIMENSIONS
        })
        per_pass_overall.append(to_ab(_norm_pref(data["overall_preference"]) or "TIE", a_pos))

    def settle(values: list[str]) -> str:
        return values[0] if all(v == values[0] for v in values) else "TIE"

    dimension_preferences = {
        dim: settle([p[dim] for p in per_pass_dim]) for dim in _DIMENSIONS
    }
    overall_preference = settle(per_pass_overall)

    # Scores: average each review's scores over the valid passes, mapping
    # positions back to A/B per pass.
    def scores_for(side: str) -> JudgeResult:
        overalls: list[float] = []
        dims: dict[str, list[float]] = {dim: [] for dim in _DIMENSIONS}
        for data, a_pos in valid:
            pos = a_pos if side == "A" else ("2" if a_pos == "1" else "1")
            block = data[f"review_{pos}_scores"]
            overalls.append(float(block["overall_score"]))
            for dim in _DIMENSIONS:
                dims[dim].append(float(block["dimension_scores"][dim]))
        return JudgeResult(
            overall_score=sum(overalls) / len(overalls),
            dimension_scores={dim: sum(v) / len(v) for dim, v in dims.items()},
        )

    return PairJudgeResult(
        overall_preference=overall_preference,
        dimension_preferences=dimension_preferences,
        review_a=scores_for("A"),
        review_b=scores_for("B"),
        passes_used=len(valid),
        raw_passes=raw_passes,
    )
