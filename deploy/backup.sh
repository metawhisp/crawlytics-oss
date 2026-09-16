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

# shellcheck source=deploy/common.sh
. "${SCRIPT_DIR}/common.sh"
CH_DB="$(get_env CLICKHOUSE_DATABASE)"; CH_DB="${CH_DB:-crawlytics}"
CH_USER="$(get_env CLICKHOUSE_USER)"; CH_USER="${CH_USER:-crawlytics}"
CH_PASS="$(get_env CLICKHOUSE_PASSWORD)"

ch() { compose exec -T clickhouse clickhouse-client -u "${CH_USER}" --password "${CH_PASS}" -d "${CH_DB}" "$@"; }

META_PATH="$(metadata_path)"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${SCRIPT_DIR}/backups/crawlytics-${TS}"
mkdir -p "${OUT}"
# A half-written directory must not survive to look like a usable backup.
abort() { echo "error: $1" >&2; rm -rf "${OUT}"; exit 1; }

if [ "${ONLINE}" -eq 0 ]; then
  echo "==> Stopping app for a consistent snapshot (graceful flush of buffered events)…"
  # Restart the app on ANY exit path, even if the backup fails midway.
  # Restart the app on ANY exit path, even if the backup fails midway. Printing a
  # warning is not enough: a trap that ends normally leaves the exit code alone,
  # so automation would read success while ingest stayed down. Keep the original
  # status if the backup already failed; otherwise turn a failed restart into one.
  restore_app() {
    local status=$?
    if ! compose start app >/dev/null 2>&1; then
      echo "WARNING: could not restart the app — ingest is still stopped" >&2
      [ "${status}" -eq 0 ] && status=1
    fi
    exit "${status}"
  }
  trap restore_app EXIT
  compose stop app
fi

# With the app stopped, the dump, the count, and the metadata all describe the
# same moment (no new ingest in between). --online skips the stop and is
# best-effort by definition.
echo "==> Dumping events…"
ch --query "SELECT * FROM events FORMAT Native" > "${OUT}/events.native"
# Count the DUMP, not the table. restore.sh compares the rows it restored
# against this number and exits 1 on a mismatch, so the number has to be a
# property of the file. A second count() over events is not: with --online the
# app keeps ingesting while the dump streams, so it describes a later moment,
# and a backup holding every row it dumped restored to "Restore is suspect".
# Measured on ClickHouse 25.5: clickhouse-local reads a Native dump on stdin
# and counts it exactly. A zero-row table dumps zero bytes, from which no
# structure can be inferred — that case is simply zero, and must not ask.
if [ -s "${OUT}/events.native" ]; then
  COUNT="$(compose exec -T clickhouse clickhouse-local --input-format Native \
    --query "SELECT count() FROM table" < "${OUT}/events.native" | tr -d '[:space:]')"
else
  COUNT=0
fi

echo "==> Copying metadata (${META_PATH})…"
# docker cp works on a stopped container. Two outcomes look alike and must not
# be confused: an instance that has no metadata yet is fine, a copy that failed
# is not. Writing a placeholder for both is how a backup came to report success
# while quietly holding none of the sites, keys, license or alert settings.
CP_ERR="$(compose cp "app:${META_PATH}" "${OUT}/metadata.json" 2>&1 >/dev/null)" && CP_OK=1 || CP_OK=0
if [ "${CP_OK}" -eq 1 ] && [ -s "${OUT}/metadata.json" ]; then
  META_STATE="present"
  META_SHA="$(sha256 "${OUT}/metadata.json")"
elif [ "${CP_OK}" -eq 0 ] && ! printf '%s' "${CP_ERR}" | grep -qiE 'no such file|not found|could not find'; then
  abort "could not copy metadata from ${META_PATH}: ${CP_ERR:-docker cp failed}"
else
  # Nothing there yet — a fresh instance. Say so in the manifest instead of
  # inventing an empty file that restore would happily put over a live one.
  rm -f "${OUT}/metadata.json"
  META_STATE="absent"
  META_SHA=""
fi

SHA="$(sha256 "${OUT}/events.native")"
cat > "${OUT}/manifest.json" <<EOF
{ "created": "${TS}", "events": ${COUNT:-0}, "events_sha256": "${SHA}", "online": ${ONLINE},
  "metadata": "${META_STATE}", "metadata_path": "${META_PATH}", "metadata_sha256": "${META_SHA}" }
EOF

echo "==> Backup complete: ${OUT}"
echo "    events: ${COUNT:-0}   sha256: ${SHA}   metadata: ${META_STATE}"
echo "    restore with: ./restore.sh ${OUT}"
