#!/usr/bin/env bash
#
# Crawlytics backup. Dumps the raw events table + the metadata file. The daily_*
# rollups are NOT backed up — restore rebuilds them from events via the
# materialized views (backing them up would double-count after restore).
#
#   ./backup.sh           consistent backup: briefly stops the app to flush, then dumps
#   ./backup.sh --online  best-effort backup without stopping the app (may miss in-flight rows)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"
ENV_FILE="${SCRIPT_DIR}/.env"
[ -f "${ENV_FILE}" ] || { echo "error: .env not found; run install.sh first" >&2; exit 1; }

ONLINE=0
[ "${1:-}" = "--online" ] && ONLINE=1

PROJECT="crawlytics"
FILES=(-f compose.prod.yml)
[ -f compose.tls.yml ] && FILES+=(-f compose.tls.yml)
compose() { docker compose -p "${PROJECT}" "${FILES[@]}" "$@"; }

get_env() { sed -n "s/^$1=//p" "${ENV_FILE}" | head -1; }
CH_DB="$(get_env CLICKHOUSE_DATABASE)"; CH_DB="${CH_DB:-crawlytics}"
CH_USER="$(get_env CLICKHOUSE_USER)"; CH_USER="${CH_USER:-crawlytics}"
CH_PASS="$(get_env CLICKHOUSE_PASSWORD)"

ch() { compose exec -T clickhouse clickhouse-client -u "${CH_USER}" --password "${CH_PASS}" -d "${CH_DB}" "$@"; }
sha256() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${SCRIPT_DIR}/backups/crawlytics-${TS}"
mkdir -p "${OUT}"

if [ "${ONLINE}" -eq 0 ]; then
  echo "==> Stopping app for a consistent snapshot (graceful flush of buffered events)…"
  # Restart the app on ANY exit path, even if the backup fails midway.
  trap 'compose start app >/dev/null 2>&1 || true' EXIT
  compose stop app
fi

# With the app stopped, the dump, the count, and the metadata all describe the
# same moment (no new ingest in between). --online skips the stop and is
# best-effort by definition.
echo "==> Dumping events…"
ch --query "SELECT * FROM events FORMAT Native" > "${OUT}/events.native"
COUNT="$(ch --query "SELECT count() FROM events" | tr -d '[:space:]')"

echo "==> Copying metadata…"
# docker cp works on a stopped container; a fresh instance may have no file yet.
if ! compose cp "app:/data/metadata.json" "${OUT}/metadata.json" 2>/dev/null; then
  echo '{"sites":[],"keys":[]}' > "${OUT}/metadata.json"
fi

SHA="$(sha256 "${OUT}/events.native")"
cat > "${OUT}/manifest.json" <<EOF
{ "created": "${TS}", "events": ${COUNT:-0}, "events_sha256": "${SHA}", "online": ${ONLINE} }
EOF

echo "==> Backup complete: ${OUT}"
echo "    events: ${COUNT:-0}   sha256: ${SHA}"
echo "    restore with: ./restore.sh ${OUT}"
