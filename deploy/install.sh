#!/usr/bin/env bash
#
# Crawlytics one-command installer. Brings up the stack (app + ClickHouse) behind
# Caddy with automatic HTTPS. Idempotent: re-running upgrades in place and never
# regenerates secrets or deletes data volumes (only --purge does).
#
#   ./install.sh            install or upgrade on the domain in .env (prompts first run)
#   ./install.sh --upgrade  rebuild from this checkout and restart (keeps data)
#   ./install.sh --uninstall stop the stack, keep data volumes
#   ./install.sh --purge    stop the stack AND delete all data volumes (destructive)
#
set -euo pipefail

PROJECT="crawlytics"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
cd "${SCRIPT_DIR}"

compose() { docker compose -p "${PROJECT}" -f compose.prod.yml -f compose.tls.yml "$@"; }

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

gen_secret() { openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | cut -c1-32; }

get_env() { [ -f "${ENV_FILE}" ] && sed -n "s/^$1=//p" "${ENV_FILE}" | head -1 || true; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. See https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose ...)."
  docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon. Start Docker or run with sudo."
}

preflight_ports() {
  for port in 80 443; do
    if command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :${port} )" 2>/dev/null | grep -q ":${port}"; then
      warn "port ${port} already in use — Caddy needs it for HTTPS. Free it or installation may fail."
    fi
  done
}

preflight_dns() {
  local domain="$1" resolved="" public=""
  command -v dig >/dev/null 2>&1 && resolved="$(dig +short "${domain}" A | tail -1)"
  public="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [ -n "${resolved}" ] && [ -n "${public}" ] && [ "${resolved}" != "${public}" ]; then
    warn "${domain} resolves to ${resolved}, but this server looks like ${public}."
    warn "Point the domain's A record at this server, or Caddy cannot issue a certificate."
  fi
}

write_env_if_absent() {
  if [ -f "${ENV_FILE}" ]; then
    chmod 600 "${ENV_FILE}" 2>/dev/null || true
    log "Reusing existing .env (secrets preserved)."
    return
  fi

  [ -r /dev/tty ] || die "First install needs an interactive terminal — run ./install.sh directly (not piped)."
  log "First install — let's configure your instance."
  local domain email pass generated=0
  read -rp "Public domain (A record points here), e.g. analytics.example.com: " domain < /dev/tty
  [ -n "${domain}" ] || die "A domain is required for automatic HTTPS."
  read -rp "Email for certificate notices [admin@${domain}]: " email < /dev/tty
  email="${email:-admin@${domain}}"
  read -rsp "Dashboard password [Enter to generate]: " pass < /dev/tty
  echo
  if [ -z "${pass}" ]; then
    pass="$(gen_secret)"
    generated=1
  fi

  umask 077
  cat > "${ENV_FILE}" <<EOF
APP_PORT=3000
NODE_ENV=production

CRAWLYTICS_DOMAIN=${domain}
CRAWLYTICS_ACME_EMAIL=${email}

CLICKHOUSE_DATABASE=crawlytics
CLICKHOUSE_USER=crawlytics
CLICKHOUSE_PASSWORD=$(gen_secret)
CLICKHOUSE_URL=http://clickhouse:8123

CRAWLYTICS_METADATA_FILE=/data/metadata.json

TC_INGEST_KEYS=
TC_IP_HASH_SECRET=$(gen_secret)
TC_DASHBOARD_PASSWORD=${pass}
EOF
  chmod 600 "${ENV_FILE}"
  if [ "${generated}" -eq 1 ]; then
    log "Wrote ${ENV_FILE}. Generated dashboard password (save it — also in TC_DASHBOARD_PASSWORD): ${pass}"
  else
    log "Wrote ${ENV_FILE} with your dashboard password."
  fi
}

case "${1:-}" in
  --uninstall)
    require_docker
    log "Stopping the stack (data volumes kept)…"
    compose down
    log "Done. Data is preserved; re-run ./install.sh to start again."
    exit 0
    ;;
  --purge)
    require_docker
    [ -r /dev/tty ] || die "--purge needs an interactive terminal."
    read -rp "This DELETES all Crawlytics data volumes. Type 'purge' to confirm: " confirm < /dev/tty
    [ "${confirm}" = "purge" ] || die "Aborted."
    compose down -v
    log "Purged stack and data volumes."
    exit 0
    ;;
  --upgrade|"" )
    : # fall through to install/upgrade
    ;;
  -h|--help)
    sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    die "Unknown option: $1 (try --help)"
    ;;
esac

require_docker
write_env_if_absent
DOMAIN="$(get_env CRAWLYTICS_DOMAIN)"
[ -n "${DOMAIN}" ] || die "CRAWLYTICS_DOMAIN missing from .env"

preflight_ports
preflight_dns "${DOMAIN}"

log "Fetching base images…"
compose pull --quiet caddy clickhouse 2>/dev/null || true
log "Building the app image (first run takes a few minutes)…"
compose build app
log "Starting the stack…"
compose up -d

log "Waiting for the app to become healthy…"
for _ in $(seq 1 30); do
  if compose ps app | grep -q "healthy"; then break; fi
  sleep 2
done

cat <<EOF

$(log "Crawlytics is up.")
  Dashboard:  https://${DOMAIN}
  Next steps: open the dashboard, enter your license key, then add a site in Setup.
  Caddy issues the TLS certificate on first request — the first load may take a few seconds.
  Logs:       docker compose -p ${PROJECT} -f compose.prod.yml -f compose.tls.yml logs -f
EOF
