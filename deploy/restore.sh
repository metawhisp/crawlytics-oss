#!/usr/bin/env bash
#
# Crawlytics restore. Brings the stack up (the app runs migrations, creating the
# events table + rollups + materialized views), loads events, and lets the MVs
# rebuild the daily_* rollups. Refuses to load into a non-empty events table
# unless --force (which truncates events + rollups first).
#
#   ./restore.sh <backup-dir>          restore into an empty instance
#   ./restore.sh <backup-dir> --force  truncate existing data, then restore
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"
ENV_FILE="${SCRIPT_DIR}/.env"
[ -f "${ENV_FILE}" ] || { echo "error: .env not found; run install.sh first" >&2; exit 1; }

DIR="${1:?usage: ./restore.sh <backup-dir> [--force]}"
[ -f "${DIR}/events.native" ] || { echo "error: ${DIR}/events.native not found" >&2; exit 1; }
FORCE=0
[ "${2:-}" = "--force" ] && FORCE=1

PROJECT="crawlytics"
FILES=(-f compose.prod.yml)
[ -f compose.tls.yml ] && FILES+=(-f compose.tls.yml)
compose() { docker compose -p "${PROJECT}" "${FILES[@]}" "$@"; }

get_env() { sed -n "s/^$1=//p" "${ENV_FILE}" | head -1; }
CH_DB="$(get_env CLICKHOUSE_DATABASE)"; CH_DB="${CH_DB:-crawlytics}"
CH_USER="$(get_env CLICKHOUSE_USER)"; CH_USER="${CH_USER:-crawlytics}"
CH_PASS="$(get_env CLICKHOUSE_PASSWORD)"
ch() { compose exec -T clickhouse clickhouse-client -u "${CH_USER}" --password "${CH_PASS}" -d "${CH_DB}" "$@"; }

# Verify the dump against the manifest BEFORE touching any data, so a corrupt
# backup can never truncate a good database (with --force) and load garbage.
EXPECTED_SHA="$(sed -n 's/.*"events_sha256": *"\([a-f0-9]*\)".*/\1/p' "${DIR}/manifest.json" 2>/dev/null || true)"
ACTUAL_SHA="$( (sha256sum "${DIR}/events.native" 2>/dev/null || shasum -a 256 "${DIR}/events.native") | cut -d' ' -f1)"
if [ -n "${EXPECTED_SHA}" ] && [ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]; then
  echo "error: events.native checksum does not match the manifest — refusing to restore a corrupt backup." >&2
  exit 1
fi
EXPECTED="$(sed -n 's/.*"events": *\([0-9]*\).*/\1/p' "${DIR}/manifest.json" 2>/dev/null || true)"

echo "==> Bringing the stack up (runs migrations / creates schema)…"
compose up -d

echo "==> Waiting for the events table…"
ready=0
for _ in $(seq 1 30); do
  if [ "$(ch --query "EXISTS TABLE events" 2>/dev/null | tr -d '[:space:]')" = "1" ]; then ready=1; break; fi
  sleep 2
done
[ "${ready}" -eq 1 ] || { echo "error: events table did not appear (is the app healthy?)" >&2; exit 1; }

# Stop the app so nothing ingests while we truncate/load. The trap brings it
# back on every exit path, including failures.
echo "==> Stopping app during restore (no concurrent ingest)…"
trap 'compose start app >/dev/null 2>&1 || true' EXIT
compose stop app

COUNT="$(ch --query "SELECT count() FROM events" | tr -d '[:space:]')"
if [ "${COUNT:-0}" != "0" ]; then
  if [ "${FORCE}" -eq 0 ]; then
    echo "error: events table is not empty (${COUNT} rows). Re-run with --force to truncate and overwrite." >&2
    exit 1
  fi
  echo "==> --force: truncating events + rollups…"
  ch --query "TRUNCATE TABLE events"
  for t in daily_bot_stats daily_page_stats daily_referrals; do
    ch --query "TRUNCATE TABLE IF EXISTS ${t}"
  done
fi

echo "==> Loading events (materialized views rebuild the rollups)…"
ch --query "INSERT INTO events FORMAT Native" < "${DIR}/events.native"

echo "==> Restoring metadata…"
if [ -f "${DIR}/metadata.json" ]; then
  compose cp "${DIR}/metadata.json" app:/data/metadata.json
fi

NEW="$(ch --query "SELECT count() FROM events" | tr -d '[:space:]')"
if [ -n "${EXPECTED}" ] && [ "${NEW}" != "${EXPECTED}" ]; then
  echo "error: restored ${NEW} events but the manifest expected ${EXPECTED}. Restore is suspect." >&2
  exit 1
fi
echo "==> Restore complete: ${NEW} events. Starting app…"
