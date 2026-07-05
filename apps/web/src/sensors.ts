/**
 * Sensor snippet generators (F1.5). Pure string builders so the wizard can show
 * a ready-to-run command with the site's ingest key + URL baked in. Both target
 * the same ingest contract as the published sensors — keep them faithful.
 */

export type Sensor = "curl" | "cloudflare";

/** A one-shot curl that posts a sample GPTBot hit — proves the pipe instantly. */
export function curlSnippet(ingestUrl: string, key: string): string {
  const ts = new Date().toISOString();
  const payload = JSON.stringify({
    events: [
      { ts, ip: "203.0.113.10", method: "GET", path: "/", status: 200, bytes: 1024, ua: "GPTBot/1.3", referer: "" }
    ]
  });
  return [
    `curl -X POST "${ingestUrl}" \\`,
    `  -H "authorization: Bearer ${key}" \\`,
    `  -H "content-type: application/json" \\`,
    `  -d '${payload}'`
  ].join("\n");
}

/**
 * Cloudflare Worker sensor, faithful to packages/sensor-cloudflare: pass the
 * origin through untouched, report in the background via ctx.waitUntil, never
 * report ingest traffic itself, and fail open so it can never break the site.
 */
export function workerSnippet(ingestUrl: string, key: string): string {
  return `// Crawlytics sensor — paste into a new Cloudflare Worker, then add a route your-domain.com/*
export default {
  async fetch(request, env, ctx) {
    const start = Date.now();
    const response = await fetch(request); // origin passes through untouched
    try {
      const url = new URL(request.url);
      const INGEST = "${ingestUrl}";
      if (url.host !== new URL(INGEST).host) { // never report ingest traffic itself
        const cf = request.cf || {};
        const event = {
          ts: new Date(start).toISOString(),
          ip: request.headers.get("cf-connecting-ip") || "0.0.0.0",
          method: request.method,
          path: url.pathname + url.search,
          status: response.status,
          bytes: Number(response.headers.get("content-length")) || 0,
          ua: request.headers.get("user-agent") || "",
          referer: request.headers.get("referer") || "",
          responseMs: Math.max(0, Date.now() - start),
          ...(cf.country ? { country: cf.country } : {}),
          ...(cf.asn ? { asn: cf.asn } : {}),
          ...(cf.asOrganization ? { asOrg: String(cf.asOrganization).slice(0, 256) } : {})
        };
        ctx.waitUntil(
          fetch(INGEST, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer ${key}" },
            body: JSON.stringify({ events: [event] })
          }).catch(() => {})
        ); // fail-open: analytics must never break or slow the site
      }
    } catch {}
    return response;
  }
};`;
}
