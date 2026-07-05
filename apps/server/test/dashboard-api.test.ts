import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

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
  referralFunnels: () => Promise.resolve([])
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
