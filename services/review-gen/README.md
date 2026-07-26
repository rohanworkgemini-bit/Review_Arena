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
    ├── gpt.py              OpenAI base (chat/completions + responses)
    ├── claude.py           Anthropic base (native SDK)
    ├── gemini.py           Google base
    ├── deepseek.py         DeepSeek base (OpenAI-compatible)
    ├── mistral.py          Mistral base (OpenAI-compatible)
    ├── gpt52.py            GPT-5.2
    ├── gpt55.py            GPT-5.5 (registered, disabled in seed)
    ├── gpt54mini.py        GPT-5.4-mini
    ├── claudeopus48.py     Claude Opus 4.8
    ├── claudeopus5.py      Claude Opus 5 (registered, disabled in seed)
    ├── claudesonnet5.py    Claude Sonnet 5
    ├── gemini31pro.py      Gemini 3.1 Pro
    ├── gemini36flash.py    Gemini 3.6 Flash
    ├── deepseekv4pro.py    DeepSeek V4 Pro
    ├── deepseekv4flash.py  DeepSeek V4 Flash
    ├── mistrallarge3.py    Mistral Large 3
    └── mistralmedium35.py  Mistral Medium 3.5
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
