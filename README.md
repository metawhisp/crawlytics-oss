# Crawlytics

**Grow the readers who arrive from ChatGPT, Perplexity and the rest — starting
with which of them actually send you any.**

AI assistants read your site, and sometimes send a human back to it afterwards.
Some vendors return readers. Some take thousands of pages and return nobody. The
analytics you already run cannot tell those two apart: the crawl and the visit
happen hours apart, under different names, with nothing joining them up.

Crawlytics joins them up. For every vendor it sets what it took — crawls —
against what it sent back — humans arriving from that vendor's assistant — and
turns that into one comparable price: *one reader per so many crawls*. With that
in hand you can spend your effort on the assistants that return readers, and
stop paying to feed the ones that never do.

It is self-hosted: it ingests your web server logs and edge or middleware
events, classifies AI crawlers and AI assistant referrals, verifies known bots,
and runs multi-site dashboards. Your logs stay on your server.

## Install

One command on your own host, behind automatic HTTPS:

```sh
cd deploy && ./install.sh
```

It asks for a domain and an email, generates its own secrets, brings up the app
and ClickHouse behind Caddy, and issues a TLS certificate on first request. Then
open the dashboard, sign in with the password it set, and add a site under
**Setup** — the wizard hands you the snippet for your sensor and flips to a tick
of its own accord when the first events arrive.

Full operations guide, upgrades and backups: [deploy/README.md](deploy/README.md).
Sensor options (Cloudflare Worker, Node middleware, log tailer):
[docs/sensors.md](docs/sensors.md).

### Ask your own data a question

Crawlytics speaks MCP, so Claude (or any MCP client) can query it directly with a
read-only key scoped to one site — 13 tools over the same API the dashboard uses.
The **Setup** tab generates the key and the client config.

## Workspace

- `apps/server` - Fastify app for ingest, query APIs, auth, cron jobs, and serving the SPA.
- `apps/web` - React dashboard SPA.
- `packages/detector` - pure TypeScript classification core.
- `packages/registry` - bot registry compiler.
- `packages/ingest-cli` - log import and tail CLI.
- `packages/sensor-cloudflare` - Cloudflare Worker sensor.
- `packages/sensor-node` - Next.js and Express middleware sensor.
- `packages/shared` - shared schemas and types.
- `deploy` - self-host deployment assets.

## Commands

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
docker compose -f deploy/compose.yml --env-file deploy/.env.example config
```

Panel behaviour is covered by an integration suite that runs the real queries
against a throwaway ClickHouse container (needs Docker; binds to 127.0.0.1 only):

```sh
pnpm --filter @crawlytics/server test:integration
```

## What the numbers mean, and what they don't

Every panel is measured from your own logs. That also means each one is bounded
by what a log can prove, so the boundaries are stated rather than hidden.

- **Forged bots are excluded from AI panels.** Anyone can send `ChatGPT-User` as
  a user-agent. Where a vendor publishes IP ranges or reverse-DNS records,
  Crawlytics checks them and marks the request `verified` or `spoofed`; spoofed
  traffic is kept out of retrieval, landing pages, crawl health and
  crawls-per-vendor. It is still visible in the Security tab, which is what that
  tab is for.
- **Some crawlers cannot be verified at all.** Several vendors publish no ranges
  and no PTR records, so their requests are marked `unverified` — not proof of
  forgery, not proof of authenticity. They are counted, and labelled as such.
- **`human` means "user-agent not recognised", not "a person".** The classifier
  files anything it cannot identify there, and on a public site much of it is
  automation wearing a browser string. The dashboard labels it accordingly.
- **"AI blind spots" counts browser sessions only** — sessions that also fetched
  a stylesheet, script or image, because that is what rendering a page looks
  like. If your assets are served by a CDN this instance never sees, the filter
  switches itself off rather than empty the panel.
- **Bot classes are channels, not stages.** `ai_training`, `ai_search` and
  `ai_fetcher` label the bot that made a request. They are disjoint, so a page
  can receive AI referral clicks with zero recorded crawls; nothing in the UI
  presents them as a funnel.
- **A retrieval is not a citation.** A log can show that an assistant's fetcher
  requested a page. Whether the answer then linked to it, quoted it, or ignored
  it never reaches your server, so no panel claims a citation. The one signal
  that a link was actually shown is a human arriving with an assistant as the
  referrer — and a referrer is set by the visitor's browser, so it is evidence,
  not proof.
- **Verification is "not marked forged", not "proven genuine".** Several
  retrieval bots are checked against a vendor IP list with no reverse-DNS
  fallback, and a stale list is used rather than none. A lagging list can mark a
  real bot as spoofed, which keeps it out of the AI panels until the list
  catches up.

## License

GNU Affero General Public License v3.0 — see [LICENSE](LICENSE).

You may use, modify and self-host this, including commercially, and the licence
asks you to keep the copyright notices in [NOTICE](NOTICE). The part that
distinguishes AGPL from a permissive licence is section 13: if you run a
modified version as a service other people reach over a network, you have to
offer those users the source of your version.
