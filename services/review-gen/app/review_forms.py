"""Review forms + rating scales for the review-generation prompts: one per
venue (ICLR, ICML, NeurIPS) plus the venue-neutral General form.

The uploader picks a conference at upload time; the choice flows
paper → API → GenerateRequest.conference → adapter config → this prompt,
so BOTH systems in a battle review under the same venue's form (fairness:
an ICLR-style review is never compared against a NeurIPS-style one).

Three venue editions — ICLR 2026, ICML 2026, NeurIPS 2026 — and each one
gets its OWN form, mirroring the venue's real reviewer form (section
names, section order, scales), not a house hybrid. The UI shows raters
the model's raw markdown verbatim, so what students read is the venue
form exactly as the LLM filled it in. Forms verified against the live
venue pages (September 2026):

  - ICLR 2026 Reviewer Guide + OpenReview form — Summary, Soundness/
    Presentation/Contribution each 1-4, Strengths, Weaknesses, Questions,
    ethics flag, overall Rating on {0,2,4,6,8,10} (changed from 2025's
    {1,3,5,6,8,10}), Confidence 1-5.
  - ICML 2026 Reviewer Instructions — Summary, Strengths & Weaknesses
    narrative, numeric Soundness/Presentation/Significance/Originality
    each 1-4, Key Questions For Authors, Limitations, Overall
    Recommendation 1-6, Confidence 1-5.
  - NeurIPS 2026 Reviewer Guidelines — Summary, Strengths & Weaknesses
    narrative over the four core dimensions, numeric Quality/Clarity/
    Significance/Originality each 1-4, Questions, Limitations, Rating
    1-6, Confidence 1-5.

A fourth form, General (the default), is venue-neutral: the NeurIPS
structure with no venue named anywhere, its Rating on a generic 1-6
accept/reject scale. It works exactly like the venue forms; only the
prompt text differs.

Reviewer-process fields that only make sense for humans (LLM-usage
disclosure, code-of-conduct acknowledgement, post-rebuttal justification)
are deliberately absent: the models are the reviewers here, and those
fields would be noise in a blind comparison.

Parsing contract: every numeric section must start with a single number
on its own line (see _review_parse.parse_markdown_review). Section
headings differ per venue; the parser's alias map folds them onto the
canonical StructuredReview fields (quality→soundness, clarity→
presentation, significance→contribution, ...). All three venues score
their sub-dimensions on 1-4, so ScoreScale.ICLR normalization applies
uniformly.
"""
from __future__ import annotations

from textwrap import dedent
from typing import Dict

DEFAULT_CONFERENCE = "general"

CONFERENCE_SCALES: Dict[str, Dict] = {
    # Venue-neutral form (default). Its Rating section shows these labels
    # without naming a scale (see _overall_block).
    "general": {
        "name": "General",
        "scores": [1, 2, 3, 4, 5, 6],
        "labels": {
            6: "Strong Accept", 5: "Accept", 4: "Borderline Accept",
            3: "Borderline Reject", 2: "Reject", 1: "Strong Reject",
        },
    },
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
}


def _fmt_score(v: float) -> str:
    """1.0 → '1', 4.5 → '4.5' — keeps the prompt free of float noise."""
    return str(int(v)) if float(v).is_integer() else str(v)


def _overall_block(conference: str, heading: str) -> str:
    """The venue's overall-recommendation section, labels spelled out."""
    scale = CONFERENCE_SCALES.get(conference, CONFERENCE_SCALES[DEFAULT_CONFERENCE])
    allowed = ", ".join(_fmt_score(s) for s in scale["scores"])
    labels = "\n".join(
        f"   {_fmt_score(score)} = {label}"
        for score, label in sorted(scale["labels"].items(), reverse=True)
    )
    # The General form must not name any venue, its own included.
    on_scale = "" if conference == "general" else f" on the {scale['name']} scale"
    return (
        f"## {heading}\n"
        f"(Overall recommendation{on_scale}. Answer with a\n"
        f"SINGLE NUMBER on its own line from this exact set: {{{allowed}}},\n"
        f"then one brief sentence justifying it. Meaning of each score:\n"
        f"{labels})"
    )


# The 1-5 confidence wording all three venues share (OpenReview standard).
_CONFIDENCE_BLOCK = dedent("""\
    ## Confidence
    (Integer 1-5 on its own line, then one brief sentence.
       5 = You are absolutely certain about your assessment
       4 = You are confident, but not absolutely certain
       3 = You are fairly confident
       2 = You are willing to defend your assessment, but it is quite likely
           you did not understand central parts of the submission
       1 = Your assessment is an educated guess)""")
# Preamble for the venue forms. This is the thesis user-study prompt
# (Sept 2026), kept verbatim so the study stays reproducible.
_VENUE_PREAMBLE = dedent("""\
    You are an experienced peer reviewer for {venue}. Read the paper below
    and write a full review using the official {venue} review form,
    reproduced for you here. Use markdown headers EXACTLY as shown, in the
    EXACT order shown. For each numeric section, begin with a SINGLE
    NUMBER on its own line, then one brief sentence explaining the score.
    Plain markdown only — no preamble before the first header, no JSON,
    no closing commentary.""")

# The same preamble for the General form, with every venue mention removed.
_GENERAL_PREAMBLE = dedent("""\
    You are an experienced peer reviewer. Read the paper below
    and write a full review using the review form,
    reproduced for you here. Use markdown headers EXACTLY as shown, in the
    EXACT order shown. For each numeric section, begin with a SINGLE
    NUMBER on its own line, then one brief sentence explaining the score.
    Plain markdown only — no preamble before the first header, no JSON,
    no closing commentary.""")



def _dim(name: str, guidance: str) -> str:
    """A 1-4 numeric sub-score section (1=poor, 2=fair, 3=good, 4=excellent)."""
    return (
        f"## {name}\n"
        f"(Integer 1-4 — 1=poor, 2=fair, 3=good, 4=excellent. {guidance})"
    )


def _iclr_form() -> str:
    return "\n\n".join([
        _VENUE_PREAMBLE.format(venue="ICLR 2026"),
        "## Summary\n"
        "(Briefly summarize the paper and its contributions in your own\n"
        "words — a summary the authors would generally agree with. 2-4\n"
        "sentences.)",
        _dim("Soundness", "Technical soundness: methodology, support for claims,\nlogical consistency."),
        _dim("Presentation", "Clarity, structure, and writing quality."),
        _dim("Contribution", "Novelty and significance of the contribution."),
        "## Strengths\n(The strong points of the paper. Concise bullet list, 3-5 items.)",
        "## Weaknesses\n(The weak points of the paper. Concise bullet list, 3-6 items.)",
        "## Questions\n"
        "(Questions for the authors — points where a response could change\n"
        "your opinion. Concise bullet list, 2-5 items.)",
        "## Flag For Ethics Review\n"
        "(One line: either 'No ethics review needed.' or name the concern.)",
        _overall_block("iclr", "Rating"),
        _CONFIDENCE_BLOCK,
    ])


def _icml_form() -> str:
    return "\n\n".join([
        _VENUE_PREAMBLE.format(venue="ICML 2026"),
        "## Summary\n"
        "(Briefly summarize the paper and its contributions in your own\n"
        "words after reading — not a paste of the abstract. 2-4 sentences.)",
        "## Strengths And Weaknesses\n"
        "(A thorough assessment touching on soundness, presentation,\n"
        "significance, and originality — use the two subsections below.)\n\n"
        "### Strengths\n(Concise bullet list, 3-5 items.)\n\n"
        "### Weaknesses\n(Concise bullet list, 3-6 items.)",
        _dim("Soundness", "Technical correctness; are the central claims adequately\nsupported with evidence?"),
        _dim("Presentation", "Writing style and clarity, plus contextualization\nrelative to prior work."),
        _dim("Significance", "Importance of the problem and value to the field or\nto practice."),
        _dim("Originality", "Novel insights, methods, or creative combinations of\nexisting techniques."),
        "## Key Questions For Authors\n"
        "(3-5 substantive, actionable questions, as a numbered list.)",
        "## Limitations\n"
        "(Have the authors adequately discussed the limitations and, where\napplicable, the societal impact of their work? 1-3 sentences.)",
        _overall_block("icml", "Overall Recommendation"),
        _CONFIDENCE_BLOCK,
    ])


def _neurips_form() -> str:
    return "\n\n".join([
        _VENUE_PREAMBLE.format(venue="NeurIPS 2026"),
        "## Summary\n"
        "(Briefly summarize the paper and its contributions in your own\n"
        "understanding after reading — not a paste of the abstract; the\n"
        "authors should generally agree with it. 2-4 sentences.)",
        "## Strengths And Weaknesses\n"
        "(Your assessment across the four core NeurIPS dimensions — quality,\n"
        "clarity, significance, originality — using the two subsections\n"
        "below.)\n\n"
        "### Strengths\n(Concise bullet list, 3-5 items.)\n\n"
        "### Weaknesses\n(Concise bullet list, 3-6 items.)",
        _dim("Quality", "Is the submission technically sound? Are claims well\nsupported by theoretical analysis or experimental results?"),
        _dim("Clarity", "Is the submission clearly written, well organized, and\ndoes it adequately inform the reader?"),
        _dim("Significance", "Potential for impact on an important use case and for\nthe broader NeurIPS community."),
        _dim("Originality", "Novel tasks, framings, metrics, or methods — or a\nwell-motivated novel combination of existing techniques."),
        "## Questions\n"
        "(3-5 actionable questions and suggestions for the authors — points\n"
        "where a response could change your opinion.)",
        "## Limitations\n"
        "(Have the authors adequately addressed the limitations and potential\n"
        "negative societal impact of their work? 1-3 sentences.)",
        _overall_block("neurips", "Rating"),
        _CONFIDENCE_BLOCK,
    ])




def _general_form() -> str:
    """Venue-neutral form: the NeurIPS structure with no venue named."""
    return "\n\n".join([
        _GENERAL_PREAMBLE,
        "## Summary\n"
        "(Briefly summarize the paper and its contributions in your own\n"
        "understanding after reading — not a paste of the abstract; the\n"
        "authors should generally agree with it. 2-4 sentences.)",
        "## Strengths And Weaknesses\n"
        "(Your assessment across four core dimensions — quality, clarity,\n"
        "significance, originality — using the two subsections below.)\n\n"
        "### Strengths\n(Concise bullet list, 3-5 items.)\n\n"
        "### Weaknesses\n(Concise bullet list, 3-6 items.)",
        _dim("Quality", "Is the submission technically sound? Are claims well\nsupported by theoretical analysis or experimental results?"),
        _dim("Clarity", "Is the submission clearly written, well organized, and\ndoes it adequately inform the reader?"),
        _dim("Significance", "Potential for impact on an important use case and for\nthe broader research community."),
        _dim("Originality", "Novel tasks, framings, metrics, or methods — or a\nwell-motivated novel combination of existing techniques."),
        "## Questions\n"
        "(3-5 actionable questions and suggestions for the authors — points\n"
        "where a response could change your opinion.)",
        "## Limitations\n"
        "(Have the authors adequately addressed the limitations and potential\n"
        "negative societal impact of their work? 1-3 sentences.)",
        _overall_block("general", "Rating"),
        _CONFIDENCE_BLOCK,
    ])


_FORM_BUILDERS = {
    "general": _general_form,
    "iclr": _iclr_form,
    "icml": _icml_form,
    "neurips": _neurips_form,
}



def build_system_prompt(conference: str = DEFAULT_CONFERENCE) -> str:
    """Full review-form system prompt for the adapters: the venue's form,
    or the venue-neutral General form. Unknown venues fall back to General."""
    builder = _FORM_BUILDERS.get(conference, _FORM_BUILDERS[DEFAULT_CONFERENCE])
    return builder().strip()
