# ReviewArena

A web platform for benchmarking automated peer review systems through human
pairwise comparison and Elo ranking.

**Bachelor thesis project — Ubiquitous Knowledge Processing Lab (UKP),
TU Darmstadt.**

---

## What it does

1. You upload a research paper (PDF or arXiv URL).
2. ReviewArena parses it via **Datalab's hosted Chandra API** (PDF →
   markdown; arXiv URLs go through our self-hosted `arxiv2md` service)
   and picks two automated reviewers from the enabled pool
   using LMArena's weighted, Elo-aware pair-selection algorithm.
3. The two reviews stream live into side-by-side panels (server-sent
   events, token-by-token).
4. You vote which review is more useful, or call it a tie. Optionally,
   refine across eight dimensions: Comprehensiveness, Clarity, Fairness,
   Actionability, Constructiveness, Objectivity, Relevance,
   Technical Terms.
5. Votes update an overall and per-dimension Elo ranking with
   bootstrapped 95% CIs (verbatim FastChat port).
6. The reveal screen shows which system produced A and B, the Elo
   before/after, and a radar of LLM-judge dimension scores.

## Live review systems

The thesis benchmarks **frontier commercial LLMs only** — every system is
reached over its provider's API, so there is no GPU hosting anywhere in
the stack.

Ten systems: five providers x two tiers, so the leaderboard can separate
"which lab" from "how much compute".

| Slug                 | Backing model id          | Hosting                      | Streams?  |
|----------------------|---------------------------|------------------------------|-----------|
| `gpt-5.2`            | `gpt-5.2`                 | OpenAI API                   | yes (SDK) |
| `gpt-5.4-mini`       | `gpt-5.4-mini`            | OpenAI API                   | yes (SDK) |
| `claude-opus-5`      | `claude-opus-5`           | Anthropic API (native SDK)   | yes (SDK) |
| `claude-sonnet-5`    | `claude-sonnet-5`         | Anthropic API (native SDK)   | yes (SDK) |
| `gemini-3.1-pro`     | `gemini-3.1-pro-preview`  | Google AI Studio API         | yes (SDK) |
| `gemini-3.6-flash`   | `gemini-3.6-flash`        | Google AI Studio API         | yes (SDK) |
| `deepseek-v4-pro`    | `deepseek-v4-pro`         | DeepSeek API (OpenAI-compat) | yes (SDK) |
| `deepseek-v4-flash`  | `deepseek-v4-flash`       | DeepSeek API (OpenAI-compat) | yes (SDK) |
| `mistral-large-3`    | `mistral-large-2512`      | Mistral API (OpenAI-compat)  | yes (SDK) |
| `mistral-medium-3.5` | `mistral-medium-2604`     | Mistral API (OpenAI-compat)  | yes (SDK) |

Two slugs differ from their backing id on purpose: Google ships no
non-preview 3.1 Pro, and Mistral has no literal `mistral-large-3` — we
pin the dated snapshot so a silent provider upgrade can't invalidate the
comparison mid-study. All ten ids were verified callable on 2026-07-26.

Each system is enabled in the DB only if its provider key is present, so
a missing key means that system is skipped by pair selection rather than
failing mid-battle. Retired systems (earlier baselines and the
out-of-scope open-weight specialists) stay in the DB with `enabled=false`
so their historical reviews, votes and Elo snapshots remain queryable.

## Architecture

```
 ┌──────────────┐       ┌──────────────┐       ┌──────────────────────┐
 │  React/Vite  │──HTTP─│   Express    │──HTTP─│      FastAPI         │
 │  (apps/web)  │       │  (apps/api)  │       │ (services/review-gen)│
 └──────────────┘       └──────┬───────┘       └──────────┬───────────┘
                               │                          │
                        ┌──────▼───────┐         ┌────────▼──────────┐
                        │   Postgres   │         │  Adapters         │
                        │  (Drizzle)   │         │  (gpt5 / gpt5mini │
                        └──────────────┘         │   gemini3pro /    │
                                                 │   gemini25flash / │
                                                 │   claude /        │
                                                 │   deepseek)       │
                                                 └────────┬──────────┘
                                                          │
                            ┌───────────────┬─────────────┼──────────────┬───────────────┐
                            │               │             │              │               │
                    ┌───────▼──────┐ ┌──────▼─────┐ ┌─────▼──────┐ ┌─────▼──────┐ ┌──────▼───────┐
                    │  OpenAI API  │ │ Google AI  │ │ Anthropic  │ │  DeepSeek  │ │ Mistral API  │
                    │              │ │  Studio    │ │    API     │ │    API     │ │              │
                    │  gpt-5.2     │ │ gemini 3.1 │ │  opus-5    │ │ v4-pro     │ │ large-3      │
                    │  gpt-5.4-mini│ │ /3.6-flash │ │  sonnet-5  │ │ v4-flash   │ │ medium-3.5   │
                    └──────────────┘ └────────────┘ └────────────┘ └────────────┘ └──────────────┘
                                            (+ Datalab Chandra API for PDF → markdown)
```

Everything heavy is a **third-party API call** — no GPUs, no model
weights, no inference containers to operate. Local dev only needs
Postgres (in Docker, or a Neon URL) plus the provider API keys.

## Monorepo layout

```
reviewarena/
├── apps/
│   ├── web/                       # Vite + React + TS + Tailwind + shadcn/ui
│   │   └── src/{pages,components,lib}
│   └── api/                       # Express + TS + Drizzle (Postgres)
│       ├── drizzle.config.ts
│       ├── drizzle/               # SQL migrations
│       ├── scripts/               # CLI utilities: seed.ts, drop-all.ts, inspect.ts, …
│       └── src/
│           ├── db/                # schema.ts, client.ts
│           ├── clients/           # review-gen-client.ts, judge-client.ts
│           ├── pipeline/          # orchestrator.ts, score-paper.ts
│           ├── elo/               # FastChat-port Elo + bootstrap CI (+ tests)
│           ├── pair/              # LMArena pair selector (+ tests)
│           ├── routes/            # papers, pair, votes, leaderboard, reveal, admin
│           ├── plugins/           # session cookie, admin bearer auth
│           └── server.ts
├── services/
│   ├── review-gen/                # FastAPI; /parse, /generate, /stream-generate, /judge
│   │   └── app/adapters/{gpt5,gpt5mini,gemini3pro,gemini25flash,claude,deepseek}.py
│   └── cloudrun/arxiv2md/         # self-hosted arXiv → markdown, on Google Cloud Run
# PDF parsing: review-gen/app/parsing/chandra.py → Datalab's hosted Chandra API
├── packages/
│   └── shared-types/              # Zod schemas + TS types
├── scripts/
│   └── thesis_eval.py             # consumes /admin/export.json → CSVs + plots
├── docs/
│   ├── architecture.md
│   ├── walkthrough.md
│   └── SECRETS.md                 # rotation playbook
├── docker-compose.yml             # Postgres only
├── mprocs.yaml                    # local dev runner
├── pnpm-workspace.yaml
└── package.json
```

## Tech stack — key choices

| Layer            | Choice                                     | Why                                                                                                                       |
|------------------|--------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|
| Frontend         | React + Vite + TS, Tailwind, shadcn/ui     | As specified.                                                                                                             |
| Data fetching    | TanStack Query                             | As specified. No Redux.                                                                                                   |
| Backend          | **Express 4** (originally Fastify)         | Fastify silently swallowed Set-Cookie headers from `onRequest` hooks; Express + cookie-parser + multer + Zod was simpler. |
| ORM              | **Drizzle** (originally Prisma)            | TS inference from the schema file, no codegen step.                                                                       |
| Streaming        | Server-Sent Events (browser → API → Python → provider SDK) | One streaming path for every provider; the voter sees tokens instead of a spinner on multi-minute reasoning runs.          |
| Review-gen       | Python FastAPI microservice                | Adapter SDKs (OpenAI, Gemini, Anthropic, DeepSeek) + Pydantic schemas all Python-native.                                  |
| PDF parsing      | **Datalab Chandra API** (was GROBID)       | Chandra preserves LaTeX equations + reconstructs markdown tables; GROBID's TEI XML lost both. Hosted, so nothing to run.  |
| Review systems   | **Frontier commercial APIs only**          | Open-weight specialists needed self-hosted GPUs — out of scope. Every system is now one HTTP call to its provider.        |
| Tests            | Vitest                                     | Same runner both sides. Elo math + pair selection have the deepest coverage.                                              |
| Package manager  | pnpm workspaces                            | Strict by default; surfaces missing deps early.                                                                           |

## Quickstart

```bash
# 1. JS deps + Python deps
pnpm install
python3 -m venv services/review-gen/.venv
services/review-gen/.venv/bin/pip install -r services/review-gen/requirements.txt

# 2. Environment + database
cp .env.example .env
# then paste DATABASE_URL, ADMIN_TOKEN, PAIR_TOKEN_SECRET, WEB_ORIGIN,
# REVIEW_GEN_API_KEY. Generate the local secrets with `openssl rand -hex 32`.
# See docs/SECRETS.md for the rotation playbook.

pnpm --filter @reviewarena/api db:push     # apply Drizzle schema
pnpm --filter @reviewarena/api db:seed     # insert review systems

# 3. Provider keys — nothing to deploy, all ten systems are hosted APIs
#   OPENAI_API_KEY    → gpt-5.2, gpt-5.4-mini
#   ANTHROPIC_API_KEY → claude-opus-5, claude-sonnet-5
#   GEMINI_API_KEY    → gemini-3.1-pro, gemini-3.6-flash (+ the LLM judge)
#   DEEPSEEK_API_KEY  → deepseek-v4-pro, deepseek-v4-flash
#   MISTRAL_API_KEY   → mistral-large-3, mistral-medium-3.5
#   CHANDRA_API_KEY   → PDF parsing, from https://www.datalab.to

# 4. Local Postgres (skip if using Neon or other managed)
docker compose up -d

# 5. Run everything
pnpm dev                           # starts review-gen :8001 + api :8000 + web :5173
```

Then open <http://localhost:5173>.

`db:seed` only enables a system when its provider key is present, so a
partially-filled `.env` gives you a smaller lineup rather than failed
reviews. The LLM-as-judge needs `GEMINI_API_KEY` and has no mock
fallback.

### Environment variables

See [.env.example](.env.example). Required at minimum:

- `DATABASE_URL` — Postgres connection (Neon or local)
- `ADMIN_TOKEN` — bearer for `/admin/*` (32+ char random)
- `PAIR_TOKEN_SECRET` — HMAC key for pair tokens (32+ char random, **separate** from ADMIN_TOKEN)
- `WEB_ORIGIN` — CORS whitelist, comma-separated
- `REVIEW_GEN_API_KEY` — shared key the Node API sends to the Python
  service as `X-API-Key`; required in production so no one else can
  spend your LLM budget via `/generate`

For the review systems you also need `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, and `CHANDRA_API_KEY` for PDF
parsing.

Rotation playbook: [docs/SECRETS.md](docs/SECRETS.md).

## Deployment

The deployed stack is Vercel (SPA) → Google Cloud Run (`api` +
`review-gen`, plus the `arxiv2md` parser) → Neon Postgres. Nothing needs
a GPU: PDF parsing and every review system are third-party APIs, so the
services we operate are all small, stateless, CPU-only containers.

```bash
pnpm install --frozen-lockfile
pnpm --filter @reviewarena/api build
pnpm --filter @reviewarena/web build

# Apply migrations + custom one-shots
pnpm --filter @reviewarena/api exec drizzle-kit migrate
pnpm --filter @reviewarena/api exec tsx scripts/add-votes-replay-uk.ts
pnpm --filter @reviewarena/api exec tsx scripts/add-paper-uploaded-by-session.ts

# Run with a process supervisor (systemd / pm2 / nixpacks) or Cloud Run:
#   api:  node dist/server.js                     (port 8000)
#   web:  any static host serving apps/web/dist/  (Vite SPA)
#   review-gen: uvicorn app.main:app --host 0.0.0.0 --port 8001 --workers 2
```

In production, `vercel.json` rewrites `/api/*` to the Cloud Run API and
serves the SPA for everything else; self-hosting, a reverse proxy
(Caddy / Nginx) does the same job. `.github/workflows/deploy-api.yml`,
`deploy-review-gen.yml` and `deploy-arxiv2md.yml` build and push the
three Cloud Run services on pushes to `main`.

### Before a study window

There is **no model warm-up step** — every review system is a hosted
provider API, so there are no weights to load and no multi-minute cold
start to pre-empt. Both Cloud Run services run at `--min-instances=0`;
their cold start is a container boot (seconds), well inside the request
timeouts (`api` 300 s, `review-gen` 600 s).

What is worth checking before a session:

- each provider key in `.env` is live and in budget;
- `pnpm --filter @reviewarena/api db:seed` has been re-run, so the
  systems you expect are `enabled` (a missing key silently disables its
  system);
- provider rate limits are high enough for the expected concurrency —
  `review-gen` runs `--max-instances=3 --concurrency=20`.

**Backup**: nightly `pg_dump`. PDFs are never persisted — only the
parsed structure (jsonb) and review outputs are stored.

## Algorithmic credits

Elo update and bootstrap CI are ported verbatim from
[LMSYS FastChat](https://github.com/lm-sys/FastChat) (Apache 2.0); see
the file-level comment in [apps/api/src/elo/elo.ts](apps/api/src/elo/elo.ts).
Constants are FastChat's defaults (K=4, BASE=10, SCALE=400, INIT=1000).
The LMArena `get_battle_pair` weighted sampler is similarly ported to
[apps/api/src/pair/select-pair.ts](apps/api/src/pair/select-pair.ts).

LMArena's *current* public leaderboard uses Bradley-Terry MLE with
style control; we deliberately use online Elo + bootstrap CI because
thesis-scale (~250 votes) is below the data threshold where BT-MLE
converges cleanly.

## Status

- [x] **Checkpoint 1** — Monorepo, manifests, docker-compose, README
- [x] **Checkpoint 2** — Schema (Paper, ReviewSystem, Review, Vote,
       DimensionVote, EloSnapshot, MetricScore)
- [x] **Checkpoint 3** — Express routes + Elo module + Vitest cases
- [x] **Checkpoint 4** — Four frontend screens (Leaderboard, Upload,
       Comparison, Reveal)
- [x] **Checkpoint 5** — FastAPI review-gen + the live frontier adapters
- [x] **Checkpoint 6** — Upload → parse → pair-select → generate →
       vote → Elo → snapshot → reveal, with SSE streaming end-to-end
- [x] **Checkpoint 7** — LLM-as-judge scoring (sole automatic metric;
       BLEU/ROUGE later removed), BERTopic / word-frequency analytics
- [x] **Checkpoint 8** — Admin CRUD + CSV/JSON export, Cloud Run / Vercel
       deploys, [thesis evaluation script](scripts/thesis_eval.py)

## Testing

```bash
pnpm --filter @reviewarena/api test         # Elo math, pair selection, HMAC
pnpm --filter @reviewarena/api typecheck
pnpm --filter @reviewarena/web typecheck
```

## Decisions log

- **8 dimensions, not 5.** Spec listed 5; thesis mockup canonical at 8.
- **Prisma → Drizzle.** TS inference from schema beats codegen.
- **Express, not Fastify.** Set-Cookie dropped from `onRequest` hooks.
- **Chandra (Datalab), not GROBID.** Chandra preserves equations +
  tables; GROBID's TEI XML lost both, on top of being a 6 GB Docker
  image. Hosted, so there is nothing to operate.
- **LMArena pair selection** (was random) — Elo-aware weighted sample.
- **Pre-select 2, then generate** (was fan-out to all enabled systems)
  saves ~50% of API spend per paper.
- **SSE end-to-end streaming** — keeps the connection alive across
  multi-minute reasoning runs instead of one long blocking request.
- **Frontier commercial systems only.** The open-weight specialists
  (DeepReviewer, OpenReviewer, CycleReviewer, SEA) needed self-hosted
  GPUs; their adapters and serving code were removed and their DB rows
  disabled rather than deleted, so past votes stay analysable.
- **Anonymous httpOnly session cookie.** No IP, fingerprint, or email.
- **`PAIR_TOKEN_SECRET` separate from `ADMIN_TOKEN`.** Leaking admin
  must not let an attacker forge pair tokens.
- **K = 4 (FastChat default).** Full-history replay; smaller K stops
  the most recent vote from dominating the rating.

## Thesis analysis workflow

```bash
export ADMIN_TOKEN=…
python scripts/thesis_eval.py --token "$ADMIN_TOKEN"
```

Output (in `research/analysis/`):
- `export.json` — raw dump
- `votes_long.csv` — one row per vote, dimension columns flattened
- `head_to_head.csv` — pairwise win/loss/tie counts
- `elo_trajectory.png` — per-system Elo over time, 95% CI shaded
- `human_vs_judge.csv` — winrate vs LLM-judge mean per system
