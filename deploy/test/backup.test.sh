#!/usr/bin/env bash
#
# Exercises deploy/backup.sh against a stand-in docker. The repository has no
# shell test framework; this is the cheapest thing that can produce a red for
# the defects these tests are about, and it runs anywhere bash does.
#
#   ./deploy/test/backup.test.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(dirname "${HERE}")"
PASS=0
FAIL=0

check() { # check <name> <condition-description> <0|1 result>
  if [ "$3" -eq 0 ]; then
    PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL %s — %s\n' "$1" "$2"
  fi
}

setup() { # setup -> echoes a fresh sandbox dir with backup.sh and a stub docker
  local box; box="$(mktemp -d)"
  mkdir -p "${box}/bin" "${box}/stub"
  cp "${DEPLOY}/backup.sh" "${box}/backup.sh"
  cp "${DEPLOY}/common.sh" "${box}/common.sh"
  cp "${DEPLOY}/compose.prod.yml" "${box}/compose.prod.yml" 2>/dev/null || true
  cp "${HERE}/stub-docker" "${box}/bin/docker"
  printf 'CLICKHOUSE_DATABASE=tc\nCLICKHOUSE_USER=tc\nCLICKHOUSE_PASSWORD=pw\n' > "${box}/.env"
  printf '%s\n' "${box}"
}

run_backup() { # run_backup <box> [args...] -> exit code, output in $OUTPUT
  local box="$1"; shift
  OUTPUT="$(cd "${box}" && PATH="${box}/bin:${PATH}" STUB_LOG="${box}/calls.txt" STUB_DIR="${box}/stub" \
    bash ./backup.sh "$@" 2>&1)"
  return $?
}

echo "backup.sh"

# --- A copy failure must not be reported as a complete backup -----------------
box="$(setup)"
touch "${box}/stub/fail-cp"
run_backup "${box}"; code=$?
check "fails when the metadata copy fails" "exited ${code}, expected non-zero" "$([ "${code}" -ne 0 ] && echo 0 || echo 1)"
check "says nothing about being complete" "printed a success line anyway" \
  "$(echo "${OUTPUT}" | grep -qi 'backup complete' && echo 1 || echo 0)"
left="$(find "${box}/backups" -name manifest.json 2>/dev/null | wc -l | tr -d ' ')"
check "leaves no directory that looks valid" "a manifest was written for a failed run" \
  "$([ "${left}" = "0" ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- A new install with no metadata yet is not a failure ----------------------
box="$(setup)"
run_backup "${box}"; code=$?
check "succeeds on an instance that has no metadata yet" "exited ${code}" \
  "$([ "${code}" -eq 0 ] && echo 0 || echo 1)"
manifest="$(find "${box}/backups" -name manifest.json 2>/dev/null | head -1)"
check "records in the manifest that metadata is absent" "manifest does not say so" \
  "$(grep -q '"metadata"' "${manifest}" 2>/dev/null && echo 0 || echo 1)"
rm -rf "${box}"

# --- The configured path is honoured, not a hard-coded one --------------------
box="$(setup)"
printf 'CRAWLYTICS_METADATA_FILE=/data/custom.json\n' >> "${box}/.env"
run_backup "${box}" >/dev/null 2>&1
check "copies the path the instance actually uses" "asked for /data/metadata.json instead" \
  "$(grep -q 'app:/data/custom.json' "${box}/calls.txt" && echo 0 || echo 1)"
rm -rf "${box}"

# --- What docker actually says when the file is not there -------------------
box="$(setup)"
# The stub used to answer this case by exiting 0 and simply not creating a file,
# so the branch that tells "absent" from "failed" — the whole point of this
# iteration — was never executed. Real docker exits 1 and says so on stderr.
touch "${box}/stub/fail-cp"
printf 'Error response from daemon: Could not find the file /data/metadata.json in container app-1\n' \
  > "${box}/stub/err-cp"
run_backup "${box}"; code=$?
check "reads a real docker 'file not found' as an empty instance" "exited ${code}" \
  "$([ "${code}" -eq 0 ] && echo 0 || echo 1)"
manifest="$(find "${box}/backups" -name manifest.json 2>/dev/null | head -1)"
check "and records it as absent, not as a copy that worked" "manifest does not say absent" \
  "$(grep -q '"metadata": "absent"' "${manifest}" 2>/dev/null && echo 0 || echo 1)"
rm -rf "${box}"

# --- Any other copy failure is still a failure ------------------------------
box="$(setup)"
touch "${box}/stub/fail-cp"
printf 'Error response from daemon: permission denied\n' > "${box}/stub/err-cp"
run_backup "${box}"; code=$?
check "does not mistake a permission error for an empty instance" "exited ${code}, expected non-zero" \
  "$([ "${code}" -ne 0 ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- A stopped app container is still the source of truth -------------------
box="$(setup)"
printf 'CRAWLYTICS_METADATA_FILE=/data/from-env.json\n' >> "${box}/.env"
# `compose ps -q` without --all answers nothing for a stopped container, and the
# app is deliberately stopped during a backup. Falling back to .env there brought
# the whole defect back through another door.
printf 'container-id\n' > "${box}/stub/out-ps"
printf 'CRAWLYTICS_METADATA_FILE=/data/from-container.json\n' > "${box}/stub/out-inspect"
run_backup "${box}" >/dev/null 2>&1
check "asks compose for stopped containers too" "did not pass --all to ps" \
  "$(grep -qE 'ps .*--all|--all .*ps' "${box}/calls.txt" && echo 0 || echo 1)"
rm -rf "${box}"

# --- A failed restart must not be reported as a clean backup ----------------
box="$(setup)"
touch "${box}/stub/fail-start"
run_backup "${box}"; code=$?
check "fails when it cannot bring ingest back up" "exited ${code}, expected non-zero" \
  "$([ "${code}" -ne 0 ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- The container's own environment wins over .env -------------------------
box="$(setup)"
# .env says one thing; the running instance says another. compose carries a
# default, so .env is routinely silent or stale — the container is the truth.
printf 'CRAWLYTICS_METADATA_FILE=/data/from-env.json\n' >> "${box}/.env"
printf 'container-id\n' > "${box}/stub/out-ps"
printf 'NODE_ENV=production\nCRAWLYTICS_METADATA_FILE=/data/from-container.json\n' > "${box}/stub/out-inspect"
run_backup "${box}" >/dev/null 2>&1
check "prefers the path the container is actually running with" "used .env instead of the container" \
  "$(grep -q 'app:/data/from-container.json' "${box}/calls.txt" && echo 0 || echo 1)"
rm -rf "${box}"

# --- The manifest count must describe the dump, not the table -----------------
# restore.sh compares the events it restored against this number and exits 1 on
# a mismatch. With --online the app keeps ingesting, so a count() taken after
# the dump finished describes a later moment: the backup is fine, the restore
# loads every row it holds, and then calls itself suspect. Verified on a real
# ClickHouse 25.5 that `clickhouse-local --input-format Native --query
# "SELECT count() FROM table"` returns the dump's own row count.
box="$(setup)"
printf 'row-a\nrow-b\n' > "${box}/stub/out-exec-1"   # the dump: two rows
printf '5\n' > "${box}/stub/out-exec-2"               # a later count(): ingest moved on
printf '2\n' > "${box}/stub/out-local"                # what the dump itself holds
run_backup "${box}" --online
dir="$(ls -d "${box}"/backups/* 2>/dev/null | head -1)"
events="$(sed -n 's/.*"events": *\([0-9]*\).*/\1/p' "${dir}/manifest.json" 2>/dev/null)"
check "online backup counts the dump, not the table afterwards" \
  "manifest says ${events:-<none>}, the dump holds 2" \
  "$([ "${events}" = "2" ] && echo 0 || echo 1)"
rm -rf "${box}"

# --- An instance with no events at all ----------------------------------------
# A zero-row table dumps zero bytes, and no structure can be inferred from
# those, so the count cannot come from the file. It is simply zero.
box="$(setup)"
: > "${box}/stub/out-exec"                             # every query answers empty
printf 'SHOULD NOT BE ASKED\n' > "${box}/stub/out-local"
run_backup "${box}"
dir="$(ls -d "${box}"/backups/* 2>/dev/null | head -1)"
events="$(sed -n 's/.*"events": *\([0-9]*\).*/\1/p' "${dir}/manifest.json" 2>/dev/null)"
check "an empty instance backs up as zero events" \
  "manifest says ${events:-<none>}, expected 0" \
  "$([ "${events}" = "0" ] && echo 0 || echo 1)"
rm -rf "${box}"

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
