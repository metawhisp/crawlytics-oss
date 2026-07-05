# Crawlytics

**Self-hosted analytics for the AI traffic to your site** — like Google Analytics, but for AI crawlers.

Crawlytics classifies AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Bytespider, …),
tells verified bots from spoofed ones, tracks AI-assistant referrals (humans arriving from
ChatGPT / Perplexity / …), and shows per-page daily trends plus a **crawled → surfaced → clicked**
funnel. It runs entirely on your own server — your data never leaves it.

## Quick start (Docker)

```sh
git clone https://github.com/metawhisp/crawlytics-oss.git
cd crawlytics-oss/deploy
cp .env.example .env
# edit .env — set CLICKHOUSE_PASSWORD, TC_DASHBOARD_PASSWORD and TC_IP_HASH_SECRET
# to long random strings
docker compose -f compose.yml --env-file .env up -d
```

Open the dashboard at `http://localhost:3000` and log in with `TC_DASHBOARD_PASSWORD`.
For a public instance with automatic HTTPS use `deploy/compose.tls.yml` (Caddy) + `deploy/install.sh`
and set `CRAWLYTICS_DOMAIN` in `.env`.

## Getting data in (sensors)

AI crawlers don't execute JavaScript, so a client-side script can't see them — capture requests
**server-side** and send them to `POST /api/ingest`:

| Sensor | Package | Use for |
| --- | --- | --- |
| Log tail | `packages/ingest-cli` | any stack with nginx / Apache access logs |
| Node / Express / Next.js | `packages/sensor-node` | Node backends |
| Cloudflare Worker | `packages/sensor-cloudflare` | sites behind Cloudflare |

See [`docs/sensors.md`](docs/sensors.md) and the [`examples/`](examples) folder.

## What's inside

- `apps/server` — Fastify: ingest, query APIs, auth, serves the dashboard SPA.
- `apps/web` — React dashboard SPA.
- `packages/detector` — pure-TypeScript bot classification core.
- `packages/registry` — bot registry compiler (built from MIT-licensed sources, see `NOTICE`).
- `packages/ingest-cli` — log import / tail CLI.
- `packages/sensor-node`, `packages/sensor-cloudflare` — sensors.
- `packages/shared` — shared schemas and types.
- `deploy` — Docker Compose files + one-command install.

## Develop

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

## License

[AGPL-3.0](LICENSE). You can self-host freely. If you run a **modified** version as a
network service, you must offer its source to your users. Would rather not self-host?
A managed hosted version is available.
