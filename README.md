# ReviewArena
| [Live site](https://reviewarena.ukp.informatik.tu-darmstadt.de) | [UKP Lab](https://www.informatik.tu-darmstadt.de/ukp/) |

ReviewArena is an open platform for benchmarking automated peer review systems through human pairwise comparison and Bradley-Terry ranking.

Chatbot Arena does this for chatbots; ReviewArena does it for paper reviews. Anyone can upload a paper, read two anonymous AI reviews of it side by side, and vote for the better one. The votes build a public leaderboard of review systems. The rating and pairing code is ported from [FastChat](https://github.com/lm-sys/FastChat), the system behind Chatbot Arena.

ReviewArena's core features include:
- A side-by-side review arena: upload a PDF or arXiv link, watch two anonymous reviews stream in live from two LLMs, and vote for the more useful one.
- A public leaderboard with an overall board and eight per-dimension Bradley-Terry boards, each with bootstrapped 95% confidence intervals.
- A pluggable set of review systems: each one is an adapter around a provider API, enabled by setting its key.
- An LLM judge panel that scores the same pairs, so automatic and human judgments can be compared.
- Venue-specific review forms (ICLR, ICML, NeurIPS 2026) plus a venue-neutral default.


## News
- [2026/10] 🔥 The venue-neutral **General** review form is now the default, alongside ICLR, ICML and NeurIPS 2026.
- [2026/10] The leaderboard now reports the full-data Bradley-Terry fit as the rating.
- [2026/09] The LLM judge panel now scores arena pairs, and admins choose which judges sit on it.

## Contents
- [Install](#install)
- [Review Systems](#review-systems)
- [Prompts](#prompts)
- [How It Works](#how-it-works)
- [Running Locally](#running-locally)
- [Looking at the Database](#looking-at-the-database)
- [Deployment](#deployment)
- [Rating Systems](#rating-systems)
- [Getting the Data Out](#getting-the-data-out)
- [Development](#development)
- [Controlled Study Mode](#controlled-study-mode)
- [Citation](#citation)

## Install

#### Prerequisites
- Node 24 and pnpm
- Python 3 (for the review-gen service)
- Docker (for the local Postgres)

#### From source
1. Clone this repository and go to the ReviewArena folder.
```bash
git clone <this repo> ReviewArena
cd ReviewArena
```

2. Install the JS and Python dependencies.
```bash
pnpm install
python3 -m venv services/review-gen/.venv
services/review-gen/.venv/bin/pip install -r services/review-gen/requirements.txt
```

## Review Systems

The current lineup is six **frontier commercial LLMs**, one mid-tier model per provider, so no vendor has two entries. Every system is reached through its provider's API, so nothing in the stack needs a GPU.

The same six models form the **LLM judge panel**, and admins choose which members sit on it. A judge may score a pair it wrote one side of; those verdicts are flagged, so they can be left out.

| Slug                 | Backing model id      | Provider API                 | Key                 |
|----------------------|-----------------------|------------------------------|---------------------|
| `claude-sonnet-5`    | `claude-sonnet-5`     | Anthropic (native SDK)       | `ANTHROPIC_API_KEY` |
| `deepseek-v4-flash`  | `deepseek-v4-flash`   | DeepSeek (OpenAI-compatible) | `DEEPSEEK_API_KEY`  |
| `gemini-3.8-flash`   | `gemini-3.8-flash`    | Google AI Studio             | `GEMINI_API_KEY`    |
| `glm-5.2`            | `glm-5.2`             | Z.ai (OpenAI-compatible)     | `ZAI_API_KEY`       |
| `gpt-5.6-terra`      | `gpt-5.6-terra`       | OpenAI                       | `OPENAI_API_KEY`    |
| `mistral-medium-3.5` | `mistral-medium-2604` | Mistral (OpenAI-compatible)  | `MISTRAL_API_KEY`   |

All six stream token by token. One slug differs from its backing id on purpose: `mistral-medium-3.5` is an alias, so we pin the dated snapshot. Otherwise a silent provider upgrade could change a system's reviews while its rating is still built on the old ones.

A system is enabled in the DB only if its provider key is present. A missing key means pair selection skips that system rather than failing mid-battle. Disabling a system (`enabled=false`) takes it out of the arena but keeps its past reviews, votes and ratings.

#### Adding a review system
Every adapter shares the same input budgeting ([_budget.py](services/review-gen/app/adapters/_budget.py)) and output parsing ([_review_parse.py](services/review-gen/app/adapters/_review_parse.py)), so a new system is mostly configuration:
1. Copy the closest adapter in [services/review-gen/app/adapters/](services/review-gen/app/adapters/). Use [glm.py](services/review-gen/app/adapters/glm.py) or [deepseekv4flash.py](services/review-gen/app/adapters/deepseekv4flash.py) for an OpenAI-compatible endpoint, and [claude.py](services/review-gen/app/adapters/claude.py) or [gemini.py](services/review-gen/app/adapters/gemini.py) for a native SDK.
2. Register it in the adapter registry ([adapters/\_\_init\_\_.py](services/review-gen/app/adapters/__init__.py)). To let it sit on the judge panel, also add its provider to `_PROVIDERS` in [judge.py](services/review-gen/app/judge.py).
3. Add its row to [seed.ts](apps/api/scripts/seed.ts) and re-run `db:seed`.

## Prompts

Every prompt sent to a model is a plain Markdown file in [services/review-gen/app/prompts/](services/review-gen/app/prompts/). A file's text is exactly what the model receives, so you can change a prompt without touching Python.
```
prompts/
├── review/
│   ├── general.md     # default: venue-neutral, rated on a 1–6 accept/reject scale
│   ├── iclr.md        # ICLR 2026 reviewer form
│   ├── icml.md        # ICML 2026 reviewer form
│   └── neurips.md     # NeurIPS 2026 reviewer form
└── judge/
    ├── system.md      # judge rubric + JSON output format
    └── user.md        # the paper and the two reviews: $paper, $review_1, $review_2
```

The uploader picks the review form, and both systems in a battle follow the same one. Each venue form mirrors that venue's real reviewer form.

> Don't edit the review or judge prompts while a study is collecting data: reviews and verdicts made under different prompts can't be compared.

#### Adding a review form
1. Create `prompts/review/<key>.md`, for example `acl.md`. Copying [general.md](services/review-gen/app/prompts/review/general.md) is the easiest start. Keep the `## Heading` sections, and start every numeric section (scores, rating, confidence) with **a single number on its own line**, or the scores won't parse.
2. Add `<key>` to `CONFERENCES` and its display name to `CONFERENCE_NAMES` in [packages/shared-types/src/api.ts](packages/shared-types/src/api.ts). This puts it in the upload dropdown.
3. Add its maximum overall rating to `OVERALL_MAX` in [ScoreLine.tsx](apps/web/src/components/comparison/ScoreLine.tsx). The typecheck fails until you do.
4. If the form uses new heading names (e.g. "Reasons to Accept"), map them in `_HEADER_MAP` in [_review_parse.py](services/review-gen/app/adapters/_review_parse.py). Unmapped sections are still shown to voters, but their scores aren't extracted.

No database migration is needed; the venue is stored as plain text.

#### Adding a new kind of prompt
Put the file under `prompts/`, using `$name` for anything filled in at runtime (`$$` for a literal dollar sign), and load it from Python:
```python
from app import prompts

system = prompts.load("summary/system")            # the text as-is
user = prompts.render("summary/user", paper=text)  # fills in $paper; raises if a value is missing
```

## How It Works

1. You upload a research paper (PDF or arXiv URL).
2. ReviewArena parses it. PDFs go to **Datalab's hosted Chandra API** (PDF → markdown); arXiv URLs go to our self-hosted `arxiv2md` service. It then picks two reviewers from the enabled pool.
3. The two reviews stream live into side-by-side panels over server-sent events, token by token.
4. You vote for the more useful review, or call it a tie. You can then rate the pair on eight dimensions: Core Contribution Accuracy, Results Interpretation, Comparative Analysis, Evidence-Based Critique, Critique Clarity, Completeness Coverage, Constructive Tone, and False or Contradictory Claims. If you rate them, all eight are mandatory. Every dimension is worded so that the side you pick is always the better one.
5. Votes update the overall and per-dimension Bradley-Terry leaderboards (see [Rating Systems](#rating-systems)).
6. The reveal screen shows which system wrote A and which wrote B, their ratings before and after the vote on the same 1000-point scale, and the LLM judges' scores.

#### Architecture
```
 ┌──────────────┐       ┌──────────────┐       ┌──────────────────────┐
 │  React/Vite  │──HTTP─│   Express    │──HTTP─│      FastAPI         │
 │  (apps/web)  │       │  (apps/api)  │       │ (services/review-gen)│
 └──────────────┘       └──────┬───────┘       └──────────┬───────────┘
                               │                          │
                        ┌──────▼───────┐       ┌──────────▼───────────┐
                        │   Postgres   │       │ Provider adapters    │
                        │  (Drizzle)   │       │ OpenAI · Google ·    │
                        └──────────────┘       │ Anthropic · Mistral ·│
                                               │ Z.ai · DeepSeek      │
                                               └──────────┬───────────┘
                                                          │
                        six hosted LLM APIs (also the judge panel)
                        + Datalab Chandra API for PDF → markdown
```

Everything heavy is a **third-party API call**: no GPUs, no model weights, no inference containers to run. Local development only needs Postgres (in Docker) and the provider API keys.

#### Monorepo layout
```
reviewarena/
├── apps/
│   ├── web/                       # Vite + React + TS + Tailwind + shadcn/ui
│   └── api/                       # Express + TS + Drizzle (Postgres)
│       ├── scripts/               # CLI utilities: seed, inspect, wipe-data, …
│       └── src/
│           ├── db/                # schema.ts, client.ts
│           ├── clients/           # review-gen and judge clients
│           ├── pipeline/          # orchestrator, paper scoring
│           ├── rating/            # FastChat-port Bradley-Terry + bootstrap CI (+ tests)
│           ├── pair/              # pair selection (+ tests)
│           ├── study/             # optional controlled-study mode
│           ├── routes/            # papers, pair, votes, leaderboard, reveal, study, admin
│           └── server.ts
├── services/
│   ├── review-gen/                # FastAPI: /parse, /parse-arxiv, /generate, /stream-generate, /judge-pair
│   │   └── app/prompts/           # every model prompt, as Markdown files
│   └── cloudrun/arxiv2md/         # self-hosted arXiv → markdown
├── packages/shared-types/         # Zod schemas + TS types
├── deploy/                        # Caddyfile, backup.sh, smoke test, one-off SQL
├── docker-compose.yml             # Postgres only
└── mprocs.yaml                    # local dev runner
```

#### Tech stack
| Layer          | Choice                                   | Why |
|----------------|------------------------------------------|-----|
| Frontend       | React + Vite + TS, Tailwind, shadcn/ui, TanStack Query | No Redux. |
| Backend        | **Express 4** (originally Fastify)       | Fastify silently dropped Set-Cookie headers set in `onRequest` hooks. |
| ORM            | **Drizzle** (originally Prisma)          | Types inferred from the schema file, no codegen step. |
| Streaming      | Server-sent events, browser → API → Python → provider SDK | One streaming path for every provider. The voter sees tokens instead of a spinner during multi-minute reasoning runs. |
| Review-gen     | Python FastAPI microservice              | The provider SDKs and Pydantic are Python-native. |
| PDF parsing    | **Datalab Chandra API** (was GROBID)     | Keeps LaTeX equations and rebuilds markdown tables. GROBID's TEI XML lost both. Hosted, so there is nothing to run. |
| Tests          | Vitest                                   | Rating math and pair selection have the deepest coverage. |

## Running Locally

#### 1. Start Postgres
```bash
docker compose up -d postgres
```

#### 2. Configure the environment and apply the schema
```bash
cp .env.example .env
pnpm --filter @reviewarena/api db:push     # apply the Drizzle schema
pnpm --filter @reviewarena/api db:seed     # insert the review systems
```
`DATABASE_URL` already points at the container. Generate the local secrets with `openssl rand -hex 32`.

Required variables (see [.env.example](.env.example)):
- `DATABASE_URL`: Postgres connection string (the local Docker instance)
- `ADMIN_TOKEN`: bearer token for `/admin/*` (32+ random chars)
- `PAIR_TOKEN_SECRET`: HMAC key for pair tokens (32+ random chars, **separate** from `ADMIN_TOKEN`)
- `WEB_ORIGIN`: CORS allowlist, comma-separated
- `REVIEW_GEN_API_KEY`: shared key the Node API sends to the Python service as `X-API-Key`. Required in production, so nobody else can spend your LLM budget through `/generate`.
- The six provider keys from the [Review Systems](#review-systems) table, plus `CHANDRA_API_KEY` for PDF parsing (from [datalab.to](https://www.datalab.to)). Each provider key enables one system **and** its seat on the judge panel.

Optional:
- `RATING_BASELINE_SLUG`: the system pinned at 1000 on the Bradley-Terry board (default `claude-sonnet-5`). Changing it renumbers every rating, so pick a high-volume system and leave it alone. Retiring that system is fine, since disabled systems keep their battle history.

`db:seed` only enables a system when its provider key is present. A partly filled `.env` gives you a smaller lineup and a smaller judge panel rather than failed reviews. The judge has no mock fallback: a pair whose judges all fail is marked `FAILED`. If only some fail, the pair is `PARTIAL`, and `tsx scripts/rescore-missing.ts` re-runs just the missing judges.

#### 3. Launch everything
```bash
pnpm dev     # postgres + review-gen :8001 + api :8000 + web :5173
```
This runs every process in its own [mprocs](mprocs.yaml) pane. Then open <http://localhost:5173>.

## Looking at the Database

The database is the `postgres` service in [docker-compose.yml](docker-compose.yml): one local instance, nothing managed. Read it with psql inside the container (no local psql needed):
```bash
docker exec -it reviewarena-postgres psql -U reviewarena -d reviewarena
```

Drizzle Studio (`db:studio`) does not work on Node 24 with the pinned `drizzle-kit@0.30.x`. It patches undici internals that no longer exist and fails with a misleading `ETIMEDOUT`.

Useful one-shots:
- `db:inspect`: the latest paper and its review statuses
- `db:wipe-data`: delete papers, reviews and votes, keep the review systems
- `db:retire-system <slug> --yes`: hard-delete one system and everything that references it, including its votes. To retire a system normally, set `enabled=false` instead.
- `db:nuke`: drop everything

## Deployment

**There is no deploy automation in this repo.** The only workflow is [ci.yml](.github/workflows/ci.yml), which type-checks and tests but never deploys. Pushing to `main` does not change any running environment or run migrations against a live database.

Nothing needs a GPU. PDF parsing and every review system are third-party APIs, so the three services are small, stateless, CPU-only processes.
```bash
pnpm install --frozen-lockfile
pnpm --filter @reviewarena/shared-types build
pnpm --filter @reviewarena/api build
pnpm --filter @reviewarena/web build

# Schema (drizzle-kit push diffs schema.ts against the target DB)
pnpm --filter @reviewarena/api db:push
pnpm --filter @reviewarena/api db:seed

# Run under a process supervisor (systemd / pm2) or in containers:
#   postgres:   docker compose up -d postgres
#   api:        node dist/server.js                     (port 8000)
#   review-gen: uvicorn app.main:app --host 0.0.0.0 --port 8001 --workers 2
#   web:        any static host serving apps/web/dist/  (Vite SPA)
```
`apps/api/Dockerfile` and `services/review-gen/Dockerfile` build plain containers with no platform-specific glue. A reverse proxy (see [Caddyfile](deploy/Caddyfile)) terminates TLS, serves the SPA, and routes `/api/*` to the API process.

#### Still tied to Google Cloud
arXiv parsing calls a self-hosted `arxiv2md` instance. Its default URL is hard-coded in [arxiv2md.py](services/review-gen/app/parsing/arxiv2md.py) and still points at Cloud Run. The source, with a Dockerfile, is in `services/cloudrun/arxiv2md/`. Run that container on the VM and set `ARXIV2MD_BASE` to its address, or arXiv uploads will break once the Cloud Run service is torn down. PDF uploads are unaffected.

#### Operating checklist
There is **no model warm-up step**: every review system is a hosted API. Keep the API's request timeout generous (300 s) and review-gen's more generous still (600 s), because a reasoning model streaming a long review can run for minutes. Before expecting traffic, check that:
- each provider key in `.env` is live and has budget left;
- `db:seed` has been re-run, so the systems you expect are `enabled` (a missing key silently disables its system);
- provider rate limits cover the expected concurrency. Size the review-gen worker count against the rate limits, not the CPU.

**Backup**: a nightly `pg_dump`. PDFs are never stored, only the parsed structure (jsonb) and the review outputs.

## Rating Systems

The rating is **Bradley-Terry**: a maximum-likelihood fit over the whole comparison log, independent of vote order, and what LMArena publishes. It is ported from [FastChat](https://github.com/lm-sys/FastChat) (Apache 2.0), `fastchat/serve/monitor/rating_systems.py`: `preprocess_for_bt` / `fit_bt` / `scale_and_offset` / `compute_bt` / `compute_bootstrap_bt`, in [apps/api/src/rating/bt.ts](apps/api/src/rating/bt.ts). Constants are FastChat's defaults (BASE=10, SCALE=400, INIT=1000). Style control is left out because it needs per-response length and markdown features we don't collect.

LMArena's weighted `get_battle_pair` sampler is *not* used. With a lineup this small there is nothing for it to skip, so [select-pair.ts](apps/api/src/pair/select-pair.ts) draws uniformly over eligible pairs and keeps only LMArena's eligibility rules.

The BT port has two documented deviations. Neither moves the estimate wherever FastChat's own estimate is well defined:
1. **An MM (Zermelo/Hunter/Newman) fixed point instead of scipy's L-BFGS-B**, since Node has no L-BFGS. It maximizes the same likelihood, so it reaches the same estimate. Tests are in [bt.test.ts](apps/api/src/rating/__tests__/bt.test.ts).
2. **A connectivity guard.** The BT estimate is finite only if the win graph is strongly connected (Ford 1957). An unbeaten or winless system diverges, and FastChat reports wherever `maxiter=100` stopped. We fit the largest strongly connected component and report the rest as unranked. This keeps BT usable while the vote count is still small, and on the eight sparse per-dimension boards, where such gaps are the norm.

BT ratings are only defined up to an additive constant, so `RATING_BASELINE_SLUG` is pinned at 1000. This keeps snapshots comparable as systems are added and retired; FastChat pins `mixtral-8x7b-instruct-v0.1` at 1114 for the same reason. Boards on which the baseline has not battled are mean-centred instead, recorded per snapshot row as `anchor`.

## Getting the Data Out

All collected data can be downloaded through the admin export:
```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://<host>/api/admin/export.json > export.json
```
The same route serves CSV. `votes` and `dimension_votes` are the primary record. Every rating in `ratings` is a pure function of them and can be refitted from the export alone.

## Development

#### Testing
```bash
pnpm --filter @reviewarena/api test         # rating math, pair selection, HMAC
pnpm --filter @reviewarena/api typecheck
pnpm --filter @reviewarena/web typecheck
```

#### Decisions log
- **8 rating dimensions, not 5**, so votes can separate factual accuracy from tone and coverage.
- **Prisma → Drizzle.** Types inferred from the schema beat codegen.
- **Express, not Fastify.** Fastify dropped Set-Cookie headers set in `onRequest` hooks.
- **Chandra (Datalab), not GROBID.** Chandra keeps equations and tables; GROBID's TEI XML lost both, and it was a 6 GB Docker image. Chandra is hosted, so there is nothing to run.
- **Pre-select 2, then generate** (it used to fan out to every enabled system). An arena paper now gets 2 reviews instead of one per enabled system, so its cost no longer grows with the pool.
- **Server-sent events end to end.** They keep the connection alive through multi-minute reasoning runs instead of one long blocking request.
- **Frontier commercial systems only.** The open-weight specialists (DeepReviewer, OpenReviewer, CycleReviewer, SEA) needed self-hosted GPUs. Their adapters and serving code were removed, so every system is now one HTTP call to its provider.
- **Anonymous httpOnly session cookie.** No IP, fingerprint or email.
- **`PAIR_TOKEN_SECRET` separate from `ADMIN_TOKEN`.** A leaked admin token must not let an attacker forge pair tokens.

## Controlled Study Mode

Besides the open arena, ReviewArena has an optional study mode for controlled experiments. In study mode, registered participants get fixed pairs in a balanced rotation, and every pair is judged by the full LLM panel. The code is in [apps/api/src/study/](apps/api/src/study/). The open arena doesn't need any of it.

## Citation

ReviewArena was built as a bachelor thesis project at the Ubiquitous Knowledge Processing Lab (UKP), TU Darmstadt. Please cite it if you find the repository helpful.
```bibtex
@thesis{gupta2026reviewarena,
      title={ReviewArena: Benchmarking Automated Peer Review Systems through Human Pairwise Comparison},
      author={Rohan Gupta},
      year={2026},
      type={Bachelor's thesis},
      school={Technische Universit{\"a}t Darmstadt, Ubiquitous Knowledge Processing Lab}
}
```
