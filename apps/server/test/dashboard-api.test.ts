import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  buildApp,
  issueSessionToken,
  resolveDashboardEnabled,
  resolveDevOverride,
  verifySessionToken
} from "../src/app.js";
import { createMemoryStore } from "../src/metadata/memory-store.js";
import type { OverviewResult } from "../src/stats.js";

function signLicenseKey(payload: unknown, privateKey: KeyObject): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(null, Buffer.from(payloadB64), privateKey);
  return `${payloadB64}.${sig.toString("base64url")}`;
}

const KPIS = { aiHits: 1, uniqueBots: 1, verified: 1, spoofed: 0, aiReferrals: 0, botErrors: 0 };

const OVERVIEW: OverviewResult = {
  kpis: KPIS,
  prevKpis: KPIS,
  timeseries: [],
  topBots: [],
  topPages: [],
  referrals: [],
  recent: [],
  sites: ["acme"]
};

const FAKE_STATS = {
  overview: () => Promise.resolve(OVERVIEW),
  bots: () => Promise.resolve([]),
  botDetail: () => Promise.resolve({ timeseries: [], topPages: [], statuses: [], sources: [], countries: [] }),
  pages: () => Promise.resolve([]),
  security: () => Promise.resolve({ spoofedByBot: [], spoofedSources: [] }),
  pagesDaily: () => Promise.resolve({ dates: [], pages: [], series: [] }),
  aiLandingPages: vi.fn(() => Promise.resolve([])),
  citations: vi.fn(() => Promise.resolve({ pages: [], bySource: [], byOperator: [], feed: [], infra: [] })),
  crawlHealth: vi.fn(() => Promise.resolve({ broken: [], blindSpots: [] })),
  crawlToRefer: vi.fn(() => Promise.resolve({ rows: [] }))
};

async function makeApp(password?: string) {
  const metadata = createMemoryStore();
  await metadata.createSite({ id: "s" });
  await metadata.createKey({ siteId: "s", scope: "ingest", key: "k" });
  return buildApp({
    metadata,
    batcher: { push: () => true, size: 0 },
    stats: FAKE_STATS,
    dashboardEnabled: true,
    ...(password === undefined ? {} : { dashboardPassword: password })
  });
}

function makeGatedApp(dashboardEnabled: boolean) {
  const metadata = createMemoryStore();
  return buildApp({
    metadata,
    batcher: { push: () => true, size: 0 },
    stats: FAKE_STATS,
    dashboardEnabled
  });
}

describe("dashboard API auth", () => {
  it("rejects overview without a session when password is set", async () => {
    const app = await makeApp("secret1");
    const response = await app.inject({ method: "GET", url: "/api/v1/overview?site=acme&hours=24" });
    expect(response.statusCode).toBe(401);
  });

  it("logs in with the right password and serves overview via cookie", async () => {
    const app = await makeApp("secret1");

    const bad = await app.inject({ method: "POST", url: "/api/login", payload: { password: "nope" } });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({ method: "POST", url: "/api/login", payload: { password: "secret1" } });
    expect(ok.statusCode).toBe(200);
    const cookie = ok.headers["set-cookie"];
    expect(cookie).toBeTruthy();

    const overview = await app.inject({
      method: "GET",
      url: "/api/v1/overview?site=acme&hours=24",
      headers: { cookie: String(cookie).split(";")[0] ?? "" }
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ sites: ["acme"] });
  });

  it("serves overview without auth when no password is configured (local dev)", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/overview?site=acme&hours=24" });
    expect(response.statusCode).toBe(200);
  });

  it("validates the hours parameter", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/overview?site=m&hours=9999" });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/v1/citations", () => {
  it("requires a session when a password is set", async () => {
    const app = await makeApp("secret1");
    const response = await app.inject({ method: "GET", url: "/api/v1/citations?site=acme" });
    expect(response.statusCode).toBe(401);
  });

  it("serves the citations payload with defaults applied", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/citations?site=acme" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pages: [], bySource: [], byOperator: [], feed: [], infra: [] });
    expect(FAKE_STATS.citations).toHaveBeenLastCalledWith("acme", 30, 50);
  });

  it("passes non-default days and limit through to the store", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/citations?site=acme&days=7&limit=25" });
    expect(response.statusCode).toBe(200);
    expect(FAKE_STATS.citations).toHaveBeenLastCalledWith("acme", 7, 25);
  });

  it("rejects out-of-range days and limit", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/citations?site=m&days=0" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/citations?site=m&days=400" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/citations?site=m&limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/citations?site=m&limit=101" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/citations?days=30" })).statusCode).toBe(400); // no site
  });
});

describe("GET /api/v1/crawl-health", () => {
  it("requires a session when a password is set", async () => {
    const app = await makeApp("secret1");
    const response = await app.inject({ method: "GET", url: "/api/v1/crawl-health?site=acme" });
    expect(response.statusCode).toBe(401);
  });

  it("serves broken pages + blind spots with defaults applied", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/crawl-health?site=acme" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ broken: [], blindSpots: [] });
    expect(FAKE_STATS.crawlHealth).toHaveBeenLastCalledWith("acme", 30, 50);
  });

  it("passes non-default days and limit through to the store", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/crawl-health?site=acme&days=90&limit=10" });
    expect(response.statusCode).toBe(200);
    expect(FAKE_STATS.crawlHealth).toHaveBeenLastCalledWith("acme", 90, 10);
  });

  it("rejects out-of-range params", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/crawl-health?site=m&days=0" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/crawl-health?site=m&days=999" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/crawl-health?site=m&limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/crawl-health?days=30" })).statusCode).toBe(400);
  });
});

describe("GET /api/v1/crawl-to-refer", () => {
  it("requires a session when a password is set", async () => {
    const app = await makeApp("secret1");
    expect((await app.inject({ method: "GET", url: "/api/v1/crawl-to-refer?site=acme" })).statusCode).toBe(401);
  });

  it("serves the vendor rows with defaults applied", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/crawl-to-refer?site=acme" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rows: [] });
    expect(FAKE_STATS.crawlToRefer).toHaveBeenLastCalledWith("acme", 30);
  });

  it("passes non-default days through to the store", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/crawl-to-refer?site=acme&days=7" });
    expect(response.statusCode).toBe(200);
    expect(FAKE_STATS.crawlToRefer).toHaveBeenLastCalledWith("acme", 7);
  });

  it("rejects out-of-range params", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/crawl-to-refer?site=m&days=0" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/v1/crawl-to-refer?days=30" })).statusCode).toBe(400);
  });
});

describe("GET /api/v1/robots-suggestion", () => {
  it("requires a session when a password is set", async () => {
    const app = await makeApp("secret1");
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/robots-suggestion?site=s" })).statusCode
    ).toBe(401);
  });

  it("returns robots.txt + llms.txt honoring the policy params", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/robots-suggestion?site=s&train=deny&search=allow&fetch=allow"
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ robotsTxt: string; llmsTxt: string }>();
    expect(body.robotsTxt).toContain("User-agent:");
    expect(body.robotsTxt).toContain("Disallow: /");
    expect(body.llmsTxt).toContain("#");
  });

  it("falls back to defaults on garbage policy values instead of erroring", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/robots-suggestion?site=s&train=banana&search=&fetch=whatever"
    });
    expect(response.statusCode).toBe(200);
    // defaults: train=deny -> a Disallow group exists; search/fetch=allow -> an Allow group exists
    const body = response.json<{ robotsTxt: string }>();
    expect(body.robotsTxt).toContain("Disallow: /");
    expect(body.robotsTxt).toContain("Allow: /");
  });

  it("404s for an unknown site", async () => {
    const app = await makeApp();
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/robots-suggestion?site=nope" })).statusCode
    ).toBe(404);
  });
});

describe("CSV export of the new tables (F6)", () => {
  it("exports citations and funnels as CSV using the days window", async () => {
    const app = await makeApp();
    const citations = await app.inject({
      method: "GET",
      url: "/api/v1/export.csv?site=acme&hours=24&table=citations&days=7"
    });
    expect(citations.statusCode).toBe(200);
    expect(citations.headers["content-type"]).toContain("text/csv");
    expect(FAKE_STATS.citations).toHaveBeenLastCalledWith("acme", 7, 50);

    const funnels = await app.inject({
      method: "GET",
      url: "/api/v1/export.csv?site=acme&hours=24&table=funnels"
    });
    expect(funnels.statusCode).toBe(200);
    expect(FAKE_STATS.aiLandingPages).toHaveBeenLastCalledWith("acme", 30, 50);
  });

  it("still rejects unknown tables", async () => {
    const app = await makeApp();
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/export.csv?site=m&hours=24&table=nope" })).statusCode
    ).toBe(400);
  });
});

describe("alerts config API (/api/v1/alerts)", () => {
  it("requires a session when a password is set", async () => {
    const app = await makeApp("secret1");
    expect((await app.inject({ method: "GET", url: "/api/v1/alerts" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "PUT", url: "/api/v1/alerts", payload: { webhookUrl: "" } })).statusCode
    ).toBe(401);
  });

  it("returns defaults (alerts off) until a config is saved", async () => {
    const app = await makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/alerts" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ webhookUrl: "", spikeFactor: 3, cooldownMinutes: 360 });
  });

  it("saves and returns the config", async () => {
    const app = await makeApp();
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/alerts",
      payload: {
        webhookUrl: "https://hooks.example/x",
        rules: { spike: true, newBot: false, spoof: true, brokenCitation: true },
        spikeFactor: 5,
        cooldownMinutes: 60
      }
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: "/api/v1/alerts" });
    expect(get.json()).toMatchObject({ webhookUrl: "https://hooks.example/x", spikeFactor: 5 });
  });

  it("rejects invalid webhook URLs and out-of-range numbers", async () => {
    const app = await makeApp();
    const bad = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: "/api/v1/alerts", payload });
    expect((await bad({ webhookUrl: "not-a-url" })).statusCode).toBe(400);
    expect((await bad({ webhookUrl: "ftp://x/y" })).statusCode).toBe(400);
    expect((await bad({ webhookUrl: "", spikeFactor: 0 })).statusCode).toBe(400);
    expect((await bad({ webhookUrl: "", cooldownMinutes: 0 })).statusCode).toBe(400);
  });

  it("sends a test webhook only when a URL is configured", async () => {
    const app = await makeApp();
    // no config yet -> 400
    expect((await app.inject({ method: "POST", url: "/api/v1/alerts/test" })).statusCode).toBe(400);
  });
});

describe("login brute-force backstop (D1) + hardened cookie (D2)", () => {
  // The limiter keys on X-Real-IP (the header nginx OVERWRITES), never on the
  // client-appendable X-Forwarded-For.
  const fail = (app: Awaited<ReturnType<typeof makeApp>>, ip: string) =>
    app.inject({ method: "POST", url: "/api/login", headers: { "x-real-ip": ip }, payload: { password: "nope" } });
  const tryRight = (app: Awaited<ReturnType<typeof makeApp>>, ip: string) =>
    app.inject({ method: "POST", url: "/api/login", headers: { "x-real-ip": ip }, payload: { password: "secret1" } });

  it("locks out an IP after repeated wrong passwords (429 + Retry-After), even with the right password", async () => {
    const app = await makeApp("secret1");
    for (let i = 0; i < 10; i++) {
      expect((await fail(app, "9.9.9.9")).statusCode).toBe(401);
    }
    const blocked = await tryRight(app, "9.9.9.9");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeTruthy();
  });

  it("locks out only the offending IP, not others", async () => {
    const app = await makeApp("secret1");
    for (let i = 0; i < 10; i++) {
      await fail(app, "9.9.9.9");
    }
    expect((await tryRight(app, "8.8.8.8")).statusCode).toBe(200);
  });

  it("resets an IP's counter after a successful login", async () => {
    const app = await makeApp("secret1");
    for (let i = 0; i < 9; i++) {
      await fail(app, "7.7.7.7");
    }
    expect((await tryRight(app, "7.7.7.7")).statusCode).toBe(200); // resets
    for (let i = 0; i < 9; i++) {
      expect((await fail(app, "7.7.7.7")).statusCode).toBe(401); // not locked yet
    }
  });

  it("does NOT trust X-Forwarded-For (spoofing it cannot bypass the lockout)", async () => {
    const app = await makeApp("secret1");
    // Same real client (X-Real-IP), rotating a spoofed X-Forwarded-For each time.
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/api/login",
        headers: { "x-real-ip": "5.5.5.5", "x-forwarded-for": `1.2.3.${String(i)}` },
        payload: { password: "nope" }
      });
      expect(r.statusCode).toBe(401);
    }
    // Still locked despite the ever-changing XFF, because the key is X-Real-IP.
    const blocked = await app.inject({
      method: "POST",
      url: "/api/login",
      headers: { "x-real-ip": "5.5.5.5", "x-forwarded-for": "9.9.9.9" },
      payload: { password: "secret1" }
    });
    expect(blocked.statusCode).toBe(429);
  });

  it("rejects an oversized login body via the small per-route bodyLimit", async () => {
    const app = await makeApp("secret1");
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "x".repeat(4000) } });
    expect(res.statusCode).toBe(413);
  });

  it("sets HttpOnly + SameSite=Strict on the session cookie", async () => {
    const app = await makeApp("secret1");
    const ok = await app.inject({ method: "POST", url: "/api/login", payload: { password: "secret1" } });
    const cookie = String(ok.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });
});

describe("session tokens (D-sess: signed, expiring, revocable)", () => {
  const NOW = 1_900_000_000_000;
  const TTL = 7 * 24 * 3600 * 1000;

  it("round-trips a freshly issued token", () => {
    const secret = randomBytes(32);
    const token = issueSessionToken(secret, NOW, TTL, "nonce1");
    expect(verifySessionToken(secret, token, NOW + 1000)).toBe(true);
  });

  it("rejects an expired token", () => {
    const secret = randomBytes(32);
    const token = issueSessionToken(secret, NOW, TTL, "nonce1");
    expect(verifySessionToken(secret, token, NOW + TTL + 1)).toBe(false);
  });

  it("rejects a token signed with a different secret (e.g. after logout rotation)", () => {
    const token = issueSessionToken(randomBytes(32), NOW, TTL, "nonce1");
    expect(verifySessionToken(randomBytes(32), token, NOW + 1000)).toBe(false);
  });

  it("rejects tampered or malformed tokens", () => {
    const secret = randomBytes(32);
    const token = issueSessionToken(secret, NOW, TTL, "nonce1");
    const body = token.split(".")[0] ?? "";
    const sig = token.split(".")[1] ?? "";
    expect(verifySessionToken(secret, `${body}x.${sig}`, NOW + 1000)).toBe(false); // mangled body
    expect(verifySessionToken(secret, `${body}.${sig}x`, NOW + 1000)).toBe(false); // mangled sig
    expect(verifySessionToken(secret, "garbage", NOW + 1000)).toBe(false);
    expect(verifySessionToken(secret, "", NOW + 1000)).toBe(false);
    expect(verifySessionToken(secret, ".", NOW + 1000)).toBe(false);
  });

  it("issues a distinct token per login (rotation via nonce)", () => {
    const secret = randomBytes(32);
    const a = issueSessionToken(secret, NOW, TTL, "n1");
    const b = issueSessionToken(secret, NOW, TTL, "n2");
    expect(a).not.toBe(b);
  });
});

describe("logout revokes the session (POST /api/logout)", () => {
  const overview = (app: Awaited<ReturnType<typeof makeApp>>, cookie: string) =>
    app.inject({ method: "GET", url: "/api/v1/overview?site=acme&hours=24", headers: { cookie } });

  it("invalidates the cookie (rotates the secret) so an old cookie stops working", async () => {
    const app = await makeApp("secret1");
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "secret1" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";

    expect((await overview(app, cookie)).statusCode).toBe(200); // authed

    const out = await app.inject({ method: "POST", url: "/api/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);

    expect((await overview(app, cookie)).statusCode).toBe(401); // old cookie now dead
  });

  it("requires auth — an anonymous caller cannot force-logout the owner", async () => {
    const app = await makeApp("secret1");
    expect((await app.inject({ method: "POST", url: "/api/logout" })).statusCode).toBe(401);
  });
});

describe("dashboard license gate", () => {
  it("does not register /api/v1 when the dashboard is unlicensed", async () => {
    const app = makeGatedApp(false);
    const response = await app.inject({ method: "GET", url: "/api/v1/overview?site=s&hours=24" });
    expect(response.statusCode).toBe(404);
  });

  it("serves /api/v1 when the dashboard is licensed", async () => {
    const app = makeGatedApp(true);
    const response = await app.inject({ method: "GET", url: "/api/v1/overview?site=s&hours=24" });
    expect(response.statusCode).toBe(200);
  });

  it("hides /api/session and /api/login when unlicensed (no password oracle)", async () => {
    const off = makeGatedApp(false);
    expect((await off.inject({ method: "GET", url: "/api/session" })).statusCode).toBe(404);
    expect(
      (await off.inject({ method: "POST", url: "/api/login", payload: { password: "x" } })).statusCode
    ).toBe(404);
  });

  it("reports dashboardEnabled in the session when licensed", async () => {
    const on = makeGatedApp(true);
    expect((await on.inject({ method: "GET", url: "/api/session" })).json()).toMatchObject({
      dashboardEnabled: true
    });
  });
});

describe("dashboard license unlock (POST /api/license)", () => {
  function unlicensedFullApp(licensePublicKey: string) {
    const metadata = createMemoryStore();
    const app = buildApp({
      metadata,
      batcher: { push: () => true, size: 0 },
      stats: FAKE_STATS,
      dashboardEnabled: false, // unlicensed at boot
      serveDashboard: true, // full image: shell reachable so a key can be entered
      licensePublicKey
    });
    return { app, metadata };
  }

  it("unlocks the data API at runtime when a valid key is submitted", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const { app, metadata } = unlicensedFullApp(pubPem);

    // Locked: session reports disabled, data API is 403 (registered but gated).
    expect((await app.inject({ method: "GET", url: "/api/session" })).json()).toMatchObject({
      dashboardEnabled: false
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/overview?site=acme&hours=24" })).statusCode
    ).toBe(403);

    // A malformed/invalid key is rejected and changes nothing.
    expect((await app.inject({ method: "POST", url: "/api/license", payload: { key: "garbage" } })).statusCode).toBe(
      400
    );
    expect(await metadata.getLicenseKey()).toBeNull();

    // A valid key unlocks the dashboard without a restart and is persisted.
    const key = signLicenseKey({ tier: "ltd", iat: 1700000000 }, privateKey);
    const ok = await app.inject({ method: "POST", url: "/api/license", payload: { key } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, dashboardEnabled: true, tier: "ltd" });
    expect(await metadata.getLicenseKey()).toBe(key);

    expect((await app.inject({ method: "GET", url: "/api/session" })).json()).toMatchObject({
      dashboardEnabled: true
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/overview?site=acme&hours=24" })).statusCode
    ).toBe(200);
  });

  it("rejects a key signed by an untrusted key and stays locked", async () => {
    const trusted = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    const pubPem = trusted.publicKey.export({ type: "spki", format: "pem" }).toString();
    const { app, metadata } = unlicensedFullApp(pubPem);

    const forged = signLicenseKey({ tier: "ltd", iat: 1700000000 }, attacker.privateKey);
    const res = await app.inject({ method: "POST", url: "/api/license", payload: { key: forged } });
    expect(res.statusCode).toBe(400);
    expect(await metadata.getLicenseKey()).toBeNull();
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/overview?site=acme&hours=24" })).statusCode
    ).toBe(403);
  });

  it("locks every data route (incl. HEAD and parameterised) while unlicensed", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const { app } = unlicensedFullApp(publicKey.export({ type: "spki", format: "pem" }).toString());
    const w = "site=acme&hours=24";
    for (const req of [
      { method: "GET" as const, url: `/api/v1/overview?${w}` },
      { method: "HEAD" as const, url: `/api/v1/overview?${w}` },
      { method: "GET" as const, url: `/api/v1/bots?${w}` },
      { method: "GET" as const, url: `/api/v1/bot/gptbot?${w}` },
      { method: "GET" as const, url: `/api/v1/pages?${w}` },
      { method: "GET" as const, url: `/api/v1/security?${w}` },
      { method: "GET" as const, url: `/api/v1/citations?site=acme` },
      { method: "GET" as const, url: `/api/v1/crawl-health?site=acme` },
      { method: "GET" as const, url: `/api/v1/crawl-to-refer?site=acme` },
      { method: "GET" as const, url: `/api/v1/robots-suggestion?site=acme` },
      { method: "GET" as const, url: `/api/v1/alerts` },
      { method: "GET" as const, url: `/api/v1/export.csv?${w}&table=bots` }
    ]) {
      expect((await app.inject(req)).statusCode, `${req.method} ${req.url}`).toBe(403);
    }
  });

  it("requires dashboard auth to replace the key once the dashboard is unlocked", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const metadata = createMemoryStore();
    await metadata.createSite({ id: "acme" });
    const app = buildApp({
      metadata,
      batcher: { push: () => true, size: 0 },
      stats: FAKE_STATS,
      dashboardEnabled: true, // already licensed
      serveDashboard: true,
      dashboardPassword: "secret1",
      licensePublicKey: pubPem
    });
    const key = signLicenseKey({ tier: "ltd", iat: 1700000000 }, privateKey);

    // No session → cannot rebind the instance.
    const unauth = await app.inject({ method: "POST", url: "/api/license", payload: { key } });
    expect(unauth.statusCode).toBe(401);

    // With a valid session → allowed.
    const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "secret1" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    const authed = await app.inject({
      method: "POST",
      url: "/api/license",
      headers: { cookie },
      payload: { key }
    });
    expect(authed.statusCode).toBe(200);
    expect(await metadata.getLicenseKey()).toBe(key);
  });
});

describe("resolveDashboardEnabled (fail-closed)", () => {
  it("requires a password in production even when licensed", () => {
    expect(resolveDashboardEnabled({ licensed: true, hasPassword: true, isProduction: true, devOverride: false })).toBe(true);
    expect(resolveDashboardEnabled({ licensed: true, hasPassword: false, isProduction: true, devOverride: false })).toBe(false);
    expect(resolveDashboardEnabled({ licensed: true, hasPassword: false, isProduction: false, devOverride: false })).toBe(true);
  });

  it("honours the dev override only outside production", () => {
    expect(resolveDashboardEnabled({ licensed: false, hasPassword: false, isProduction: false, devOverride: true })).toBe(true);
    expect(resolveDashboardEnabled({ licensed: false, hasPassword: true, isProduction: true, devOverride: true })).toBe(false);
  });
});

describe("resolveDevOverride (no NODE_ENV-unset bypass)", () => {
  it("requires the flag AND an explicit NODE_ENV=development", () => {
    expect(resolveDevOverride({ CRAWLYTICS_DASHBOARD_DEV: "1", NODE_ENV: "development" })).toBe(true);
  });
  it("does not treat an unset/other NODE_ENV as dev", () => {
    expect(resolveDevOverride({ CRAWLYTICS_DASHBOARD_DEV: "1" })).toBe(false); // NODE_ENV unset
    expect(resolveDevOverride({ CRAWLYTICS_DASHBOARD_DEV: "1", NODE_ENV: "production" })).toBe(false);
    expect(resolveDevOverride({ CRAWLYTICS_DASHBOARD_DEV: "1", NODE_ENV: "staging" })).toBe(false);
  });
  it("is off without the flag", () => {
    expect(resolveDevOverride({ NODE_ENV: "development" })).toBe(false);
  });
});
