import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createFileStore } from "../src/metadata/file-store.js";

const tempDirs: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "crawlytics-meta-"));
  tempDirs.push(dir);
  return join(dir, "metadata.json");
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createFileStore", () => {
  it("persists sites and keys across restarts", async () => {
    const file = await tempFile();
    const store = createFileStore(file);
    await store.createSite({ id: "site-1", domain: "example.com" });
    await store.createKey({ siteId: "site-1", scope: "ingest", key: "ing" });
    await store.createKey({ siteId: "site-1", scope: "read", key: "rd" });

    const reopened = createFileStore(file);
    expect(await reopened.resolveIngestKey("ing")).toBe("site-1");
    expect(await reopened.resolveReadKey("rd")).toBe("site-1");
    expect((await reopened.getSite("site-1"))?.domain).toBe("example.com");
    expect(await reopened.listSites()).toHaveLength(1);
  });

  it("rejects duplicate keys and persists revocation", async () => {
    const file = await tempFile();
    const store = createFileStore(file);
    await store.createSite({ id: "s" });
    await store.createKey({ siteId: "s", scope: "ingest", key: "dup" });
    await expect(store.createKey({ siteId: "s", scope: "read", key: "dup" })).rejects.toThrow();

    expect(await store.revokeKey("dup")).toBe(true);
    expect(await createFileStore(file).resolveIngestKey("dup")).toBeNull();
  });

  it("persists the license key across restarts and can clear it", async () => {
    const file = await tempFile();
    const store = createFileStore(file);
    expect(await store.getLicenseKey()).toBeNull();
    await store.setLicenseKey("lic-abc");

    expect(await createFileStore(file).getLicenseKey()).toBe("lic-abc");

    await store.setLicenseKey(null);
    expect(await createFileStore(file).getLicenseKey()).toBeNull();
  });

  it("quarantines a corrupt file and starts empty without crashing", async () => {
    const file = await tempFile();
    await writeFile(file, "{ not json");
    const store = createFileStore(file);
    expect(await store.listSites()).toHaveLength(0);
    const entries = await readdir(dirname(file));
    expect(entries.some((entry) => entry.includes(".corrupt."))).toBe(true);
    await store.createSite({ id: "s" });
    expect(await store.listSites()).toHaveLength(1);
  });

  it("rolls back the in-memory change when the disk write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crawlytics-meta-"));
    tempDirs.push(dir);
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x"); // a file, so blocker/metadata.json can never be written
    const store = createFileStore(join(blocker, "metadata.json"));
    await expect(store.createSite({ id: "s" })).rejects.toThrow();
    expect(await store.listSites()).toHaveLength(0); // reverted
  });
});
