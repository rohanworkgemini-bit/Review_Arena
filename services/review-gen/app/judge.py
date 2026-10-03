"""LLM-as-judge: pairwise comparison of two reviews of one paper.

API-based. The judge is a PANEL: the Node side calls /judge-pair once per
study system, so every model in the lineup judges every study pair
(itself included — self-judgements are flagged downstream, not skipped).
Each call names its model explicitly; this module routes on the model-id
prefix (see _PROVIDERS):
  - "gemini-*"    →  Google GenAI              (GEMINI_API_KEY)
  - "claude-*"    →  Anthropic Messages API     (ANTHROPIC_API_KEY)
  - "gpt-*"       →  OpenAI Chat Completions    (OPENAI_API_KEY)
  - "deepseek-*", "mistral-*", "glm-*"  →  the provider's OpenAI-compatible
    endpoint (DEEPSEEK_API_KEY / MISTRAL_API_KEY / ZAI_API_KEY)
An unknown prefix raises — there is no silent fallback to OpenAI.

If the relevant key is missing the call raises loudly — there's no mock
fallback. The judge runs in the background per pair (see
scorePairIfReady), so a silent fake would pollute the leaderboard with
nonsense; better to fail and surface a config error.

Methodology references:
  - Zheng et al. 2023 (MT-Bench, arXiv:2306.05685) — pairwise comparison
    with an order-swapped second pass as the position-bias control.
  - Liu et al. 2023 (G-Eval, arXiv:2303.16634) — CoT + form-filling
    paradigm; the reasoning_per_dimension field below implements this.
"""
from __future__ import annotations

import json
import re
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Literal

logger = logging.getLogger("review-gen.judge")

# Retry tuning for transient OpenAI errors (rate limits, timeouts,
# malformed JSON): 5 attempts
# with exponential backoff = max ~30s wait before giving up.
JUDGE_RETRY_MAX = 5
JUDGE_RETRY_BASE_SEC = 1.0


@dataclass
class JudgeResult:
    """One review's scores within a pairwise verdict."""

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


# ─── Provider routing ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Provider:
    kind: Literal["openai", "gemini", "anthropic"]
    env: str                      # API-key environment variable
    base_url: str | None          # OpenAI-compatible endpoints only
    json_mode: bool               # send response_format=json_object
    temperature: float | None     # None = omit (reasoning models reject it)


# Keyed by model-id prefix; longest match wins. Mirrors the client
# construction in app/adapters/{gpt,gemini,claude,mistral,glm,
# deepseekv4flash}.py so the judge reaches each provider exactly the way
# the generator does.
_PROVIDERS: dict[str, _Provider] = {
    "gemini": _Provider("gemini", "GEMINI_API_KEY", None, True, 0.0),
    "claude": _Provider("anthropic", "ANTHROPIC_API_KEY", None, False, None),
    "deepseek": _Provider("openai", "DEEPSEEK_API_KEY", "https://api.deepseek.com/v1", True, 0.0),
    "mistral": _Provider("openai", "MISTRAL_API_KEY", "https://api.mistral.ai/v1", True, 0.0),
    "glm": _Provider("openai", "ZAI_API_KEY", "https://api.z.ai/api/paas/v4", True, 0.0),
    # gpt-5.x rejects any non-default temperature (see adapters/gpt56terra.py).
    "gpt": _Provider("openai", "OPENAI_API_KEY", None, True, None),
}


def _provider_for(model: str) -> _Provider:
    """Route a model id to its provider by prefix. Raises on an unknown
    prefix — a typo must not silently become an OpenAI call."""
    key = model.lower()
    matches = [prefix for prefix in _PROVIDERS if key.startswith(prefix)]
    if not matches:
        raise RuntimeError(
            f"no judge provider for model={model!r}; known prefixes: "
            f"{', '.join(sorted(_PROVIDERS))}"
        )
    return _PROVIDERS[max(matches, key=len)]


def _parse_json_text(raw: str) -> dict:
    """Parse a judge payload, tolerating a ```json fence or stray prose
    around the object (Z.ai and Mistral occasionally fence even in JSON
    mode). Raises json.JSONDecodeError — classified as transient — when
    no object is found."""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end < start:
        raise json.JSONDecodeError("no JSON object in judge output", text, 0)
    data: dict = json.loads(text[start:end + 1])
    return data


# JSON schema for Anthropic structured outputs (output_config.format).
# It mirrors the shape _build_pair_prompts asks every provider for, so the
# Claude judge cannot drift from the others.
def _dim_object(value_schema: dict) -> dict:
    return {
        "type": "object",
        "properties": {dim: value_schema for dim in _DIMENSIONS},
        "required": list(_DIMENSIONS),
        "additionalProperties": False,
    }


_SCORES_BLOCK_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "dimension_scores": _dim_object({"type": "number"}),
        "overall_score": {"type": "number"},
    },
    "required": ["dimension_scores", "overall_score"],
    "additionalProperties": False,
}

_PREF_SCHEMA: dict = {"type": "string", "enum": ["1", "2", "TIE"]}

_PAIR_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "reasoning_per_dimension": _dim_object({"type": "string"}),
        "preference_per_dimension": _dim_object(_PREF_SCHEMA),
        "overall_preference": _PREF_SCHEMA,
        "review_1_scores": _SCORES_BLOCK_SCHEMA,
        "review_2_scores": _SCORES_BLOCK_SCHEMA,
    },
    "required": [
        "reasoning_per_dimension",
        "preference_per_dimension",
        "overall_preference",
        "review_1_scores",
        "review_2_scores",
    ],
    "additionalProperties": False,
}


def _openai_judge_pass(
    client: Any,
    *,
    provider: _Provider,
    system_prompt: str,
    user_prompt: str,
    model: str,
) -> dict:
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    if provider.json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    if provider.temperature is not None:
        kwargs["temperature"] = provider.temperature
    response = client.chat.completions.create(**kwargs)
    raw = response.choices[0].message.content or "{}"
    return _parse_json_text(raw)


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
    return _parse_json_text(raw)


def _anthropic_judge_pass(
    client: Any,
    *,
    system_prompt: str,
    user_prompt: str,
    model: str,
    schema: dict,
) -> dict:
    """One Claude judge call. Structured output via output_config.format
    guarantees a schema-valid JSON text block; no temperature (Sonnet 5
    rejects it), no assistant prefill (removed on the 4.6+ family), and
    adaptive thinking left at its default. Streamed and collected because
    the SDK refuses non-streaming requests that may exceed 10 minutes
    under adaptive thinking (see adapters/claude.py)."""
    with client.messages.stream(
        model=model,
        max_tokens=16_000,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
        output_config={
            "format": {"type": "json_schema", "schema": schema},
            # The judge is a form-filling task; medium effort keeps the
            # panel affordable without dropping the CoT.
            "effort": "medium",
        },
    ) as stream:
        message = stream.get_final_message()
    if message.stop_reason == "refusal":
        # Deliberately worded so the transient-error classifier does not
        # retry it: a policy refusal repeats identically on every attempt.
        raise RuntimeError(f"anthropic judge refused the request: {message.stop_details}")
    text = next((block.text for block in message.content if block.type == "text"), "")
    return _parse_json_text(text)


def _one_judge_pass(
    client: Any,
    *,
    provider: _Provider,
    schema: dict,
    system_prompt: str,
    user_prompt: str,
    model: str,
) -> dict:
    """Single judge call with retry on transient errors. Dispatches on the
    provider kind. Returns the parsed JSON dict. Raises RuntimeError if all
    retries fail. `client` is the provider SDK client (None for Gemini)."""
    last_err: Exception | None = None
    for attempt in range(JUDGE_RETRY_MAX):
        try:
            if provider.kind == "gemini":
                return _gemini_judge_pass(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    model=model,
                )
            if provider.kind == "anthropic":
                return _anthropic_judge_pass(
                    client,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    model=model,
                    schema=schema,
                )
            return _openai_judge_pass(
                client,
                provider=provider,
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


# There is no default judge model (panel design, 2026-09, set BEFORE any
# study data was collected): the Node side names one of the six study
# systems on every call, so the judge's vendor is never disjoint from the
# systems under test. Self-judging is therefore a measured quantity — every
# verdict row carries self_judging, and the analysis reports the panel
# with and without those rows — instead of a design assumption.
#
# Do NOT change the panel membership or the prompts mid-study — that would
# make the human-vs-judge correlation incomparable across collected data.


def _client_for(model: str, provider: _Provider) -> Any:
    """Build the provider client for a judge model (None on the Gemini
    path — it uses the module-global google.generativeai). Raises if the
    required key is missing; no mock fallback."""
    api_key = os.environ.get(provider.env)
    if not api_key:
        raise RuntimeError(
            f"judge with model={model!r} requires {provider.env} "
            "in the environment. There is no mock fallback."
        )
    if provider.kind == "gemini":
        return None
    # Explicit deadlines: the SDK defaults are 600s/attempt, which under a
    # burst quietly pin threadpool threads (see adapters/base.py).
    if provider.kind == "anthropic":
        from anthropic import Anthropic

        return Anthropic(api_key=api_key, timeout=180.0, max_retries=3)
    from openai import OpenAI

    return OpenAI(api_key=api_key, base_url=provider.base_url, timeout=180.0, max_retries=3)


# ─── Pairwise judging (2026-09-04) ─────────────────────────────────────────
#
# The judge reads the paper + BOTH reviews in one request and emits the
# same construct the human raters give: a per-dimension A/B/TIE preference
# (plus per-review 1-10 scores for the radar chart, from the same call).
# Two calls per pair, with the review order SWAPPED between them — the
# position-bias control from Zheng et al. 2023 (MT-Bench): a verdict only
# stands where both orderings agree; disagreement records a TIE.
#
# Cost: 2 × (paper + both reviews) per judge per pair.


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
    model: str,
) -> PairJudgeResult:
    """Compare two reviews of one paper with one panel member. Two
    order-swapped passes; a preference stands only where both orderings
    agree (else TIE). Raises RuntimeError if no pass returns a valid
    payload."""
    provider = _provider_for(model)
    client = _client_for(model, provider)

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
                provider=provider,
                schema=_PAIR_SCHEMA,
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
