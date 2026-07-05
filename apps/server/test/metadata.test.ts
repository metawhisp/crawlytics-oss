import { describe, expect, it } from "vitest";

import { createMemoryStore } from "../src/metadata/memory-store.js";
import { seedFromEnv } from "../src/metadata/from-env.js";
import { generateApiKey } from "../src/metadata/store.js";

describe("generateApiKey", () => {
  it("prefixes keys by scope and produces unique values", () => {
    expect(generateApiKey("ingest")).toMatch(/^cwi_[A-Za-z0-9_-]+$/);
    expect(generateApiKey("read")).toMatch(/^cwr_[A-Za-z0-9_-]+$/);
    expect(generateApiKey("ingest")).not.toBe(generateApiKey("ingest"));
  });
});

describe("createMemoryStore", () => {
  it("creates sites idempotently", async () => {
    const store = createMemoryStore();
    const a = await store.createSite({ id: "site-1", domain: "example.com" });
    const b = await store.createSite({ id: "site-1", domain: "other.com" });
    expect(b).toEqual(a); // second call returns the first, does not overwrite
    expect(await store.listSites()).toHaveLength(1);
    expect((await store.getSite("site-1"))?.domain).toBe("example.com");
  });

  it("resolves keys only within their scope", async () => {
    const store = createMemoryStore();
    await store.createSite({ id: "site-1" });
    const ingest = await store.createKey({ siteId: "site-1", scope: "ingest" });
    const read = await store.createKey({ siteId: "site-1", scope: "read" });

    expect(await store.resolveIngestKey(ingest.key)).toBe("site-1");
    expect(await store.resolveReadKey(ingest.key)).toBeNull();
    expect(await store.resolveReadKey(read.key)).toBe("site-1");
    expect(await store.resolveIngestKey(read.key)).toBeNull();
    expect(await store.resolveIngestKey("unknown")).toBeNull();
  });

  it("accepts explicit key values and lists/revokes keys", async () => {
    const store = createMemoryStore();
    await store.createSite({ id: "site-1" });
    await store.createKey({ siteId: "site-1", scope: "ingest", key: "fixed-key" });
    expect(await store.resolveIngestKey("fixed-key")).toBe("site-1");
    expect(await store.listKeys("site-1")).toHaveLength(1);

    expect(await store.revokeKey("fixed-key")).toBe(true);
    expect(await store.resolveIngestKey("fixed-key")).toBeNull();
    expect(await store.revokeKey("fixed-key")).toBe(false);
  });

  it("rejects duplicate key strings across scopes", async () => {
    const store = createMemoryStore();
    await store.createSite({ id: "site-1" });
    await store.createKey({ siteId: "site-1", scope: "read", key: "dup" });
    await expect(store.createKey({ siteId: "site-1", scope: "ingest", key: "dup" })).rejects.toThrow();
  });

  it("stores and clears the license key", async () => {
    const store = createMemoryStore();
    expect(await store.getLicenseKey()).toBeNull();
    await store.setLicenseKey("lic-123");
    expect(await store.getLicenseKey()).toBe("lic-123");
    await store.setLicenseKey(null);
    expect(await store.getLicenseKey()).toBeNull();
  });
});

describe("seedFromEnv", () => {
  it("imports TC_INGEST_KEYS pairs as sites + ingest keys", async () => {
    const store = createMemoryStore();
    const count = await seedFromEnv(store, { TC_INGEST_KEYS: "k1:site-1, k2:site-2" });
    expect(count).toBe(2);
    expect(await store.resolveIngestKey("k1")).toBe("site-1");
    expect(await store.resolveIngestKey("k2")).toBe("site-2");
    expect(await store.listSites()).toHaveLength(2);
  });

  it("is idempotent and ignores malformed pairs", async () => {
    const store = createMemoryStore();
    await seedFromEnv(store, { TC_INGEST_KEYS: "k1:site-1" });
    const second = await seedFromEnv(store, { TC_INGEST_KEYS: "k1:site-1,broken,:nosite,nokey:" });
    expect(second).toBe(0); // k1 already present, the rest are malformed
    expect(await store.listSites()).toHaveLength(1);
  });

  it("returns 0 when the env var is absent", async () => {
    const store = createMemoryStore();
    expect(await seedFromEnv(store, {})).toBe(0);
  });

  it("does not overwrite a key that already exists in another scope", async () => {
    const store = createMemoryStore();
    await store.createSite({ id: "site-1" });
    await store.createKey({ siteId: "site-1", scope: "read", key: "shared" });
    expect(await seedFromEnv(store, { TC_INGEST_KEYS: "shared:site-1" })).toBe(0);
    expect(await store.resolveReadKey("shared")).toBe("site-1");
    expect(await store.resolveIngestKey("shared")).toBeNull();
  });
});
