import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createMemoryStore } from "../src/metadata/memory-store.js";

const VALID_EVENT = {
  ts: "2026-06-14T03:22:01.000Z",
  ip: "203.0.113.10",
  method: "GET",
  path: "/robots.txt",
  status: 200,
  bytes: 412,
  ua: "GPTBot/1.3",
  referer: ""
};

/** A licensed, no-password (open) dashboard — onboarding routes reachable. */
function onboardApp() {
  const metadata = createMemoryStore();
  const app = buildApp({
    metadata,
    batcher: { push: () => true, size: 0 },
    dashboardEnabled: true,
    serveDashboard: true
  });
  return { app, metadata };
}

describe("onboarding API — sites", () => {
  it("creates a site, lists it, and is idempotent on the same id", async () => {
    const { app } = onboardApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sites",
      payload: { id: "acme", domain: "acme.com" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: "acme", domain: "acme.com" });

    const again = await app.inject({ method: "POST", url: "/api/v1/sites", payload: { id: "acme", domain: "x" } });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ domain: "acme.com" }); // not overwritten

    const list = await app.inject({ method: "GET", url: "/api/v1/sites" });
    expect(list.json<{ sites: unknown[] }>().sites).toHaveLength(1);
  });

  it("rejects a blank site id", async () => {
    const { app } = onboardApp();
    expect((await app.inject({ method: "POST", url: "/api/v1/sites", payload: { id: "" } })).statusCode).toBe(400);
  });
});

describe("onboarding API — keys", () => {
  it("issues an ingest key that resolves, plus a read key, and lists them", async () => {
    const { app, metadata } = onboardApp();
    await app.inject({ method: "POST", url: "/api/v1/sites", payload: { id: "acme" } });

    const ingest = await app.inject({ method: "POST", url: "/api/v1/sites/acme/keys", payload: { scope: "ingest" } });
    expect(ingest.statusCode).toBe(201);
    const ingestKey = ingest.json<{ key: string; scope: string }>();
    expect(ingestKey.scope).toBe("ingest");
    expect(ingestKey.key).toMatch(/^cwi_/u);
    expect(await metadata.resolveIngestKey(ingestKey.key)).toBe("acme");

    const read = await app.inject({ method: "POST", url: "/api/v1/sites/acme/keys", payload: { scope: "read" } });
    expect(read.json<{ key: string }>().key).toMatch(/^cwr_/u);

    const keys = await app.inject({ method: "GET", url: "/api/v1/sites/acme/keys" });
    expect(keys.json<{ keys: unknown[] }>().keys).toHaveLength(2);
  });

  it("404s a key for an unknown site and 400s a bad scope", async () => {
    const { app } = onboardApp();
    await app.inject({ method: "POST", url: "/api/v1/sites", payload: { id: "acme" } });
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/sites/ghost/keys", payload: { scope: "ingest" } })).statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/sites/acme/keys", payload: { scope: "admin" } })).statusCode
    ).toBe(400);
  });

  it("revokes a key so it stops resolving; revoking an unknown key reports false", async () => {
    const { app, metadata } = onboardApp();
    await app.inject({ method: "POST", url: "/api/v1/sites", payload: { id: "acme" } });
    const key = (await app.inject({ method: "POST", url: "/api/v1/sites/acme/keys", payload: { scope: "ingest" } }))
      .json<{ key: string }>().key;

    const revoke = await app.inject({
      method: "POST",
      url: "/api/v1/sites/acme/keys/revoke",
      payload: { key }
    });
    expect(revoke.json()).toMatchObject({ revoked: true });
    expect(await metadata.resolveIngestKey(key)).toBeNull();

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/sites/acme/keys/revoke",
      payload: { key: "nope" }
    });
    expect(missing.json()).toMatchObject({ revoked: false });
  });

  it("only revokes a key through its own site's path", async () => {
    const { app, metadata } = onboardApp();
    await app.inject({ method: "POST", url: "/api/v1/sites", payload: { id: "site-a" } });
    await app.inject({ method: "POST", url: "/api/v1/sites", payload: { id: "site-b" } });
    const key = (await app.inject({ method: "POST", url: "/api/v1/sites/site-a/keys", payload: { scope: "ingest" } }))
      .json<{ key: string }>().key;

    // Wrong site path must not drop site-a's key.
    const wrong = await app.inject({ method: "POST", url: "/api/v1/sites/site-b/keys/revoke", payload: { key } });
    expect(wrong.json()).toMatchObject({ revoked: false });
    expect(await metadata.resolveIngestKey(key)).toBe("site-a"); // still valid

    // Unknown site path → 404, key untouched.
    const unknown = await app.inject({ method: "POST", url: "/api/v1/sites/ghost/keys/revoke", payload: { key } });
    expect(unknown.statusCode).toBe(404);
    expect(await metadata.resolveIngestKey(key)).toBe("site-a");

    // Correct site path revokes it.
    const right = await app.inject({ method: "POST", url: "/api/v1/sites/site-a/keys/revoke", payload: { key } });
    expect(right.json()).toMatchObject({ revoked: true });
    expect(await metadata.resolveIngestKey(key)).toBeNull();
  });
});

describe("onboarding API — is it working", () => {
  it("reports no events before ingest and the last event after", async () => {
    const { app } = onboardApp();
    await app.inject({ method: "POST", url: "/api/v1/sites", payload: { id: "acme" } });
    const key = (await app.inject({ method: "POST", url: "/api/v1/sites/acme/keys", payload: { scope: "ingest" } }))
      .json<{ key: string }>().key;

    const before = await app.inject({ method: "GET", url: "/api/v1/sites/acme/status" });
    expect(before.json()).toMatchObject({ lastEventAt: null, recentEvents: 0 });

    await app.inject({
      method: "POST",
      url: "/api/ingest",
      headers: { authorization: `Bearer ${key}` },
      payload: { events: [VALID_EVENT, { ...VALID_EVENT, path: "/x" }] }
    });

    const after = await app.inject({ method: "GET", url: "/api/v1/sites/acme/status" });
    const status = after.json<{ lastEventAt: string | null; recentEvents: number }>();
    expect(status.recentEvents).toBe(2);
    expect(typeof status.lastEventAt).toBe("string");
  });
});

describe("onboarding API — gate + auth", () => {
  it("403s onboarding on a locked dashboard", async () => {
    const metadata = createMemoryStore();
    const locked = buildApp({
      metadata,
      batcher: { push: () => true, size: 0 },
      dashboardEnabled: false,
      serveDashboard: true
    });
    expect((await locked.inject({ method: "GET", url: "/api/v1/sites" })).statusCode).toBe(403);
    expect(
      (await locked.inject({ method: "POST", url: "/api/v1/sites", payload: { id: "x" } })).statusCode
    ).toBe(403);
  });

  it("401s onboarding without a session when a password is set", async () => {
    const metadata = createMemoryStore();
    const app = buildApp({
      metadata,
      batcher: { push: () => true, size: 0 },
      dashboardEnabled: true,
      serveDashboard: true,
      dashboardPassword: "secret1"
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/sites" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/sites", payload: { id: "x" } })).statusCode
    ).toBe(401);
  });
});
