#!/usr/bin/env python3
"""Regenerate bt-fastchat.json — the golden fixture bt-parity.test.ts checks
our TypeScript Bradley-Terry port against.

It runs LMSYS FastChat's own compute_bt (scipy L-BFGS-B on the weighted
logistic NLL) over a synthetic battle log and records both the input and the
output. Nothing in the app imports this; it is a hand-run script, and its deps
(numpy / scipy / pandas) are deliberately NOT added to any requirements file.

    python3 -m venv /tmp/btvenv
    /tmp/btvenv/bin/pip install numpy scipy pandas tqdm
    /tmp/btvenv/bin/python apps/api/src/rating/__tests__/fixtures/gen-bt-fixture.py

The battle log is seeded, so re-running reproduces the same fixture byte for
byte unless FastChat's estimator itself changes.
"""
import importlib.util
import json
import random
import subprocess
import tempfile
import urllib.request
from datetime import date
from pathlib import Path

FASTCHAT_URL = (
    "https://raw.githubusercontent.com/lm-sys/FastChat/main/"
    "fastchat/serve/monitor/rating_systems.py"
)

def load_fastchat():
    """Import FastChat's rating_systems.py straight from upstream, so the
    fixture can never drift from a hand-copied version of their maths."""
    tmp = Path(tempfile.gettempdir()) / "fastchat_rating_systems.py"
    if not tmp.exists():
        try:
            urllib.request.urlretrieve(FASTCHAT_URL, tmp)
        except Exception:
            # python.org builds on macOS ship without a usable CA bundle;
            # curl has one.
            subprocess.run(["curl", "-fsSL", FASTCHAT_URL, "-o", str(tmp)], check=True)
    spec = importlib.util.spec_from_file_location("fastchat_rating_systems", tmp)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

MODELS = ["gpt-5.2", "claude-opus-4-8", "gemini-3.1-pro", "deepseek-v4-pro",
          "mistral-large-3", "gpt-5.4-mini", "claude-sonnet-5"]
# Latent strengths, so the sample has a real ordering for BT to recover.
STRENGTH = dict(zip(MODELS, [0.9, 0.75, 0.6, 0.45, 0.3, 0.5, 0.65]))

def main():
    import pandas as pd

    rs = load_fastchat()
    rng = random.Random(20260820)
    rows = []
    for _ in range(1200):
        a, b = rng.sample(MODELS, 2)
        pa = STRENGTH[a] / (STRENGTH[a] + STRENGTH[b])
        u = rng.random()
        # ~12% ties, the rest split by the latent strengths.
        winner = "tie" if u < 0.12 else ("model_a" if rng.random() < pa else "model_b")
        rows.append({"model_a": a, "model_b": b, "winner": winner})

    ratings = rs.compute_bt(pd.DataFrame(rows))  # base=10, scale=400, init=1000

    fixture = {
        "_comment": (
            "Golden fixture: a seeded battle log plus the ratings FastChat's "
            "compute_bt produces for it. FastChat's default baseline "
            "(mixtral-8x7b-instruct-v0.1) is absent from this field, so it applies "
            "no baseline shift and the ratings come out mean-centred on 1000 — "
            "which is exactly what computeBT's mean-centring fallback must "
            "reproduce. Regenerate with gen-bt-fixture.py."
        ),
        "_source": FASTCHAT_URL,
        "_retrieved": date.today().isoformat(),
        "battles": [
            {"a": r["model_a"], "b": r["model_b"],
             "outcome": 1 if r["winner"] == "model_a" else (0 if r["winner"] == "model_b" else 0.5)}
            for r in rows
        ],
        "fastchat_bt": {m: float(v) for m, v in ratings.items()},
    }

    out = Path(__file__).with_name("bt-fastchat.json")
    out.write_text(json.dumps(fixture, indent=1) + "\n")
    print(f"wrote {out} ({len(rows)} battles, {len(ratings)} systems)")
    for m, v in ratings.items():
        print(f"  {m:20s} {v:9.4f}")

if __name__ == "__main__":
    main()
