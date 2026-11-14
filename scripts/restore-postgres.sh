#!/usr/bin/env bash
# Restore a .sql.gz dump into DATABASE_URL, then optionally restart a Heroku dyno.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

DUMP_PATH="${1:-}"
if [[ -z "$DUMP_PATH" ]]; then
  # Prefer newest dump under backups/ or cwd
  DUMP_PATH="$(ls -1t backups/*.sql.gz 2>/dev/null | head -n1 || true)"
fi
if [[ -z "$DUMP_PATH" || ! -f "$DUMP_PATH" ]]; then
  echo "No dump file found. Pass a path or place *.sql.gz under backups/" >&2
  exit 1
fi

echo "Restoring ${DUMP_PATH} into DATABASE_URL…"
gunzip -c "$DUMP_PATH" | psql "$DATABASE_URL" --set ON_ERROR_STOP=1 -v ON_ERROR_STOP=1

echo "Restore finished."

if [[ -n "${HEROKU_API_KEY:-}" && -n "${HEROKU_APP_NAME:-}" ]]; then
  echo "Restarting Heroku dynos for ${HEROKU_APP_NAME}…"
  curl -fsS -X DELETE \
    -H "Accept: application/vnd.heroku+json; version=3" \
    -H "Authorization: Bearer ${HEROKU_API_KEY}" \
    "https://api.heroku.com/apps/${HEROKU_APP_NAME}/dynos" \
    >/dev/null
  echo "Dyno restart requested."
else
  echo "Skipping dyno restart (set HEROKU_API_KEY + HEROKU_APP_NAME to enable)."
fi
