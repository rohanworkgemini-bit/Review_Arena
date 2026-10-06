# ReviewArena: local setup

Step-by-step setup of a local development copy, from an empty folder to a running app.

## 1. Check the prerequisites

```bash
node --version      # 20 or newer
pnpm --version      # 9 or newer
uv --version        # Python environments (used instead of python3 -m venv)
docker --version
git --version
```

On the UKP VM all five are already installed: `pnpm` and `uv` live in `~/.local/bin`, and Docker works without sudo.

## 2. Clone the repo

```bash
cd ~
git clone https://github.com/rohanworkgemini-bit/Review_Arena.git ReviewArena
cd ReviewArena
```

## 3. Install the JavaScript dependencies and build the shared types

```bash
pnpm install
pnpm --filter @reviewarena/shared-types build
```

The API and the web app import the *compiled* shared types (`packages/shared-types/dist/`), and a fresh clone doesn't have them. If `pnpm install` already printed `packages/shared-types prepare: Done`, the second command is not needed.

## 4. Create the Python environment

```bash
uv venv services/review-gen/.venv
uv pip install --python services/review-gen/.venv/bin/python -r services/review-gen/requirements.txt
```

`python3 -m venv` does not work on the VM (`python3-venv` is not installed, and installing it needs sudo). `uv` does the same job without it.

## 5. Create the `.env` file

```bash
cp .env.example .env
openssl rand -hex 32    # run this three times, one value for each secret below
```

Open `.env` and fill in:

| Variable | Value |
|---|---|
| `DATABASE_URL` | keep the default (`…@localhost:5432/reviewarena`) |
| `ADMIN_TOKEN` | random value #1, your login for `/admin` |
| `PAIR_TOKEN_SECRET` | random value #2, must differ from `ADMIN_TOKEN` |
| `REVIEW_GEN_API_KEY` | random value #3 |
| `WEB_ORIGIN` | keep `http://localhost:5173` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `ZAI_API_KEY`, `DEEPSEEK_API_KEY` | your provider keys. Each key turns on one review system and its judge seat; a missing key just skips that system. |
| `CHANDRA_API_KEY` | from [datalab.to](https://www.datalab.to). Required for PDF uploads. |

`POSTGRES_PASSWORD`, `SITE_ADDRESS` and `SITE_HOST` are only for the production stack, so leave them for local use.

## 6. Start Postgres

```bash
docker compose up -d postgres
```

If another copy of the repo already runs the dev database container (`reviewarena-postgres`), this fails with a name conflict. Either reuse that container by adding `COMPOSE_PROJECT_NAME=reviewarena` to `.env`, or stop it first with `docker stop reviewarena-postgres`.

To keep this copy's data separate from another copy's, give it its own database:

```bash
docker exec reviewarena-postgres createdb -U reviewarena reviewarena_new
# then in .env:
# DATABASE_URL=postgresql://reviewarena:reviewarena@localhost:5432/reviewarena_new
```

## 7. Create the schema and seed the review systems

```bash
pnpm --filter @reviewarena/api exec drizzle-kit push --force
pnpm --filter @reviewarena/api db:seed
```

Check that it worked (use your database name in `-d`):

```bash
docker exec reviewarena-postgres psql -U reviewarena -d reviewarena -c "select slug, enabled from review_systems"
```

You should see six systems, each enabled when its provider key is set.

## 8. Run everything

Ports 8000, 8001 and 5173 must be free. If an older `pnpm dev` is still running, quit it with `q`, or run `pnpm dev:clean`. Then:

```bash
pnpm dev
```

That opens mprocs with four panes: `postgres`, `review-gen` (:8001), `api` (:8000) and `web` (:5173). All four should show **UP** with no errors. Use the arrow keys to switch panes, Tab to see a pane's full output, and `q` to quit everything.

## 9. Open the app

- **App:** <http://localhost:5173>. Over VS Code Remote the port is forwarded automatically; if not, add 5173 in the **Ports** tab.
- **Admin:** <http://localhost:5173/admin>. Paste your `ADMIN_TOKEN` into **Settings**, then check that the arena is enabled and choose whether the judge panel is on.

Every upload makes real, paid API calls: two reviews per arena paper, plus 12 judge calls per pair when the judge panel is on.

## Common problems

| Error | Fix |
|---|---|
| `Cannot find module …/shared-types/dist/index.js`, or Vite "Failed to resolve entry for package @reviewarena/shared-types" | `pnpm --filter @reviewarena/shared-types build` |
| `ensurepip is not available` | Use the `uv` commands from step 4, not `python3 -m venv` |
| `REVIEW_GEN_API_KEY is required…` in the review-gen pane | Set `REVIEW_GEN_API_KEY` in `.env` |
| Port already in use | `pnpm dev:clean`, then `pnpm dev` |
| Container name `reviewarena-postgres` already in use | See step 6 |
| PDF upload fails | Check `CHANDRA_API_KEY` |
