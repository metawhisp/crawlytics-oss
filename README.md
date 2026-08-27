# Crawlytics

**Self-hosted analytics for the AI traffic to your site** — like Google Analytics, but for AI crawlers.

Crawlytics reads your own server logs. It classifies AI crawlers (GPTBot, ClaudeBot,
PerplexityBot, Google-Extended, Bytespider, …), checks published IP ranges and reverse-DNS
records to tell verified bots from forged ones, tracks AI-assistant referrals (humans
arriving from ChatGPT / Perplexity / …), and shows which pages AI actually fetches, which
ones break for it, and which ones it has never seen. It runs entirely on your own server —
your data never leaves it.

## Quick start (Docker)

```sh
git clone https://github.com/metawhisp/crawlytics-oss.git
cd crawlytics-oss/deploy
cp .env.example .env
# edit .env — set CLICKHOUSE_PASSWORD, TC_DASHBOARD_PASSWORD and TC_IP_HASH_SECRET
# to long random strings
docker compose -f compose.yml --env-file .env up -d
```

The first run builds the image from this checkout; there is nothing to pull.
Open the dashboard at `http://localhost:3000` and log in with `TC_DASHBOARD_PASSWORD`.
For a public instance with automatic HTTPS use `deploy/install.sh` (Caddy) and set
`CRAWLYTICS_DOMAIN` in `.env`.

## Getting data in (sensors)

AI crawlers don't execute JavaScript, so a client-side script can't see them — capture requests
**server-side** and send them to `POST /api/ingest`:

| Sensor | Package | Use for |
| --- | --- | --- |
| Log tail | `packages/ingest-cli` | any stack with nginx / Apache access logs |
| Node / Express / Next.js | `packages/sensor-node` | Node backends |
| Cloudflare Worker | `packages/sensor-cloudflare` | sites behind Cloudflare |

See [`docs/sensors.md`](docs/sensors.md) and the [`examples/`](examples) folder.

## Ask your own data through MCP

The server speaks the Model Context Protocol, so an assistant can query your traffic
directly. Read-only, scoped to one site by the key:

```sh
claude mcp add --transport http crawlytics https://your-instance/mcp \
  --header "Authorization: Bearer cwr_your_read_key"
```

Create the key in **Setup → MCP** in the dashboard.

## What the numbers mean, and what they don't

Everything here is measured from your logs rather than sampled prompts. That also bounds
what each panel can honestly claim, so the bounds are stated instead of hidden.

- **Forged bots are excluded from the AI panels.** Anyone can send `ChatGPT-User` as a
  user-agent. Where a vendor publishes IP ranges or reverse-DNS records, Crawlytics checks
  them and marks the request `verified` or `spoofed`; spoofed traffic is kept out of
  citations, landing pages, crawl health and crawls-per-vendor. It stays visible in the
  Security tab, which is what that tab is for.
- **Some crawlers cannot be verified at all.** Several vendors publish no ranges and no PTR
  records, so their requests are marked `unverified` — neither proof of forgery nor proof of
  authenticity. They are counted, and labelled as such.
- **`human` means "user-agent not recognised", not "a person".** The classifier files
  anything it cannot identify there, and on a public site much of it is automation wearing a
  browser string. The dashboard labels it accordingly.
- **"AI blind spots" counts browser sessions only** — sessions that also fetched a
  stylesheet, script or image, because that is what rendering a page looks like. If your
  assets are served by a CDN this instance never sees, the filter switches itself off rather
  than empty the panel.
- **Bot classes are channels, not stages.** `ai_training`, `ai_search` and `ai_fetcher`
  label the bot that made a request. They are disjoint, so a page can receive AI referral
  clicks with zero recorded crawls; nothing in the UI presents them as a funnel.

## What's inside

- `apps/server` — Fastify: ingest, query APIs, MCP endpoint, auth, serves the dashboard SPA.
- `apps/web` — React dashboard SPA.
- `packages/detector` — pure-TypeScript bot classification and verification core.
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

Panel behaviour is covered by an integration suite that runs the real queries against a
throwaway ClickHouse container (needs Docker; binds to 127.0.0.1 only):

```sh
pnpm --filter @crawlytics/server test:integration
```

## License

[AGPL-3.0](LICENSE). You can self-host freely. If you run a **modified** version as a
network service, you must offer its source to your users. Would rather not self-host?
A managed hosted version is available.
