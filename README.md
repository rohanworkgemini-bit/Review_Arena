# ReviewArena

A web platform for benchmarking automated peer review systems through human
pairwise comparison and Bradley-Terry ranking.

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
5. Votes update an overall and per-dimension ranking with bootstrapped
   95% CIs (verbatim FastChat port). Two rating systems are computed on
   every vote and stored side by side: **Bradley-Terry** (maximum
   likelihood over the whole comparison log — the default board, and what
   LMArena publishes) and **online Elo** (order-dependent, incremental).
   The leaderboard has a toggle; BT leads.
6. The reveal screen shows which system produced A and B, both ratings
   before/after on the same 1000-point scale, and a radar of LLM-judge
   dimension scores.

## Live review systems

The thesis benchmarks **frontier commercial LLMs only** — every system is
reached over its provider's API, so there is no GPU hosting anywhere in
the stack.

Six systems — the controlled study's lineup, one per provider, so no
vendor fields two entries and the LLM-as-judge (DeepSeek V4 Flash) shares
a vendor with none of them.

| Slug                 | Backing model id      | Hosting                       | Streams?  |
|----------------------|-----------------------|-------------------------------|-----------|
| `gemini-3.8-flash`   | `gemini-3.8-flash`    | Google AI Studio API          | yes (SDK) |
| `gpt-5.6-terra`      | `gpt-5.6-terra`       | OpenAI API                    | yes (SDK) |
| `claude-sonnet-5`    | `claude-sonnet-5`     | Anthropic API (native SDK)    | yes (SDK) |
| `mistral-medium-3.5` | `mistral-medium-2604` | Mistral API (OpenAI-compat)   | yes (SDK) |
| `glm-5.2`            | `glm-5.2`             | Z.ai API (OpenAI-compat)      | yes (SDK) |
| `kimi-k3`            | `kimi-k3`             | Moonshot API (OpenAI-compat)  | yes (SDK) |

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
              ┌───────▼──────┐ ┌──────▼─────┐ ┌─────▼──────┐ ┌─────▼──────┐ ┌────▼─────┐ ┌────▼─────┐
              │  OpenAI API  │ │ Google AI  │ │ Anthropic  │ │  Mistral   │ │  Z.ai    │ │ Moonshot │
              │              │ │  Studio    │ │    API     │ │    API     │ │  API     │ │   API    │
              │ gpt-5.6-terra│ │ gemini 3.8 │ │  sonnet-5  │ │ medium-3.5 │ │ glm-5.2  │ │ kimi-k3  │
              └──────────────┘ └────────────┘ └────────────┘ └────────────┘ └──────────┘ └──────────┘
                      (+ DeepSeek API: the V4 Flash LLM-as-judge — judge only, not a system)
                                            (+ Datalab Chandra API for PDF → markdown)
```

Everything heavy is a **third-party API call** — no GPUs, no model
weights, no inference containers to operate. Local dev only needs
Postgres (in Docker) plus the provider API keys.

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
│           ├── elo/               # FastChat-port Elo + Bradley-Terry + bootstrap CI (+ tests)
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
| Tests            | Vitest                                     | Same runner both sides. Rating math (Elo + BT, incl. parity against FastChat's own solver) and pair selection have the deepest coverage. |
| Package manager  | pnpm workspaces                            | Strict by default; surfaces missing deps early.                                                                           |

## Quickstart

```bash
# 1. JS deps + Python deps
pnpm install
python3 -m venv services/review-gen/.venv
services/review-gen/.venv/bin/pip install -r services/review-gen/requirements.txt

# 2. Local Postgres — the only supported database target
docker compose up -d postgres

# 3. Environment + schema
cp .env.example .env
# DATABASE_URL already points at the container started above. Fill in
# ADMIN_TOKEN, PAIR_TOKEN_SECRET, WEB_ORIGIN, REVIEW_GEN_API_KEY —
# generate the local secrets with `openssl rand -hex 32`.

pnpm --filter @reviewarena/api db:push     # apply Drizzle schema
pnpm --filter @reviewarena/api db:seed     # insert review systems

# 4. Provider keys — nothing to deploy, all six systems are hosted APIs
#   GEMINI_API_KEY    → gemini-3.8-flash
#   OPENAI_API_KEY    → gpt-5.6-terra
#   ANTHROPIC_API_KEY → claude-sonnet-5
#   MISTRAL_API_KEY   → mistral-medium-3.5
#   ZAI_API_KEY       → glm-5.2
#   MOONSHOT_API_KEY  → kimi-k3
#   DEEPSEEK_API_KEY  → the LLM-as-judge (DeepSeek V4 Flash), judge only
#   CHANDRA_API_KEY   → PDF parsing, from https://www.datalab.to

# 5. Run everything
pnpm dev     # postgres + review-gen :8001 + api :8000 + web :5173 + db UI :4983
```

Then open <http://localhost:5173>. The database itself is browsable at
<http://localhost:4983> (read-only table viewer, see **Looking at the
database** below).

`db:seed` only enables a system when its provider key is present, so a
partially-filled `.env` gives you a smaller lineup rather than failed
reviews. The LLM-as-judge needs `DEEPSEEK_API_KEY` and has no mock
fallback.

### Environment variables

See [.env.example](.env.example). Required at minimum:

- `DATABASE_URL` — Postgres connection (the local Docker instance)
- `ADMIN_TOKEN` — bearer for `/admin/*` (32+ char random)
- `PAIR_TOKEN_SECRET` — HMAC key for pair tokens (32+ char random, **separate** from ADMIN_TOKEN)
- `WEB_ORIGIN` — CORS whitelist, comma-separated
- `REVIEW_GEN_API_KEY` — shared key the Node API sends to the Python
  service as `X-API-Key`; required in production so no one else can
  spend your LLM budget via `/generate`

Optional:

- `RATING_BASELINE_SLUG` — system pinned at 1000 on the Bradley-Terry
  board (default `claude-sonnet-5`). BT ratings are only defined up to an additive
  constant, so one system fixes the origin. Change it and every BT rating
  renumbers, so pick a high-volume system and leave it: retiring the
  system is fine, since disabled systems keep their battle history.

For the review systems you also need `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, and `CHANDRA_API_KEY` for PDF
parsing.

Rotation playbook: [docs/SECRETS.md](docs/SECRETS.md).

## Looking at the database

The database is the `postgres` service in [docker-compose.yml](docker-compose.yml)
— one local instance, nothing managed. Three ways to read it:

```bash
# 1. Browser UI — read-only table viewer, started automatically by `pnpm dev`
pnpm --filter @reviewarena/api db:browser      # → http://localhost:4983

# 2. psql inside the container (no local psql needed)
docker exec -it reviewarena-postgres psql -U reviewarena -d reviewarena
```

The browser UI ([scripts/db-browser.ts](apps/api/scripts/db-browser.ts)) is
deliberately minimal: `node:http` + the `pg` pool, no extra dependencies.
Every query is a `SELECT`, table names are whitelisted from `pg_tables`
rather than taken from the URL, and it binds `127.0.0.1` only. Drizzle
Studio (`db:studio`) does not work on Node 24 with the pinned
`drizzle-kit@0.30.x` — it patches undici internals that no longer exist,
and fails with a misleading `ETIMEDOUT`.

Useful one-shots: `db:inspect` (latest paper + its review statuses),
`db:wipe-data` (truncate study data, keep the reviewer registry),
`db:nuke` (drop everything).

## Deployment

**There is no deploy automation in this repo.** The Vercel and Google
Cloud workflows were removed pending the move to a self-hosted VM; the
only workflow left is [ci.yml](.github/workflows/ci.yml), which
type-checks and tests but never deploys. Pushing to `main` no longer
changes any running environment — and no longer runs migrations against
a live database.

Nothing needs a GPU: PDF parsing and every review system are third-party
APIs, so the three services are small, stateless, CPU-only processes.

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

`apps/api/Dockerfile` and `services/review-gen/Dockerfile` are kept —
they build plain containers with no platform-specific glue, so they carry
over to the VM. A reverse proxy (Caddy / Nginx) terminates TLS, serves
the SPA, and routes `/api/*` to the API process.

### Still tied to Google Cloud

One runtime dependency survives the cleanup: arXiv parsing calls a
self-hosted `arxiv2md` instance whose default URL is hard-coded in
[arxiv2md.py](services/review-gen/app/parsing/arxiv2md.py) and still
points at Cloud Run. Its source is in `services/cloudrun/arxiv2md/` (with
a Dockerfile). Run that container on the VM and set `ARXIV2MD_BASE` to
the new address, or arXiv uploads break once the Cloud Run service is
torn down. PDF uploads are unaffected — they go to Datalab's hosted API.

### Before a study window

There is **no model warm-up step** — every review system is a hosted
provider API, so there are no weights to load and no multi-minute cold
start to pre-empt. Keep the API's request timeout generous (300 s) and
review-gen's more generous still (600 s): a reasoning model streaming a
long review can run for minutes.

What is worth checking before a session:

- each provider key in `.env` is live and in budget;
- `pnpm --filter @reviewarena/api db:seed` has been re-run, so the
  systems you expect are `enabled` (a missing key silently disables its
  system);
- provider rate limits are high enough for the expected concurrency —
  size the review-gen worker count against them, not against CPU.

**Backup**: nightly `pg_dump`. PDFs are never persisted — only the
parsed structure (jsonb) and review outputs are stored.

## Algorithmic credits

Both rating systems are ported from
[LMSYS FastChat](https://github.com/lm-sys/FastChat) (Apache 2.0),
`fastchat/serve/monitor/rating_systems.py`. Constants are FastChat's
defaults (K=4, BASE=10, SCALE=400, INIT=1000). The LMArena
`get_battle_pair` weighted sampler is similarly ported to
[apps/api/src/pair/select-pair.ts](apps/api/src/pair/select-pair.ts).

- **Elo** — `compute_elo` / `compute_bootstrap_elo`, in
  [apps/api/src/elo/elo.ts](apps/api/src/elo/elo.ts). Order-dependent and
  incremental, which is what the pair sampler reads and what the reveal
  screen's per-vote delta is.
- **Bradley-Terry** — `preprocess_for_bt` / `fit_bt` / `scale_and_offset`
  / `compute_bt` / `compute_bootstrap_bt`, in
  [apps/api/src/elo/bt.ts](apps/api/src/elo/bt.ts). This is the default
  board, matching LMArena's current public leaderboard (minus style
  control, which needs per-response length and markdown features we do
  not collect).

Two documented deviations in the BT port, neither of which moves the
estimate where FastChat's own estimate is well-defined:

1. **MM (Zermelo/Hunter/Newman) fixed point instead of scipy L-BFGS-B**,
   since Node has no L-BFGS. Same likelihood, same MLE. Checked against a
   fixture generated from FastChat's own `compute_bt`
   ([bt-parity.test.ts](apps/api/src/elo/__tests__/bt-parity.test.ts)):
   our fit reaches `|grad|inf = 1.5e-08` where FastChat's L-BFGS stops at
   `3.4e-03`, so the ~5e-4-point gap between the two is *their*
   `gtol=1e-6`, not our error.
2. **A connectivity guard.** The BT MLE is finite only if the win-graph is
   strongly connected (Ford 1957) — an unbeaten or winless system diverges,
   and FastChat reports whatever `maxiter=100` reached. We fit the largest
   strongly-connected component and report the rest as unranked. This is
   what makes BT usable at thesis scale (~250 votes) and on the eight
   sparse per-dimension boards, where separation is the norm rather than
   the exception.

BT ratings are identified only up to an additive constant, so
`RATING_BASELINE_SLUG` (default `claude-sonnet-5`) is pinned at 1000 to keep
snapshots comparable as systems are added and retired — FastChat pins
`mixtral-8x7b-instruct-v0.1` at 1114 for the same reason. Boards where the
baseline has not battled are mean-centred instead, recorded per snapshot row
as `anchor`.

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
