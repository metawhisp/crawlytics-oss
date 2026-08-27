#!/usr/bin/env bash
# Boots the real dashboard against the integration fixture so panels can be
# eyeballed. LOOPBACK ONLY — this has no license gate and no password, so it
# must never be published or bound to anything but 127.0.0.1.
#
#   pnpm --filter @crawlytics/server preview
#
# Ctrl-C stops the server; the ClickHouse container is removed on exit.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
server="$(dirname "$here")"
web_dist="$(dirname "$server")/web/dist"

ch_port="${CH_PORT:-18123}"
app_port="${PREVIEW_PORT:-18080}"
name="crawlytics-preview"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ ! -d "$web_dist" ]; then
  echo "build the SPA first: pnpm --filter @crawlytics/web build" >&2
  exit 1
fi

cleanup
docker run -d --rm --name "$name" \
  -p "127.0.0.1:${ch_port}:8123" \
  -e CLICKHOUSE_DB=crawlytics_it \
  -e CLICKHOUSE_USER=crawlytics_it \
  -e CLICKHOUSE_PASSWORD=crawlytics_it \
  -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
  clickhouse/clickhouse-server:25.5-alpine >/dev/null

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:${ch_port}/ping" >/dev/null 2>&1 && break
  sleep 0.5
done

bundle="$server/node_modules/.cache/preview.mjs"
mkdir -p "$(dirname "$bundle")"
"$server/node_modules/.bin/esbuild" "$here/preview.ts" \
  --bundle --platform=node --format=esm --packages=external --outfile="$bundle" >/dev/null

CH_URL="http://127.0.0.1:${ch_port}" \
PREVIEW_PORT="$app_port" \
MIGRATIONS_DIR="$server/migrations/" \
PUBLIC_DIR="$web_dist" \
  node "$bundle"
