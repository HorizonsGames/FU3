#!/usr/bin/env bash
# Dump Postgres (Heroku DATABASE_URL) to backups/*.sql.gz
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
APP_SLUG="${HEROKU_APP_NAME:-fu3}"
OUT_DIR="backups"
mkdir -p "$OUT_DIR"

DUMP_SQL="${OUT_DIR}/${APP_SLUG}-${STAMP}.sql"
DUMP_GZ="${DUMP_SQL}.gz"
META="${OUT_DIR}/${APP_SLUG}-${STAMP}.meta.json"

echo "Creating pg_dump → ${DUMP_GZ}"
# Prefer SSL for Heroku; ignore missing optional tables quietly via plain SQL dump
pg_dump \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  --format=plain \
  "$DATABASE_URL" > "$DUMP_SQL"

gzip -9 "$DUMP_SQL"

BYTES="$(wc -c < "$DUMP_GZ" | tr -d ' ')"
cat > "$META" <<EOF
{
  "createdAt": "${STAMP}",
  "app": "${APP_SLUG}",
  "file": "$(basename "$DUMP_GZ")",
  "bytes": ${BYTES},
  "note": $(python3 -c 'import json,os; print(json.dumps(os.environ.get("NOTE","")))' 2>/dev/null || echo '""')
}
EOF

ARTIFACT_NAME="fu3-pg-backup-${STAMP}"
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "BACKUP_ARTIFACT_NAME=${ARTIFACT_NAME}" >> "$GITHUB_ENV"
fi

echo "Backup ready: ${DUMP_GZ} (${BYTES} bytes)"
echo "Artifact name: ${ARTIFACT_NAME}"
ls -lah "$OUT_DIR"
