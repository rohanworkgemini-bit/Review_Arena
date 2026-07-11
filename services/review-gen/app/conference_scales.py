"""Per-conference overall-recommendation scales + the shared review-form
system prompt used by the commercial adapters (Claude/GPT/Gemini/DeepSeek).

The uploader picks a conference at upload time; the choice flows
paper → API → GenerateRequest.conference → adapter config → this prompt,
so BOTH systems in a battle review under the same venue's scale (fairness:
an ICLR-style review is never compared against an ARR-style one).

Scales verified against the live venue guidelines (July 2026):
  - ICLR 2026 Reviewer Guide — overall rating mapped to {0,2,4,6,8,10}
    (changed from 2025's {1,3,5,6,8,10}).
  - NeurIPS 2025/2026 Reviewer Guidelines — 6-point scale (1-6).
  - ICML 2026 Reviewer Instructions — 6-point scale (1-6).
  - ACL Rolling Review (ARR) review form — Overall Assessment 1-5,
    half points allowed. EMNLP reviews through the same ARR form.

Only the ## Rating section varies by venue. The rest of the form
(Soundness/Presentation/Contribution 1-4, Confidence 1-5, the section
order) is our fixed output contract — every adapter emits it so one
parser handles all systems (see _review_parse.parse_markdown_review).

The fine-tuned specialist adapters (OpenReviewer, CycleReviewer,
DeepReviewer, SEA) keep their trained prompt/format regardless of the
selected conference — you cannot re-scale a fine-tuned reviewer by
prompt. The conference option is a commercial-adapter feature, which
matches the thesis deployment (commercial models only).
"""
from __future__ import annotations

from textwrap import dedent
from typing import Dict

DEFAULT_CONFERENCE = "iclr"

CONFERENCE_SCALES: Dict[str, Dict] = {
    "iclr": {
        "name": "ICLR 2026",
        "scores": [0, 2, 4, 6, 8, 10],
        "labels": {
            10: "Strong accept — should be highlighted at the conference",
            8:  "Accept — good submission",
            6:  "Marginally above the acceptance threshold",
            4:  "Marginally below the acceptance threshold",
            2:  "Reject — not good enough",
            0:  "Strong reject",
        },
    },
    "icml": {
        "name": "ICML 2026",
        "scores": [1, 2, 3, 4, 5, 6],
        "labels": {
            6: "Strong Accept — technically flawless, exceptional impact",
            5: "Accept — technically solid, high impact",
            4: "Weak Accept — solid contribution, some weaknesses limit impact",
            3: "Weak Reject — clear merits but weaknesses outweigh",
            2: "Reject — e.g. technical flaws, weak evaluation, poor reproducibility",
            1: "Strong Reject — e.g. well-known results, impossible to judge contribution",
        },
    },
    "neurips": {
        "name": "NeurIPS 2026",
        "scores": [1, 2, 3, 4, 5, 6],
        "labels": {
            6: "Strong Accept — technically flawless, groundbreaking impact",
            5: "Accept — technically solid, high potential value",
            4: "Borderline Accept — acceptance reasons outweigh rejection reasons",
            3: "Borderline Reject — rejection reasons outweigh acceptance reasons",
            2: "Reject — technical flaws, weak evaluation, inadequate reproducibility",
            1: "Strong Reject — well-known results or unaddressed ethical considerations",
        },
    },
    "acl": {
        "name": "ACL (ARR)",
        "scores": [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5],
        "labels": {
            5:   "Consider for Award",
            4.5: "Borderline Award",
            4:   "Conference — could be accepted to an *ACL conference",
            3.5: "Borderline Conference",
            3:   "Findings — could be accepted to Findings of ACL",
            2.5: "Borderline Findings",
            2:   "Resubmit next cycle — needs substantial revisions",
            1.5: "Resubmit after next cycle — revisions cannot be completed in one cycle",
            1:   "Do not resubmit — paper has to be fully redone",
        },
    },
    "emnlp": {
        "name": "EMNLP (ARR)",
        "scores": [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5],
        "labels": {
            5:   "Consider for Award",
            4.5: "Borderline Award",
            4:   "Conference — could be accepted to an *ACL conference",
            3.5: "Borderline Conference",
            3:   "Findings — could be accepted to Findings of ACL",
            2.5: "Borderline Findings",
            2:   "Resubmit next cycle — needs substantial revisions",
            1.5: "Resubmit after next cycle — revisions cannot be completed in one cycle",
            1:   "Do not resubmit — paper has to be fully redone",
        },
    },
}


def _fmt_score(v: float) -> str:
    """1.0 → '1', 4.5 → '4.5' — keeps the prompt free of float noise."""
    return str(int(v)) if float(v).is_integer() else str(v)


def _rating_block(conference: str) -> str:
    """The venue-specific '## Rating' section of the review form."""
    scale = CONFERENCE_SCALES.get(conference, CONFERENCE_SCALES[DEFAULT_CONFERENCE])
    allowed = ", ".join(_fmt_score(s) for s in scale["scores"])
    labels = "\n".join(
        f"       {_fmt_score(score)} = {label}"
        for score, label in sorted(scale["labels"].items(), reverse=True)
    )
    return (
        f"## Rating\n"
        f"    (Overall recommendation on the {scale['name']} scale. Answer with a\n"
        f"    SINGLE NUMBER from this exact set: {{{allowed}}}. Meaning of each score:\n"
        f"{labels})"
    )


def build_system_prompt(conference: str = DEFAULT_CONFERENCE) -> str:
    """Full review-form system prompt for the commercial adapters. The
    section order and the 1-4 / 1-5 sub-scales are fixed (single parser
    across systems); only the ## Rating semantics track the venue."""
    scale = CONFERENCE_SCALES.get(conference, CONFERENCE_SCALES[DEFAULT_CONFERENCE])
    return dedent(f"""
        You are an experienced peer reviewer for {scale["name"]}. Read the
        paper below and write a structured peer review using markdown
        headers, in the EXACT order shown.

        For each numeric section (Soundness, Presentation, Contribution,
        Rating, Confidence), begin with a SINGLE NUMBER on its own line,
        then one brief sentence explaining the score.

        ## Summary
        (2-4 sentences describing what the paper does and your overall impression.)

        ## Soundness
        (Integer 1-4 — 1=poor, 2=fair, 3=good, 4=excellent. Methodology + logical
        consistency.)

        ## Presentation
        (Integer 1-4. Clarity, structure, writing quality.)

        ## Contribution
        (Integer 1-4. Novelty and significance.)

        {_rating_block(conference)}

        ## Confidence
        (Integer 1-5. How confident you are in this assessment.)

        ## Strengths
        (Concise bullet list, 3-5 items.)

        ## Weaknesses
        (Concise bullet list, 3-6 items.)

        ## Questions
        (Concise bullet list of questions for the authors, 2-5 items.)


        Plain markdown only — no preamble, no JSON, no extra commentary.
    """).strip()
