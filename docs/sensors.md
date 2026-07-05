# Sending data to Crawlytics (sensors)

A **sensor** observes requests to your site and reports them to your Crawlytics
ingest endpoint. The dashboard's **Setup** wizard generates a ready-to-paste
snippet (with your ingest key + URL filled in) for the options below — start
there. This page is the reference.

## Why a pixel won't work

AI crawlers (GPTBot, ClaudeBot, CCBot, PerplexityBot, …) fetch raw HTML and do
**not** execute JavaScript. A `<script>` tag pasted into a page only fires in real
browsers, so it cannot see server-side AI crawlers. To capture them you must be in
the request path — at the **edge** (a CDN worker) or on the **server** (middleware
or logs).

## Options

### 1. Cloudflare Worker — for any site already on Cloudflare

Best option for sites whose traffic already goes through Cloudflare (including
**Webflow sites that are on Cloudflare**). The Worker passes every request through
to your origin untouched and reports it in the background. It is **fail-open**: if
reporting fails, your site is unaffected.

1. In the dashboard: **Setup → add site → generate ingest key → Cloudflare Worker**.
2. Paste the generated script into a new Worker in your Cloudflare dashboard.
3. Add a route `your-domain.com/*` to that Worker.

Done — the Worker reports AI crawlers, humans, and AI-referral traffic, with
Cloudflare's country/ASN attached.

> **Webflow not yet on Cloudflare?** Moving a Webflow site behind Cloudflare uses
> Cloudflare's **Orange-to-Orange (O2O)** mode; done wrong it breaks SSL (error
> 525). That guided migration is on the roadmap — for now, this path is for sites
> already on Cloudflare.

### 2. Server log tail — for any server you control

If you run your own web server (nginx, Apache, …), the CLI tails or imports access
logs and posts events. No code changes to your app. It handles log rotation and
batches uploads.

### 3. Node / Express middleware — for Node apps

Drop-in middleware that reports each request in the background, fail-open. Add it
once near the top of your middleware chain.

### 4. curl test event — prove the pipe in 5 seconds

The wizard also gives a one-line `curl` that posts a sample GPTBot hit, so you can
confirm ingest is working before installing a real sensor — **Setup** shows
"✓ events received" as soon as it lands.

## What a sensor sends (privacy)

A minimal request record: timestamp, method, **path without the query string**,
status, bytes, user-agent, and the **referer reduced to its origin**. Crawlytics
hashes human visitor IPs daily and stores a raw IP **only for detected bots**
(needed for spoof detection). Query strings and full referer URLs are dropped
before storage, so tokens / emails / search terms in URLs are never persisted.
