# Crawlytics

Crawlytics is a self-hosted analytics product for inbound AI traffic. It ingests web server logs and edge or middleware events, classifies AI crawlers and AI assistant referrals, verifies known bots, and exposes multi-site dashboards.

Source planning documents are kept in the numbered Markdown files in the repository root.

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
