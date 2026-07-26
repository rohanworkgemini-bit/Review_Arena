# `review-gen` — FastAPI service

Python service that hosts the **review adapters**, the **PDF/arXiv
parsers**, and the **LLM-as-judge**. The Node API calls it over HTTP.

## Layout

```
app/
├── main.py              FastAPI app + endpoints
├── schemas.py           Pydantic mirrors of packages/shared-types
├── paper_render.py      Canonical paper→prompt rendering (FAIRNESS A1)
├── judge.py             LLM-as-judge: claim extraction + verification
├── analytics.py         Topic model + word freq (admin endpoints)
├── parsing/
│   ├── arxiv2md.py     arXiv URL/ID → ParsedPaper (timf34's hosted service)
│   └── chandra.py      PDF → ParsedPaper (Datalab hosted /convert API)
└── adapters/
    ├── base.py          Adapter abstract class + StreamEvent
    ├── _budget.py       Shared input budgeting (FAIRNESS A4)
    ├── _review_parse.py Shared markdown/JSON → StructuredReview
    ├── gpt.py           OpenAI base adapter (shared by the GPT systems)
    ├── gemini.py        Google base adapter (shared by the Gemini systems)
    ├── gpt5.py          OpenAI GPT-5 zero-shot
    ├── gpt5mini.py      OpenAI GPT-5-mini zero-shot
    ├── gemini3pro.py    Google Gemini 3 Pro zero-shot
    ├── gemini25flash.py Google Gemini 2.5 Flash zero-shot
    ├── claude.py        Anthropic Claude Opus 4.8 (native SDK)
    └── deepseek.py      DeepSeek V3.2 (OpenAI-compatible endpoint)
```

All review systems are frontier commercial APIs. The open-weight
specialist reviewers and their Modal/vLLM GPU serving were removed when
the study was scoped to frontier models only.

## Endpoints

- `POST /parse` — PDF → ParsedPaper via Datalab Chandra
- `POST /parse-arxiv` — arxiv2md pipeline (URL/ID → ParsedPaper)
- `POST /generate` — non-streaming review (used by admin/re-score)
- `POST /stream-generate` — **SSE**: yields token / done / error events
- `POST /judge` — LLM-judge scoring (overall + per-dimension)
- `POST /analytics/{topics,wordfreq}` — corpus-level analytics
- `GET /healthz` — readiness probe

## Adapter integration recipe

To add a new review system, create `adapters/<slug>.py` by copying the
closest existing adapter — `deepseek.py` for any provider with an
OpenAI-compatible `/chat/completions` endpoint (it is the openai SDK
pointed at a different `base_url`), `claude.py` or `gemini.py` for a
native SDK — register it in `adapters/__init__.py`, and add a row to
`review_systems` via `apps/api/scripts/seed.ts`.

## Dev

```bash
uvicorn app.main:app --reload --port 8001 --app-dir services/review-gen --reload-dir services/review-gen/app
```

Or just `mprocs` from the repo root — the `review-gen` proc handles this.
