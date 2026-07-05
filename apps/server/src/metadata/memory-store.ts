import type { ApiKey, CreateKeyInput, CreateSiteInput, MetadataStore, Site } from "./store.js";
import { generateApiKey } from "./store.js";

/**
 * In-memory MetadataStore. Used by tests and as the runtime fallback that
 * holds env-seeded ingest keys until the Postgres-backed store is wired.
 * Methods return resolved promises so they satisfy the async store contract
 * without awaiting anything internally.
 */
export function createMemoryStore(): MetadataStore {
  const sites = new Map<string, Site>();
  const keys = new Map<string, ApiKey>();
  let licenseKey: string | null = null;

  return {
    resolveIngestKey(key: string): Promise<string | null> {
      const found = keys.get(key);
      return Promise.resolve(found && found.scope === "ingest" ? found.siteId : null);
    },
    resolveReadKey(key: string): Promise<string | null> {
      const found = keys.get(key);
      return Promise.resolve(found && found.scope === "read" ? found.siteId : null);
    },
    listSites(): Promise<Site[]> {
      return Promise.resolve([...sites.values()]);
    },
    getSite(id: string): Promise<Site | null> {
      return Promise.resolve(sites.get(id) ?? null);
    },
    createSite(input: CreateSiteInput): Promise<Site> {
      const existing = sites.get(input.id);
      if (existing) {
        return Promise.resolve(existing);
      }
      const site: Site = {
        id: input.id,
        domain: input.domain ?? "",
        createdAt: new Date().toISOString()
      };
      sites.set(site.id, site);
      return Promise.resolve(site);
    },
    listKeys(siteId: string): Promise<ApiKey[]> {
      return Promise.resolve([...keys.values()].filter((entry) => entry.siteId === siteId));
    },
    createKey(input: CreateKeyInput): Promise<ApiKey> {
      const key = input.key ?? generateApiKey(input.scope);
      if (keys.has(key)) {
        return Promise.reject(new Error("duplicate api key"));
      }
      const apiKey: ApiKey = {
        key,
        siteId: input.siteId,
        scope: input.scope,
        createdAt: new Date().toISOString()
      };
      keys.set(key, apiKey);
      return Promise.resolve(apiKey);
    },
    revokeKey(key: string): Promise<boolean> {
      return Promise.resolve(keys.delete(key));
    },
    getLicenseKey(): Promise<string | null> {
      return Promise.resolve(licenseKey);
    },
    setLicenseKey(key: string | null): Promise<void> {
      licenseKey = key;
      return Promise.resolve();
    }
  };
}
