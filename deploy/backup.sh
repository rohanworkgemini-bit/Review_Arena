#!/usr/bin/env bash
# Nightly Postgres backup for the ReviewArena prod stack.
#
# The votes table is the thesis dataset — irreplaceable human judgments.
# This dumps it in pg_dump custom format (compressed, restorable per-table)
# and keeps 14 days locally. Copy off-VM too (see UKP_RUNBOOK.md): a backup
# on the same disk as the database protects against bugs, not against the
# disk.
#
# Install (as the deploy user, from the repo root):
#   crontab -e
#   17 3 * * * cd /path/to/review-arena && ./deploy/backup.sh >> /var/log/reviewarena-backup.log 2>&1
#
# Restore drill (do this once BEFORE the study):
#   docker compose -f docker-compose.prod.yml exec -T postgres \
#     pg_restore -U reviewarena -d reviewarena --clean --if-exists < backups/reviewarena_<stamp>.dump
set -euo pipefail

COMPOSE_FILE="docker-compose.prod.yml"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%F_%H%M%S)"

mkdir -p "$BACKUP_DIR"
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U reviewarena -Fc reviewarena > "$BACKUP_DIR/reviewarena_${STAMP}.dump"

# Refuse to silently keep a truncated dump.
[ -s "$BACKUP_DIR/reviewarena_${STAMP}.dump" ] || { echo "empty dump!" >&2; exit 1; }

find "$BACKUP_DIR" -name 'reviewarena_*.dump' -mtime "+${RETENTION_DAYS}" -delete
echo "$(date -Is) backup ok: reviewarena_${STAMP}.dump ($(du -h "$BACKUP_DIR/reviewarena_${STAMP}.dump" | cut -f1))"
