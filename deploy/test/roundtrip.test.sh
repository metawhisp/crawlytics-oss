#!/usr/bin/env bash
#
# The circle: a backup made by backup.sh is fed to restore.sh. Each script has
# its own suite; neither proves they agree on the manifest one writes and the
# other reads. That gap is not theoretical — the manifest's event count was a
# count of the TABLE taken after the dump, and restore compares it against the
# rows it loaded, so an --online backup restored to "Restore is suspect".
#
#   ./deploy/test/roundtrip.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(dirname "${HERE}")"
PASS=0
FAIL=0

check() {
  if [ "$3" -eq 0 ]; then
    PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL %s — %s\n' "$1" "$2"
  fi
}

# A path that is not the default, because the default is exactly what a
# hard-coded fallback would get right by accident.
META_PATH="/data/custom-metadata.json"

setup() {
  local box; box="$(mktemp -d)"
  mkdir -p "${box}/bin" "${box}/stub"
  cp "${DEPLOY}/backup.sh" "${DEPLOY}/restore.sh" "${DEPLOY}/common.sh" "${box}/"
  cp "${DEPLOY}/compose.prod.yml" "${box}/compose.prod.yml" 2>/dev/null || true
  cp "${HERE}/stub-docker" "${box}/bin/docker"
  printf 'CLICKHOUSE_DATABASE=tc\nCLICKHOUSE_USER=tc\nCLICKHOUSE_PASSWORD=pw\nCRAWLYTICS_METADATA_FILE=%s\n' \
    "${META_PATH}" > "${box}/.env"
  printf '{"sites":[{"id":"acme"}],"keys":[{"id":"k1"}]}\n' > "${box}/stub/out-cp"
  # "1" answers both EXISTS TABLE events and every count(): the dump holds one
  # row, the restore finds one row, and the two have to agree on it.
  printf '1\n' > "${box}/stub/out-exec"
  printf '1\n' > "${box}/stub/out-local"
  printf '%s\n' "${box}"
}

echo "backup.sh -> restore.sh"

box="$(setup)"
OUT="$(cd "${box}" && PATH="${box}/bin:${PATH}" STUB_LOG="${box}/calls.txt" STUB_DIR="${box}/stub" \
  bash ./backup.sh 2>&1)"; code=$?
check "the backup succeeds" "exited ${code}: ${OUT}" "$([ "${code}" -eq 0 ] && echo 0 || echo 1)"

dir="$(ls -d "${box}"/backups/* 2>/dev/null | head -1)"
check "it wrote a manifest" "no manifest under ${box}/backups" \
  "$([ -f "${dir}/manifest.json" ] && echo 0 || echo 1)"
check "it captured the metadata, not a placeholder" "manifest does not say present" \
  "$(grep -q '"metadata": "present"' "${dir}/manifest.json" && echo 0 || echo 1)"
check "it recorded the path the instance actually uses" "manifest names another path" \
  "$(grep -q "\"metadata_path\": \"${META_PATH}\"" "${dir}/manifest.json" && echo 0 || echo 1)"

# Restore reads the same directory. The count it reports comes from out-exec's
# two lines, which is what the dump holds, so the manifest must agree.
: > "${box}/calls.txt"
OUT="$(cd "${box}" && PATH="${box}/bin:${PATH}" STUB_LOG="${box}/calls.txt" STUB_DIR="${box}/stub" \
  bash ./restore.sh "${dir}" --force 2>&1)"; code=$?
check "the restore accepts it" "exited ${code}: ${OUT}" "$([ "${code}" -eq 0 ] && echo 0 || echo 1)"
check "and says so" "no completion line: ${OUT}" \
  "$(echo "${OUT}" | grep -qi 'restore complete' && echo 0 || echo 1)"
check "metadata goes back to the recorded path" "did not copy to ${META_PATH}" \
  "$(grep -q "app:${META_PATH}" "${box}/calls.txt" && echo 0 || echo 1)"
rm -rf "${box}"

# The same circle with --online — the mode whose count used to describe a
# different moment than its own dump. The table is made to answer a LARGER
# number than the dump holds, which is what ingest during a live backup does.
# Without the fix the manifest takes that larger number and the restore, having
# loaded every row the backup holds, calls itself suspect and exits 1.
box="$(setup)"
printf 'one-row-dump\n' > "${box}/stub/out-exec-1"   # the dump itself
printf '5\n' > "${box}/stub/out-exec-2"              # a count() taken later: ingest moved on
OUT="$(cd "${box}" && PATH="${box}/bin:${PATH}" STUB_LOG="${box}/calls.txt" STUB_DIR="${box}/stub" \
  bash ./backup.sh --online 2>&1)"; code=$?
dir="$(ls -d "${box}"/backups/* 2>/dev/null | head -1)"
check "the online backup succeeds" "exited ${code}: ${OUT}" "$([ "${code}" -eq 0 ] && echo 0 || echo 1)"

# Back to a stack that answers "1" to everything, and a fresh call counter: the
# restore is a separate run against the same instance.
rm -f "${box}/stub/out-exec-1" "${box}/stub/out-exec-2" "${box}/stub/.n-exec"
OUT="$(cd "${box}" && PATH="${box}/bin:${PATH}" STUB_LOG="${box}/calls.txt" STUB_DIR="${box}/stub" \
  bash ./restore.sh "${dir}" --force 2>&1)"; code=$?
check "an --online backup restores without being called suspect" "exited ${code}: ${OUT}" \
  "$([ "${code}" -eq 0 ] && echo 0 || echo 1)"
rm -rf "${box}"

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
