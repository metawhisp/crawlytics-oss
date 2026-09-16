#!/usr/bin/env bash
#
# Exercises deploy/restore.sh against a stand-in docker. Restore is destructive:
# these cases are about what it must refuse to do BEFORE it touches anything.
#
#   ./deploy/test/restore.test.sh
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

setup() { # -> sandbox with restore.sh, a stub docker and a backup directory
  local box; box="$(mktemp -d)"
  mkdir -p "${box}/bin" "${box}/stub" "${box}/backup"
  cp "${DEPLOY}/restore.sh" "${box}/restore.sh"
  cp "${DEPLOY}/common.sh" "${box}/common.sh"
  cp "${DEPLOY}/compose.prod.yml" "${box}/compose.prod.yml" 2>/dev/null || true
  cp "${HERE}/stub-docker" "${box}/bin/docker"
  printf 'CLICKHOUSE_DATABASE=tc\nCLICKHOUSE_USER=tc\nCLICKHOUSE_PASSWORD=pw\n' > "${box}/.env"
  printf 'fake-native-dump\n' > "${box}/backup/events.native"
  # The stack answers "table exists" and "1 row", so a run gets as far as it can.
  printf '1\n' > "${box}/stub/out-exec"
  printf '%s\n' "${box}"
}

sha_of() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }

run_restore() {
  local box="$1"; shift
  OUTPUT="$(cd "${box}" && PATH="${box}/bin:${PATH}" STUB_LOG="${box}/calls.txt" STUB_DIR="${box}/stub" \
    bash ./restore.sh "$@" 2>&1)"
  return $?
}

truncates() { grep -c 'TRUNCATE' "$1/calls.txt" 2>/dev/null || echo 0; }

echo "restore.sh"

# --- No manifest at all -------------------------------------------------------
box="$(setup)"
run_restore "${box}" ./backup --force; code=$?
check "refuses a backup with no manifest" "exited ${code}, expected non-zero" \
  "$([ "${code}" -ne 0 ] && echo 0 || echo 1)"
check "and destroys nothing on the way out" "it truncated anyway" \
  "$([ "$(truncates "${box}")" = "0" ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- Manifest without a checksum ---------------------------------------------
box="$(setup)"
printf '{ "created": "x", "events": 1, "online": 0 }\n' > "${box}/backup/manifest.json"
run_restore "${box}" ./backup --force; code=$?
check "refuses a manifest with no checksum instead of skipping the check" "exited ${code}" \
  "$([ "${code}" -ne 0 ] && echo 0 || echo 1)"
check "and still destroys nothing" "it truncated anyway" \
  "$([ "$(truncates "${box}")" = "0" ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- Manifest that says metadata was captured, but it is not in the directory -
box="$(setup)"
printf '{ "created": "x", "events": 1, "events_sha256": "%s", "online": 0, "metadata": "present" }\n' \
  "$(sha_of "${box}/backup/events.native")" > "${box}/backup/manifest.json"
run_restore "${box}" ./backup --force; code=$?
check "refuses when the manifest promises metadata the directory lacks" "exited ${code}" \
  "$([ "${code}" -ne 0 ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- A complete backup restores to the path the instance uses ----------------
box="$(setup)"
printf '{ "created": "x", "events": 1, "events_sha256": "%s", "online": 0, "metadata": "present" }\n' \
  "$(sha_of "${box}/backup/events.native")" > "${box}/backup/manifest.json"
printf '{"sites":[],"keys":[],"license":null,"alerts":null}\n' > "${box}/backup/metadata.json"
printf 'container-id\n' > "${box}/stub/out-ps"
printf 'CRAWLYTICS_METADATA_FILE=/data/custom.json\n' > "${box}/stub/out-inspect"
run_restore "${box}" ./backup --force >/dev/null 2>&1
check "puts metadata where this instance keeps it" "used the hard-coded path" \
  "$(grep -q 'app:/data/custom.json' "${box}/calls.txt" && echo 0 || echo 1)"
rm -rf "${box}"

# --- Backups made before the manifest gained metadata fields -----------------
box="$(setup)"
printf '{ "created": "x", "events": 1, "events_sha256": "%s", "online": 0 }\n' \
  "$(sha_of "${box}/backup/events.native")" > "${box}/backup/manifest.json"
run_restore "${box}" ./backup --force; code=$?
check "still accepts a backup taken before metadata was recorded" "exited ${code}" \
  "$([ "${code}" -eq 0 ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- The placeholder the old backup.sh wrote must never be restored ----------
box="$(setup)"
printf '{ "created": "x", "events": 1, "events_sha256": "%s", "online": 0 }\n' \
  "$(sha_of "${box}/backup/events.native")" > "${box}/backup/manifest.json"
# Exactly what the broken backup.sh left behind when the copy failed. Putting it
# back over a live instance deletes every site, key, license and alert setting.
printf '{"sites":[],"keys":[]}\n' > "${box}/backup/metadata.json"
run_restore "${box}" ./backup --force; code=$?
check "refuses the empty placeholder a broken backup left behind" "exited ${code}, expected non-zero" \
  "$([ "${code}" -ne 0 ] && echo 0 || echo 1)"
check "and stops before it truncates anything" "it truncated first" \
  "$([ "$(truncates "${box}")" = "0" ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- A manifest that says there was no metadata, next to a metadata file -----
box="$(setup)"
printf '{ "created": "x", "events": 1, "events_sha256": "%s", "online": 0, "metadata": "absent" }\n' \
  "$(sha_of "${box}/backup/events.native")" > "${box}/backup/manifest.json"
printf '{"sites":[{"id":"a"}],"keys":[]}\n' > "${box}/backup/metadata.json"
run_restore "${box}" ./backup --force; code=$?
check "refuses a backup that contradicts its own manifest" "exited ${code}" \
  "$([ "${code}" -ne 0 ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- Metadata that does not match its recorded checksum ----------------------
box="$(setup)"
printf '{"sites":[{"id":"a"}],"keys":[]}\n' > "${box}/backup/metadata.json"
printf '{ "created": "x", "events": 1, "events_sha256": "%s", "online": 0, "metadata": "present", "metadata_sha256": "deadbeef" }\n' \
  "$(sha_of "${box}/backup/events.native")" > "${box}/backup/manifest.json"
run_restore "${box}" ./backup --force; code=$?
check "verifies the metadata checksum too, not only the events one" "exited ${code}" \
  "$([ "${code}" -ne 0 ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- Events that do not match their checksum ---------------------------------
box="$(setup)"
printf '{ "created": "x", "events": 1, "events_sha256": "deadbeef", "online": 0 }\n' > "${box}/backup/manifest.json"
run_restore "${box}" ./backup --force; code=$?
check "refuses a dump whose checksum does not match" "exited ${code}" \
  "$([ "${code}" -ne 0 ] && echo 0 || echo 1)"
check "without truncating first" "it truncated anyway" \
  "$([ "$(truncates "${box}")" = "0" ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- Manifest with no event count --------------------------------------------
box="$(setup)"
printf '{ "created": "x", "events_sha256": "%s", "online": 0 }\n' \
  "$(sha_of "${box}/backup/events.native")" > "${box}/backup/manifest.json"
run_restore "${box}" ./backup --force; code=$?
check "refuses a manifest with no event count" "exited ${code}" \
  "$([ "${code}" -ne 0 ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- A failed restart is not a successful restore ----------------------------
box="$(setup)"
printf '{ "created": "x", "events": 1, "events_sha256": "%s", "online": 0 }\n' \
  "$(sha_of "${box}/backup/events.native")" > "${box}/backup/manifest.json"
touch "${box}/stub/fail-start"
run_restore "${box}" ./backup --force; code=$?
check "fails when it cannot bring ingest back up" "exited ${code}, expected non-zero" \
  "$([ "${code}" -ne 0 ] && echo 0 || echo 1)"
rm -rf "${box}"

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
