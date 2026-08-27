import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";

import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { loadCompiledBots } from "@crawlytics/registry";
import type { BotRegistryEntry } from "@crawlytics/registry";
import { ingestBatchSchema } from "@crawlytics/shared";
import type { RawLogEvent } from "@crawlytics/shared";

import { DEFAULT_ALERTS_CONFIG } from "./alerts/config.js";
import { deliverWebhook } from "./alerts/deliver.js";
import { exploreQuery } from "./explore.js";
import type { ChQueryClientLike } from "./explore.js";
import { verifyTrustedLicense } from "./license.js";
import { MCP_SUPPORTED_PROTOCOL_VERSIONS, handleMcpPayload } from "./mcp/protocol.js";
import type { McpToolContext } from "./mcp/tools.js";
import type { MetadataStore } from "./metadata/index.js";
import { buildLlmsTxt, buildRobotsTxt } from "./robots.js";
import { toCsv } from "./stats.js";
import type { StatsStore } from "./stats.js";

export interface BatcherLike {
  push(siteId: string, events: RawLogEvent[]): boolean;
  readonly size: number;
}

export interface AppOptions {
  /** Metadata store; ingest keys resolve to site ids through it. */
  metadata: MetadataStore;
  batcher: BatcherLike;
  /** Dashboard query layer; dashboard routes are disabled when absent. */
  stats?: StatsStore;
  /** Raw ClickHouse client for the Explore breakdown builder. */
  chClient?: ChQueryClientLike;
  /** Dashboard password. When unset, the dashboard API is open (local dev). */
  dashboardPassword?: string;
  /** Whether a valid license currently unlocks the dashboard data (/api/v1). Mutable at runtime via POST /api/license. Default false. */
  dashboardEnabled?: boolean;
  /**
   * Whether to serve the dashboard shell (SPA + /api/session + /api/license)
   * even while unlicensed, so a user can enter a key in the UI. The full image
   * sets this true; the headless OSS image leaves it false (no SPA, no
   * session/login oracle). Defaults to {@link dashboardEnabled}.
   */
  serveDashboard?: boolean;
  /** Production flag — when recomputing the gate after a UI license unlock, production additionally requires a password (fail-closed). Default false. */
  isProduction?: boolean;
  /** Non-production dev override for the gate recompute. Default false. */
  devOverride?: boolean;
  /** Trust anchor (SPKI PEM) for verifying UI-submitted license keys. Defaults to the baked production key. */
  licensePublicKey?: string;
  /** Directory with the built SPA (served at /). */
  publicDir?: string;
  /** Readiness probe (e.g. ClickHouse ping); /readyz returns 503 when it resolves false. */
  checkReady?: () => Promise<boolean>;
  /** Bot registry for the robots.txt/llms.txt generator. Defaults to the compiled registry. */
  bots?: BotRegistryEntry[];
  /** Per-read-key request cap for POST /mcp, per minute. Default 120. */
  mcpRateLimitPerMinute?: number;
  logger?: boolean;
}

const SESSION_COOKIE = "tc_session";

const windowQuerySchema = z.object({
  site: z.string().min(1).max(200),
  hours: z.coerce.number().int().min(1).max(8760)
});

const pagesQuerySchema = windowQuerySchema.extend({
  q: z.string().max(200).default("")
});

const exportQuerySchema = windowQuerySchema.extend({
  table: z.enum(["bots", "pages", "security", "citations", "funnels"]),
  /** Day-windowed tables (citations/funnels) use this; hour-windowed ones ignore it. */
  days: z.coerce.number().int().min(1).max(365).default(30)
});

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 10 * 1024 * 1024 });
  // dashboardEnabled is the live license gate — it flips at runtime when a valid
  // key is submitted to POST /api/license, unlocking the data API without a
  // restart. serveDashboard (boot-fixed) decides whether the shell exists at all.
  const initialEnabled = options.dashboardEnabled ?? false;
  let dashboardEnabled = initialEnabled;
  const serveDashboard = options.serveDashboard ?? initialEnabled;
  const hasPassword = Boolean(options.dashboardPassword);
  const isProduction = options.isProduction ?? false;
  const devOverride = options.devOverride ?? false;
  // Random per-process session secret — NOT derived from the password — so each
  // session cookie is a signed token carrying its own expiry, and all sessions
  // can be revoked at once by rotating this secret (on logout). A restart also
  // invalidates outstanding sessions. `let` so logout can rotate it.
  let sessionSecret = randomBytes(32);
  const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

  void app.register(fastifyCookie);
  // The SPA is served whenever the shell is served (full image), licensed or not,
  // so an unlicensed instance can still render the license-entry screen. The SPA
  // picks its screen from /api/session; the data API stays gated by the license.
  if (serveDashboard && options.publicDir && existsSync(options.publicDir)) {
    void app.register(fastifyStatic, { root: options.publicDir, wildcard: true });
  }

  let acceptedEvents = 0;
  let acceptedBatches = 0;
  let rejectedRequests = 0;
  let lastIngestAt: string | null = null;
  // Per-site accepted-ingest, for the onboarding "is it working?" check. In-memory
  // (resets on restart) — the live signal that a freshly-installed sensor reached us.
  const siteIngest = new Map<string, { at: string; count: number }>();

  app.get("/healthz", () => ({
    ok: true,
    buffered: options.batcher.size,
    acceptedEvents,
    acceptedBatches,
    rejectedRequests,
    lastIngestAt
  }));

  app.get("/readyz", async (_request, reply) => {
    let ready = true;
    if (options.checkReady) {
      try {
        ready = await options.checkReady();
      } catch {
        ready = false;
      }
    }
    return reply.code(ready ? 200 : 503).send({ ready });
  });

  app.post("/api/ingest", async (request, reply) => {
    const header = request.headers.authorization;
    const key = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const siteId = key ? await options.metadata.resolveIngestKey(key) : null;
    if (!siteId) {
      rejectedRequests += 1;
      return reply.code(401).send({ error: "invalid or missing API key" });
    }

    const parsed = ingestBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      rejectedRequests += 1;
      return reply.code(400).send({ error: "invalid payload", issues: parsed.error.issues.slice(0, 5) });
    }

    if (!options.batcher.push(siteId, parsed.data.events)) {
      rejectedRequests += 1;
      return reply.code(429).send({ error: "ingest buffer full, retry later" });
    }

    const now = new Date().toISOString();
    acceptedEvents += parsed.data.events.length;
    acceptedBatches += 1;
    lastIngestAt = now;
    const prior = siteIngest.get(siteId);
    siteIngest.set(siteId, { at: now, count: (prior?.count ?? 0) + parsed.data.events.length });
    return reply.code(202).send({ accepted: parsed.data.events.length });
  });

  // In-memory brute-force backstop for the single shared dashboard password:
  // after LOGIN_MAX_FAILS wrong attempts from one client within the window, that
  // client is locked out until the window elapses. A successful login clears it.
  // This is defence-in-depth behind nginx/Cloudflare — the dashboard is no longer
  // reachable directly, so the client IP comes from the proxy's forwarding header.
  const LOGIN_MAX_FAILS = 10;
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_MAX_TRACKED = 10_000;
  const loginFails = new Map<string, { count: number; first: number }>();

  // The app is bound to loopback and reachable ONLY through the reverse proxy, so
  // request.ip is always the proxy itself. The real client IP must come from a
  // header the proxy OVERWRITES (not appends) — otherwise a client could spoof it
  // to dodge the lockout or lock out the owner. Contract: nginx sets
  // `proxy_set_header X-Real-IP $remote_addr;` (and behind Cloudflare uses
  // `real_ip_header CF-Connecting-IP`). We therefore trust ONLY X-Real-IP and do
  // NOT trust X-Forwarded-For (nginx appends to it, so its leftmost entry is
  // attacker-controlled). Absent the header we fall back to request.ip, which
  // safely degrades the limiter to a single un-spoofable global bucket.
  function clientIp(request: FastifyRequest): string {
    const real = request.headers["x-real-ip"];
    if (typeof real === "string" && real.length > 0 && real.length <= 64) {
      return real.trim();
    }
    return request.ip;
  }

  // Returns seconds to wait if the client is currently locked out, else 0.
  function loginLockoutSeconds(ip: string, now: number): number {
    const entry = loginFails.get(ip);
    if (!entry) {
      return 0;
    }
    if (now - entry.first >= LOGIN_WINDOW_MS) {
      loginFails.delete(ip);
      return 0;
    }
    if (entry.count >= LOGIN_MAX_FAILS) {
      return Math.ceil((entry.first + LOGIN_WINDOW_MS - now) / 1000);
    }
    return 0;
  }

  function recordLoginFail(ip: string, now: number): void {
    const entry = loginFails.get(ip);
    if (!entry || now - entry.first >= LOGIN_WINDOW_MS) {
      loginFails.set(ip, { count: 1, first: now });
    } else {
      entry.count += 1;
    }
    // Bound memory under IP-rotating floods. First drop entries whose window
    // expired; if the map is still over the cap (a burst of fresh keys), evict
    // oldest-inserted entries until under it (Map preserves insertion order) so
    // it can never grow without bound.
    if (loginFails.size > LOGIN_MAX_TRACKED) {
      for (const [key, value] of loginFails) {
        if (now - value.first >= LOGIN_WINDOW_MS) {
          loginFails.delete(key);
        }
      }
      while (loginFails.size > LOGIN_MAX_TRACKED) {
        const oldest = loginFails.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        loginFails.delete(oldest);
      }
    }
  }

  function isAuthed(request: FastifyRequest): boolean {
    if (!hasPassword) {
      return true;
    }
    const cookie = request.cookies[SESSION_COOKIE];
    return typeof cookie === "string" && verifySessionToken(sessionSecret, cookie, Date.now());
  }

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    if (isAuthed(request)) {
      return true;
    }
    void reply.code(401).send({ error: "login required" });
    return false;
  }

  // Shared by the robots.txt generator route and the MCP tools; loaded lazily so
  // a headless/ingest-only server never pays for the registry.
  let registryBots: BotRegistryEntry[] | null = options.bots ?? null;
  const botRegistry = (): BotRegistryEntry[] => (registryBots ??= loadCompiledBots());

  if (serveDashboard) {
    // The data API (/api/v1), login and MCP are locked until a valid license is
    // present; re-checked per request so POST /api/license unlocks them live.
    // The shell (session status + license entry) stays reachable while locked.
    app.addHook("onRequest", (request, reply, done) => {
      const routeUrl = request.routeOptions.url ?? "";
      // Exact "/api/v1" or a "/api/v1/" child — NOT a sibling like "/api/v1x".
      const isData = routeUrl === "/api/v1" || routeUrl.startsWith("/api/v1/");
      if ((isData || routeUrl === "/api/login" || routeUrl === "/mcp") && !dashboardEnabled) {
        void reply.code(403).send({ error: "dashboard locked: a valid license key is required" });
        return;
      }
      done();
    });

    app.get("/api/session", (request, reply) => {
      if (!dashboardEnabled) {
        return reply.send({ dashboardEnabled: false });
      }
      if (!hasPassword) {
        return reply.send({ authed: true, passwordRequired: false, dashboardEnabled: true });
      }
      return reply.send({ authed: isAuthed(request), passwordRequired: true, dashboardEnabled: true });
    });

    app.post("/api/license", { bodyLimit: 8192 }, async (request, reply) => {
      // While locked, anyone holding the owner's valid key can unlock (first-run
      // setup, no session exists yet). Once enabled, replacing the stored key
      // requires dashboard auth, so a third party with some other valid key
      // cannot rebind a running instance to a key that later expires.
      if (dashboardEnabled && !requireAuth(request, reply)) {
        return reply;
      }
      const body = z.object({ key: z.string().min(1).max(4096) }).safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "a license key is required" });
      }
      const info = verifyTrustedLicense(body.data.key, options.licensePublicKey);
      if (!info.valid) {
        return reply.code(400).send({ error: info.reason ?? "invalid license" });
      }
      await options.metadata.setLicenseKey(body.data.key);
      dashboardEnabled = resolveDashboardEnabled({ licensed: true, hasPassword, isProduction, devOverride });
      return reply.send({
        ok: true,
        dashboardEnabled,
        ...(info.tier !== undefined ? { tier: info.tier } : {}),
        ...(dashboardEnabled
          ? {}
          : { note: "license valid — set a dashboard password to serve the dashboard in production" })
      });
    });

    app.post("/api/login", { bodyLimit: 1024 }, async (request, reply) => {
      if (!options.dashboardPassword) {
        return reply.code(200).send({ ok: true });
      }
      const ip = clientIp(request);
      const now = Date.now();
      const lockedFor = loginLockoutSeconds(ip, now);
      if (lockedFor > 0) {
        return reply.code(429).header("retry-after", String(lockedFor)).send({ error: "too many attempts" });
      }
      const body = z.object({ password: z.string().max(256) }).safeParse(request.body);
      if (!body.success || !safeEqual(body.data.password, options.dashboardPassword)) {
        recordLoginFail(ip, now);
        return reply.code(401).send({ error: "wrong password" });
      }
      loginFails.delete(ip); // a correct password clears the lockout counter
      // Issue a fresh, expiring, signed session token (rotates on every login).
      const token = issueSessionToken(sessionSecret, now, SESSION_TTL_MS, randomBytes(9).toString("base64url"));
      return reply
        .setCookie(SESSION_COOKIE, token, {
          path: "/",
          httpOnly: true,
          sameSite: "strict",
          secure: isProduction,
          maxAge: Math.floor(SESSION_TTL_MS / 1000)
        })
        .send({ ok: true });
    });

    app.post("/api/logout", (request, reply) => {
      // Rotating the secret invalidates EVERY outstanding session — including a
      // stolen cookie — not just the caller's. Require auth so an anonymous
      // attacker cannot force-logout the owner.
      if (hasPassword && !requireAuth(request, reply)) {
        return reply;
      }
      sessionSecret = randomBytes(32);
      return reply.clearCookie(SESSION_COOKIE, { path: "/" }).send({ ok: true });
    });

    // Onboarding (management) API — under /api/v1 so the license hook gates it,
    // plus dashboard auth. Backed by the metadata store; no ClickHouse needed.
    const siteIdSchema = z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
    const siteIdParam = (request: FastifyRequest): string | null =>
      siteIdSchema.safeParse((request.params as { id?: string }).id).data ?? null;

    app.get("/api/v1/sites", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      return reply.send({ sites: await options.metadata.listSites() });
    });

    app.post("/api/v1/sites", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const body = z.object({ id: siteIdSchema, domain: z.string().max(253).optional() }).safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid site id" });
      }
      const { id, domain } = body.data;
      const site = await options.metadata.createSite({ id, ...(domain !== undefined ? { domain } : {}) });
      return reply.code(201).send(site);
    });

    app.get("/api/v1/sites/:id/keys", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const id = siteIdParam(request);
      if (id === null) {
        return reply.code(400).send({ error: "invalid site id" });
      }
      if ((await options.metadata.getSite(id)) === null) {
        return reply.code(404).send({ error: "unknown site" });
      }
      return reply.send({ keys: await options.metadata.listKeys(id) });
    });

    app.post("/api/v1/sites/:id/keys", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const id = siteIdParam(request);
      if (id === null) {
        return reply.code(400).send({ error: "invalid site id" });
      }
      const body = z.object({ scope: z.enum(["ingest", "read"]) }).safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "scope must be 'ingest' or 'read'" });
      }
      if ((await options.metadata.getSite(id)) === null) {
        return reply.code(404).send({ error: "unknown site" });
      }
      const key = await options.metadata.createKey({ siteId: id, scope: body.data.scope });
      return reply.code(201).send(key);
    });

    app.post("/api/v1/sites/:id/keys/revoke", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const id = siteIdParam(request);
      if (id === null) {
        return reply.code(400).send({ error: "invalid site id" });
      }
      if ((await options.metadata.getSite(id)) === null) {
        return reply.code(404).send({ error: "unknown site" });
      }
      const body = z.object({ key: z.string().min(1).max(200) }).safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "a key is required" });
      }
      // Bind revocation to the site in the path: only revoke a key that belongs
      // to it, so /sites/:id/keys/revoke cannot drop another site's key.
      const owned = (await options.metadata.listKeys(id)).some((entry) => entry.key === body.data.key);
      if (!owned) {
        return reply.send({ revoked: false });
      }
      return reply.send({ revoked: await options.metadata.revokeKey(body.data.key) });
    });

    app.get("/api/v1/sites/:id/status", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const id = siteIdParam(request);
      if (id === null) {
        return reply.code(400).send({ error: "invalid site id" });
      }
      if ((await options.metadata.getSite(id)) === null) {
        return reply.code(404).send({ error: "unknown site" });
      }
      const seen = siteIngest.get(id);
      return reply.send({ lastEventAt: seen?.at ?? null, recentEvents: seen?.count ?? 0 });
    });

    // Suggested robots.txt / llms.txt from the bot registry. Garbage policy
    // values fall back to the safe defaults (deny training, allow search/fetch)
    // instead of erroring — this is a generator, not a validator.
    const policySchema = z.object({
      site: z.string().min(1).max(200),
      train: z.enum(["allow", "deny"]).catch("deny"),
      search: z.enum(["allow", "deny"]).catch("allow"),
      fetch: z.enum(["allow", "deny"]).catch("allow")
    });
    app.get("/api/v1/robots-suggestion", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const parsed = policySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid query" });
      }
      const site = await options.metadata.getSite(parsed.data.site);
      if (site === null) {
        return reply.code(404).send({ error: "unknown site" });
      }
      return reply.send({
        robotsTxt: buildRobotsTxt(botRegistry(), {
          training: parsed.data.train,
          search: parsed.data.search,
          fetch: parsed.data.fetch
        }),
        llmsTxt: buildLlmsTxt(site.domain)
      });
    });

    // Alerts config. Default OFF: webhookUrl is empty until the owner saves one —
    // the server never posts anywhere out of the box. The owner-supplied URL is
    // the only destination alerts ever go to (self-host: the owner owns both ends).
    // Deliberate tradeoff: private/localhost targets are ALLOWED — self-hosters
    // legitimately point webhooks at services on their own network, and the URL
    // is settable only by the authed dashboard owner.
    const alertsConfigSchema = z.object({
      webhookUrl: z
        .string()
        .max(2048)
        .refine((value) => value === "" || /^https?:\/\//i.test(value), "must be an http(s) URL or empty")
        .default(""),
      rules: z
        .object({
          spike: z.boolean().default(true),
          newBot: z.boolean().default(true),
          spoof: z.boolean().default(true),
          brokenCitation: z.boolean().default(true)
        })
        .default({}),
      spikeFactor: z.number().int().min(1).max(100).default(DEFAULT_ALERTS_CONFIG.spikeFactor),
      cooldownMinutes: z.number().int().min(5).max(10080).default(DEFAULT_ALERTS_CONFIG.cooldownMinutes)
    });

    app.get("/api/v1/alerts", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const config = await options.metadata.getAlertsConfig();
      return reply.send(config ?? DEFAULT_ALERTS_CONFIG);
    });

    app.put("/api/v1/alerts", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const parsed = alertsConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid config", issues: parsed.error.issues.slice(0, 5) });
      }
      // URL sanity beyond the protocol check — reject unparseable values early
      if (parsed.data.webhookUrl !== "") {
        try {
          new URL(parsed.data.webhookUrl);
        } catch {
          return reply.code(400).send({ error: "invalid webhook url" });
        }
      }
      await options.metadata.setAlertsConfig(parsed.data);
      return reply.send(parsed.data);
    });

    app.post("/api/v1/alerts/test", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const config = await options.metadata.getAlertsConfig();
      if (config === null || config.webhookUrl === "") {
        return reply.code(400).send({ error: "no webhook url configured" });
      }
      const ok = await deliverWebhook(config.webhookUrl, {
        text: "Crawlytics test alert — your webhook works.",
        rule: "test",
        site: "-",
        subject: "test"
      });
      return reply.send({ ok });
    });
  }

  if (serveDashboard && options.stats) {
    const stats = options.stats;

    // ---- MCP (Model Context Protocol) --------------------------------------
    // Lets the site owner point Claude at their own analytics. Auth is a
    // read-scoped key (cwr_…); the key alone decides which site is visible, so a
    // key can never read another tenant. Read-only by design: alert/webhook
    // config stays dashboard-only, so a leaked key cannot redirect alerts.
    const MCP_RATE_WINDOW_MS = 60_000;
    const MCP_MAX_TRACKED = 10_000;
    const mcpRateLimit = options.mcpRateLimitPerMinute ?? 120;
    // Per authenticated key, and a wider per-IP bucket in FRONT of the key
    // lookup — otherwise a flood of random keys never gets counted at all and
    // hammers the metadata store for free.
    const mcpKeyHits = new Map<string, { count: number; first: number }>();
    const mcpIpHits = new Map<string, { count: number; first: number }>();
    const MCP_IP_RATE_LIMIT = mcpRateLimit * 4;

    // Returns seconds to wait when the bucket is over budget, else 0 (and counts
    // the request). Same bounded-map discipline as the login limiter.
    function throttleSeconds(
      buckets: Map<string, { count: number; first: number }>,
      bucket: string,
      limit: number,
      now: number
    ): number {
      const entry = buckets.get(bucket);
      if (!entry || now - entry.first >= MCP_RATE_WINDOW_MS) {
        buckets.set(bucket, { count: 1, first: now });
      } else if (entry.count >= limit) {
        return Math.max(1, Math.ceil((entry.first + MCP_RATE_WINDOW_MS - now) / 1000));
      } else {
        entry.count += 1;
      }
      if (buckets.size > MCP_MAX_TRACKED) {
        for (const [tracked, value] of buckets) {
          if (now - value.first >= MCP_RATE_WINDOW_MS) {
            buckets.delete(tracked);
          }
        }
        for (const tracked of buckets.keys()) {
          if (buckets.size <= MCP_MAX_TRACKED) {
            break;
          }
          buckets.delete(tracked);
        }
      }
      return 0;
    }

    // MCP messages are small; the 10 MB global body limit exists for ingest
    // batches and has no business here.
    const MCP_BODY_LIMIT = 256 * 1024;

    // Browsers attach Origin; CLI/agent clients do not. A DNS-rebinding attack
    // arrives with our Host but a foreign Origin, so same-host is the test the
    // Streamable HTTP spec asks for. No Origin => not a browser => allowed.
    function mcpOriginAllowed(request: FastifyRequest): boolean {
      const origin = request.headers.origin;
      if (typeof origin !== "string" || origin === "") {
        return true;
      }
      try {
        return new URL(origin).host === request.headers.host;
      } catch {
        return false;
      }
    }

    app.route({
      method: "POST",
      url: "/mcp",
      bodyLimit: MCP_BODY_LIMIT,
      // onRequest runs BEFORE body parsing: an unauthenticated flood is counted
      // and cut off without spending the parser, and header-only checks answer
      // early. (Global hooks — the license gate — still run before this.)
      onRequest: (request, reply, done) => {
        const ipRetry = throttleSeconds(mcpIpHits, clientIp(request), MCP_IP_RATE_LIMIT, Date.now());
        if (ipRetry > 0) {
          void reply.code(429).header("retry-after", String(ipRetry)).send({ error: "rate limit exceeded" });
          return;
        }
        if (!mcpOriginAllowed(request)) {
          void reply.code(403).send({ error: "cross-origin requests are not allowed" });
          return;
        }
        // Post-initialize requests carry the negotiated version; refuse one we
        // did not agree to rather than answering in a shape the client cannot read.
        const declared = request.headers["mcp-protocol-version"];
        if (typeof declared === "string" && !MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(declared)) {
          void reply.code(400).send({
            error: `unsupported MCP-Protocol-Version: ${declared}`,
            supported: MCP_SUPPORTED_PROTOCOL_VERSIONS
          });
          return;
        }
        done();
      },
      handler: async (request, reply) => {
      const header = request.headers.authorization ?? "";
      const key = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
      // Read scope only: an ingest key (write-only, often pasted into a CDN
      // worker) must never be able to read analytics back out.
      const siteId = key === "" ? null : await options.metadata.resolveReadKey(key);
      if (siteId === null) {
        return reply
          .code(401)
          .header("WWW-Authenticate", 'Bearer realm="crawlytics", error="invalid_token"')
          .send({ error: "a Crawlytics read key (cwr_...) is required" });
      }
      const keyRetry = throttleSeconds(mcpKeyHits, key, mcpRateLimit, Date.now());
      if (keyRetry > 0) {
        return reply.code(429).header("retry-after", String(keyRetry)).send({ error: "rate limit exceeded" });
      }
      const ctx: McpToolContext = {
        siteId,
        stats,
        metadata: options.metadata,
        bots: botRegistry(),
        onError: (error, toolName) => {
          request.log.error({ err: error, tool: toolName, siteId }, "mcp tool failed");
        },
        ...(options.chClient ? { chClient: options.chClient } : {})
      };
      const outcome = await handleMcpPayload(request.body, ctx);
        return outcome.body === undefined
          ? reply.code(outcome.status).send()
          : reply.code(outcome.status).send(outcome.body);
      }
    });

    // No server-initiated stream and no sessions to terminate, so the optional
    // GET/DELETE halves of Streamable HTTP are declined rather than faked.
    for (const method of ["GET", "DELETE"] as const) {
      app.route({
        method,
        url: "/mcp",
        handler: (_request, reply) =>
          reply.code(405).header("allow", "POST").send({ error: "MCP over this endpoint is POST-only" })
      });
    }

    function windowParams(request: FastifyRequest, reply: FastifyReply): { site: string; hours: number } | null {
      const parsed = windowQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        void reply.code(400).send({ error: "invalid query", issues: parsed.error.issues.slice(0, 3) });
        return null;
      }
      return parsed.data;
    }

    app.get("/api/v1/overview", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const params = windowParams(request, reply);
      if (!params) {
        return reply;
      }
      return reply.send(await stats.overview(params.site, params.hours));
    });

    app.get("/api/v1/bots", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const params = windowParams(request, reply);
      if (!params) {
        return reply;
      }
      return reply.send({ bots: await stats.bots(params.site, params.hours) });
    });

    app.get("/api/v1/bot/:botId", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const params = windowParams(request, reply);
      if (!params) {
        return reply;
      }
      const botId = z.string().min(1).max(200).safeParse((request.params as { botId?: string }).botId);
      if (!botId.success) {
        return reply.code(400).send({ error: "invalid bot id" });
      }
      return reply.send(await stats.botDetail(params.site, params.hours, botId.data));
    });

    app.get("/api/v1/pages", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const parsed = pagesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid query" });
      }
      return reply.send({ pages: await stats.pages(parsed.data.site, parsed.data.hours, parsed.data.q) });
    });

    app.get("/api/v1/security", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const params = windowParams(request, reply);
      if (!params) {
        return reply;
      }
      return reply.send(await stats.security(params.site, params.hours));
    });

    app.get("/api/v1/pages-daily", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const parsed = z
        .object({
          site: z.string().min(1).max(200),
          days: z.coerce.number().int().min(1).max(365).default(30),
          limit: z.coerce.number().int().min(1).max(50).default(30)
        })
        .safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid query" });
      }
      return reply.send(await stats.pagesDaily(parsed.data.site, parsed.data.days, parsed.data.limit));
    });

    app.get("/api/v1/funnels", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const parsed = z
        .object({
          site: z.string().min(1).max(200),
          days: z.coerce.number().int().min(1).max(365).default(30),
          limit: z.coerce.number().int().min(1).max(100).default(50)
        })
        .safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid query" });
      }
      return reply.send({ pages: await stats.aiLandingPages(parsed.data.site, parsed.data.days, parsed.data.limit) });
    });

    app.get("/api/v1/citations", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const parsed = z
        .object({
          site: z.string().min(1).max(200),
          days: z.coerce.number().int().min(1).max(365).default(30),
          limit: z.coerce.number().int().min(1).max(100).default(50)
        })
        .safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid query" });
      }
      return reply.send(await stats.citations(parsed.data.site, parsed.data.days, parsed.data.limit));
    });

    app.get("/api/v1/crawl-health", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const parsed = z
        .object({
          site: z.string().min(1).max(200),
          days: z.coerce.number().int().min(1).max(365).default(30),
          limit: z.coerce.number().int().min(1).max(100).default(50)
        })
        .safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid query" });
      }
      return reply.send(await stats.crawlHealth(parsed.data.site, parsed.data.days, parsed.data.limit));
    });

    app.get("/api/v1/crawl-to-refer", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const parsed = z
        .object({
          site: z.string().min(1).max(200),
          days: z.coerce.number().int().min(1).max(365).default(30)
        })
        .safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid query" });
      }
      return reply.send(await stats.crawlToRefer(parsed.data.site, parsed.data.days));
    });

    const chClient = options.chClient;
    if (chClient) {
      const exploreSchema = windowQuerySchema.extend({
        metric: z.string().min(1).max(40),
        dimension: z.string().min(1).max(40),
        actor_type: z.string().max(40).optional(),
        verification: z.string().max(40).optional(),
        operator: z.string().max(100).optional(),
        country: z.string().max(2).optional(),
        bot_id: z.string().max(100).optional()
      });

      app.get("/api/v1/explore", async (request, reply) => {
        if (!requireAuth(request, reply)) {
          return reply;
        }
        const parsed = exploreSchema.safeParse(request.query);
        if (!parsed.success) {
          return reply.code(400).send({ error: "invalid query" });
        }
        const { site, hours, metric, dimension, ...filterValues } = parsed.data;
        const filters: Record<string, string> = {};
        for (const [key, value] of Object.entries(filterValues)) {
          if (typeof value === "string" && value !== "") {
            filters[key] = value;
          }
        }
        try {
          const rows = await exploreQuery(chClient, { site, hours, metric, dimension, filters });
          return await reply.send({ rows });
        } catch (error) {
          return reply.code(400).send({ error: (error as Error).message });
        }
      });
    }

    app.get("/api/v1/export.csv", async (request, reply) => {
      if (!requireAuth(request, reply)) {
        return reply;
      }
      const parsed = exportQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid query" });
      }
      const { site, hours, table, days } = parsed.data;
      let rows: Array<Record<string, unknown>> = [];
      if (table === "bots") {
        rows = (await stats.bots(site, hours)) as unknown as Array<Record<string, unknown>>;
      } else if (table === "pages") {
        rows = (await stats.pages(site, hours, "")) as unknown as Array<Record<string, unknown>>;
      } else if (table === "citations") {
        rows = (await stats.citations(site, days, 50)).pages as unknown as Array<Record<string, unknown>>;
      } else if (table === "funnels") {
        rows = (await stats.aiLandingPages(site, days, 50)) as unknown as Array<Record<string, unknown>>;
      } else {
        rows = (await stats.security(site, hours)).spoofedSources;
      }
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="crawlytics-${table}-${site}.csv"`)
        .send(toCsv(rows));
    });
  }

  return app;
}

export interface DashboardGateInput {
  licensed: boolean;
  hasPassword: boolean;
  isProduction: boolean;
  devOverride: boolean;
}

/**
 * Fail-closed dashboard decision: a valid license (or a non-production dev
 * override) enables the dashboard, but in production it additionally requires a
 * password so a licensed instance is never world-open.
 */
/**
 * The dashboard dev override bypasses the license gate (and, with no password,
 * auth) — so it must NEVER be active on a routable/production host. Require BOTH
 * the explicit flag AND an explicit `NODE_ENV=development`: an unset or
 * non-"development" NODE_ENV (e.g. a prod box that forgot to set it) does not
 * count as dev, closing the "NODE_ENV unset" bypass.
 */
export function resolveDevOverride(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["CRAWLYTICS_DASHBOARD_DEV"] === "1" && env["NODE_ENV"] === "development";
}

export function resolveDashboardEnabled(input: DashboardGateInput): boolean {
  const enabled = input.licensed || (input.devOverride && !input.isProduction);
  if (!enabled) {
    return false;
  }
  if (input.isProduction && !input.hasPassword) {
    return false;
  }
  return true;
}

// Per-process key so secrets are hashed to a fixed length before comparison —
// this makes the compare constant-time regardless of input length and removes
// the early-return length oracle a raw byte compare would leak.
const COMPARE_KEY = randomBytes(32);

function safeEqual(left: string, right: string): boolean {
  const a = createHmac("sha256", COMPARE_KEY).update(left).digest();
  const b = createHmac("sha256", COMPARE_KEY).update(right).digest();
  return timingSafeEqual(a, b);
}

/**
 * Issue a signed, self-expiring session token: `base64url(payload).signature`,
 * where payload carries `exp` (absolute ms) and a random nonce so each login
 * yields a distinct token. The signature is an HMAC over the payload with the
 * per-process session secret — not derived from the password.
 */
export function issueSessionToken(secret: Buffer, now: number, ttlMs: number, nonce: string): string {
  const body = Buffer.from(JSON.stringify({ exp: now + ttlMs, n: nonce })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Verify a session token against `secret`: constant-time signature check, then
 * an `exp` check against `now`. Returns false for any tamper, bad signature
 * (e.g. secret rotated on logout), malformed token, or expiry.
 */
export function verifySessionToken(secret: Buffer, token: string, now: number): boolean {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return false;
  }
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) {
    return false;
  }
  let payload: { exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { exp?: unknown };
  } catch {
    return false;
  }
  return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > now;
}
