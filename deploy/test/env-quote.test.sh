#!/usr/bin/env bash
#
# What install.sh may write into .env. Docker Compose interpolates .env values,
# so a raw password is not the password the container receives. Measured on
# Docker Compose (2026-09-16) by running a container and printing the variable:
#
#   TC_DASHBOARD_PASSWORD=ab$cd-x     -> container saw "ab-x"
#   TC_DASHBOARD_PASSWORD=$secret123  -> container saw ""      (dashboard disabled)
#   TC_DASHBOARD_PASSWORD=ab #cd      -> container saw "ab"
#   TC_DASHBOARD_PASSWORD='ab$cd-x'   -> container saw "ab$cd-x"   ✔
#   TC_DASHBOARD_PASSWORD='ab #cd'    -> container saw "ab #cd"    ✔
#
#   ./deploy/test/env-quote.test.sh
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

# shellcheck source=deploy/common.sh
. "${DEPLOY}/common.sh"

echo "env_quote"

got="$(env_quote 'ab$cd-x')"
check "wraps a value containing a dollar" "got ${got}" \
  "$([ "${got}" = "'ab\$cd-x'" ] && echo 0 || echo 1)"

got="$(env_quote 'ab #cd')"
check "wraps a value containing a comment marker" "got ${got}" \
  "$([ "${got}" = "'ab #cd'" ] && echo 0 || echo 1)"

got="$(env_quote 'plain123')"
check "wraps a plain value too, rather than deciding case by case" "got ${got}" \
  "$([ "${got}" = "'plain123'" ] && echo 0 || echo 1)"

# A single quote cannot be represented inside a single-quoted dotenv value —
# measured: compose read it as empty. The caller must refuse such a password
# rather than write something that silently means something else.
if env_quote "ab'cd" >/dev/null 2>&1; then
  check "refuses a value it cannot represent" "returned success for a value with a quote" 1
else
  check "refuses a value it cannot represent" "" 0
fi

printf '\n%d passed, %d failed\n' "${PASS}" "${FAIL}"
[ "${FAIL}" -eq 0 ]
