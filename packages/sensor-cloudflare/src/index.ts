/**
 * Crawlytics Cloudflare Worker sensor.
 *
 * Deployed on a zone route (example.com/*): passes every request through to
 * the origin untouched and reports it to the Crawlytics ingest API in the
 * background via ctx.waitUntil. Strictly fail-open — no sensor error may ever
 * affect the site.
 */

export interface SensorEnv {
  /** Crawlytics base URL, e.g. https://analytics.example.com */
  TRACECONTROL_URL: string;
  /** Ingest API key for this site. */
  TRACECONTROL_KEY: string;
}

/** Minimal slice of the Workers runtime we rely on (keeps the package dependency-free). */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): unknown;
}

interface RawIngestEvent {
  ts: string;
  ip: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  ua: string;
  referer: string;
  responseMs: number;
  country?: string;
  asn?: number;
  asOrg?: string;
}

/** Cloudflare attaches geo/network info to every request. */
interface CfRequestInfo {
  country?: string;
  asn?: number;
  asOrganization?: string;
}

export function buildEvent(
  request: Request,
  response: Response,
  startMs: number,
  endMs: number
): RawIngestEvent {
  const url = new URL(request.url);
  const event: RawIngestEvent = {
    ts: new Date(startMs).toISOString(),
    ip: request.headers.get("cf-connecting-ip") ?? "0.0.0.0",
    method: request.method,
    path: `${url.pathname}${url.search}`,
    status: response.status,
    bytes: parsePositiveInt(response.headers.get("content-length")),
    ua: request.headers.get("user-agent") ?? "",
    referer: request.headers.get("referer") ?? "",
    responseMs: Math.max(0, endMs - startMs)
  };

  const cf = (request as Request & { cf?: CfRequestInfo }).cf;
  if (cf) {
    if (typeof cf.country === "string" && cf.country.length === 2) {
      event.country = cf.country;
    }
    if (typeof cf.asn === "number") {
      event.asn = cf.asn;
    }
    if (typeof cf.asOrganization === "string" && cf.asOrganization) {
      event.asOrg = cf.asOrganization.slice(0, 256);
    }
  }
  return event;
}

export async function report(
  request: Request,
  response: Response,
  startMs: number,
  env: SensorEnv
): Promise<void> {
  try {
    const event = buildEvent(request, response, startMs, Date.now());
    await fetch(`${env.TRACECONTROL_URL}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.TRACECONTROL_KEY}`
      },
      body: JSON.stringify({ events: [event] })
    });
  } catch {
    // fail-open: analytics must never break or slow the site
  }
}

const worker = {
  async fetch(request: Request, env: SensorEnv, ctx: ExecutionContextLike): Promise<Response> {
    const startMs = Date.now();

    // origin failures propagate untouched — the sensor only observes
    const response = await fetch(request);

    try {
      if (!isOwnIngestTraffic(request, env)) {
        ctx.waitUntil(report(request, response.clone(), startMs, env));
      }
    } catch {
      // fail-open
    }

    return response;
  }
};

export default worker;

/** Guards against self-reporting loops if the worker route covers the ingest host. */
function isOwnIngestTraffic(request: Request, env: SensorEnv): boolean {
  try {
    return new URL(request.url).host === new URL(env.TRACECONTROL_URL).host;
  } catch {
    return false;
  }
}

function parsePositiveInt(value: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
