"""Every prompt the service sends to a model, one Markdown file each.

    prompts/
    ├── review/<form>.md   system prompt for review generation, one per
    │                      review form (general, iclr, icml, neurips)
    └── judge/
        ├── system.md      pairwise judge: rubric + JSON output contract
        └── user.md        pairwise judge: paper + the two reviews

The venue forms mirror each venue's real 2026 reviewer form (section names,
order and scales, checked against the venue pages in September 2026);
general.md is the NeurIPS structure with no venue named. Fields only a
human reviewer needs (LLM-usage disclosure, code of conduct) are left out.

A file's text is exactly what the model receives, minus the file's final
newline. Edit the file to change a prompt; nothing in Python needs to change.

Placeholders use `$name` (string.Template), so the literal braces in the
judge's JSON shape need no escaping. render() raises KeyError on a missing
variable rather than sending a half-filled prompt. Write a literal dollar
sign as `$$`.

Adding a review form: drop review/<key>.md here, then add <key> to
CONFERENCES and CONFERENCE_NAMES in packages/shared-types/src/api.ts so the
upload page offers it. If its section headings are new, add aliases in
adapters/_review_parse.py so the scores still parse: every numeric section
must start with a single number on its own line.

Do not edit the review or judge prompts while a study is collecting data.
Responses to different prompts are not comparable.
"""
from __future__ import annotations

from functools import cache
from pathlib import Path
from string import Template

_DIR = Path(__file__).parent

DEFAULT_CONFERENCE = "general"


@cache
def load(name: str) -> str:
    """The prompt at prompts/<name>.md, e.g. load("judge/system")."""
    text = (_DIR / f"{name}.md").read_text(encoding="utf-8")
    return text[:-1] if text.endswith("\n") else text


def render(name: str, **values: str) -> str:
    """load(name) with its $placeholders filled in."""
    return Template(load(name)).substitute(values)


def review_forms() -> list[str]:
    """Keys of the available review forms (the review/*.md file names)."""
    return sorted(p.stem for p in (_DIR / "review").glob("*.md"))


def build_system_prompt(conference: str = DEFAULT_CONFERENCE) -> str:
    """Review-generation system prompt for a venue's form. Unknown venues
    fall back to the venue-neutral General form."""
    if conference not in review_forms():
        conference = DEFAULT_CONFERENCE
    return load(f"review/{conference}")
