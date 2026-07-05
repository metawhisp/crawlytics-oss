import type { MetadataStore } from "./store.js";

/**
 * Seed a store from the legacy `TC_INGEST_KEYS` env ("key1:site1,key2:site2").
 * Keeps the single-container self-host story working and is the
 * import-on-first-boot path while Postgres-backed metadata is introduced.
 * Idempotent: keys that already resolve are skipped. Returns count seeded.
 */
export async function seedFromEnv(
  store: MetadataStore,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  let seeded = 0;
  for (const pair of (env["TC_INGEST_KEYS"] ?? "").split(",")) {
    const [key, siteId] = pair.split(":").map((part) => part.trim());
    if (!key || !siteId) {
      continue;
    }
    if ((await store.resolveIngestKey(key)) ?? (await store.resolveReadKey(key))) {
      continue;
    }
    await store.createSite({ id: siteId });
    await store.createKey({ siteId, scope: "ingest", key });
    seeded += 1;
  }
  return seeded;
}
