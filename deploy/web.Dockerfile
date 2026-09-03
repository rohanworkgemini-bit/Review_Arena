# Static web build + Caddy edge. One container serves the SPA, terminates
# TLS, and reverse-proxies /api/* to the api service (see deploy/Caddyfile).
#
# Build context MUST be the monorepo root:
#   docker build -f deploy/web.Dockerfile .

FROM node:22-slim AS builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages/shared-types packages/shared-types
COPY apps/web apps/web
RUN pnpm --filter @reviewarena/shared-types build \
 && pnpm --filter @reviewarena/web build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /repo/apps/web/dist /srv
