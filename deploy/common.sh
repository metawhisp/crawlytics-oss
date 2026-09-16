# Shared by install.sh, backup.sh and restore.sh. Sourced, not executed.
#
# Both need the same two answers, and both used to guess them separately —
# which is how one of them ended up copying a path the instance does not use.

# Reads a key out of .env. Requires ENV_FILE to be set by the caller.
get_env() { sed -n "s/^$1=//p" "${ENV_FILE}" | head -1; }

sha256() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }

# Where this instance actually keeps its metadata file.
#
# The container's own environment is the source of truth: compose carries a
# default (CRAWLYTICS_METADATA_FILE:-/data/metadata.json), so an install that
# never edited .env has nothing there, and reading .env alone would make these
# scripts another copy of that default — wrong the moment anybody changes it.
#
# --all matters: both scripts stop the app on purpose, and without it compose
# answers nothing about the very container we need to ask.
metadata_path() {
  local id path
  id="$(compose ps --all -q app 2>/dev/null | head -1 || true)"
  if [ -n "${id}" ]; then
    path="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${id}" 2>/dev/null \
      | sed -n 's/^CRAWLYTICS_METADATA_FILE=//p' | head -1 || true)"
    [ -n "${path}" ] && { printf '%s\n' "${path}"; return; }
  fi
  path="$(get_env CRAWLYTICS_METADATA_FILE)"
  printf '%s\n' "${path:-/data/metadata.json}"
}

# Renders a value for .env so that Docker Compose hands the container exactly
# these bytes. Compose interpolates .env, so a raw value is not what arrives:
# measured on Compose 2026-09-16 by printing the variable inside a container,
# `ab$cd-x` arrived as `ab-x`, `$secret123` as the empty string (which disables
# the dashboard, fail-closed), and `ab #cd` as `ab`. Single quotes survive all
# three; a value containing a single quote cannot be represented this way at
# all, and is refused rather than written as something that means something
# else.
env_quote() {
  case "$1" in
    *"'"*) return 1 ;;
  esac
  printf "'%s'" "$1"
}
