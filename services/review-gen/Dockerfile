# Dockerfile for services/review-gen. Platform-agnostic — runs on any
# container host.
#
# Build context: services/review-gen/ (this dir is self-contained; no
# monorepo plumbing needed).
#
# Single stage — the Python dep tree is large (openai + anthropic +
# google-generativeai + tiktoken + httpx ~= 500 MB installed) but multi-
# stage doesn't save much because we'd still need the full venv at runtime.
# Final image ~750 MB.

FROM python:3.13-slim

WORKDIR /app

# tini = proper PID 1 (handles SIGTERM cleanly, no zombie processes).
# build-essential briefly needed for any wheel that needs C compilation.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini build-essential \
 && rm -rf /var/lib/apt/lists/*

# Install Python deps first (Docker layer cache: only re-runs when
# requirements.txt changes, not on source edits).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && apt-get purge -y build-essential \
 && apt-get autoremove -y

# Copy the application code.
COPY app app

# Non-root user — same hardening as apps/api Dockerfile.
RUN useradd --create-home --uid 10001 reviewarena
USER reviewarena

# Env contract (docker-compose.prod.yml sets these):
#   - PORT (default 8080), uvicorn binds to it
#   - REVIEW_GEN_API_KEY — required; main.py refuses to boot without it
#     unless REVIEWARENA_ENV=development. The deploy fails loudly. Intended.
#   - ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / ... via env_file
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
# Two workers: with one, a single wedged request (or a worker restart)
# stalls every student's generation at once. Each worker holds its own
# 100-token thread pool (see app/main.py startup hook).
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers 2"]
