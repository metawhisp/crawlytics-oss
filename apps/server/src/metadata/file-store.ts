import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AlertsConfig, AlertsState } from "../alerts/config.js";
import type { ApiKey, CreateKeyInput, CreateSiteInput, MetadataStore, Site } from "./store.js";
import { generateApiKey } from "./store.js";

interface FileData {
  sites: Site[];
  keys: ApiKey[];
  /** License key entered at runtime (UI/env), persisted so it survives restarts. */
  license?: string | null;
  /** Alerts config + cooldown state — persisted so a restart doesn't re-send alerts. */
  alerts?: { config: AlertsConfig | null; state: AlertsState };
}

function fail(error: unknown): Promise<never> {
  return Promise.reject(error instanceof Error ? error : new Error(String(error)));
}

/**
 * File-backed MetadataStore: sites + scoped API keys persist to a JSON file so
 * they survive restarts (in-memory does not). Writes are atomic (temp + rename)
 * and rare, so synchronous IO is fine. Single-writer / single-process only — two
 * processes on the same file would lose writes. Self-host needs no Postgres for
 * this; Postgres is reserved for multi-tenant Cloud.
 */
export function createFileStore(filePath: string): MetadataStore {
  const sites = new Map<string, Site>();
  const keys = new Map<string, ApiKey>();
  let licenseKey: string | null = null;
  let alertsConfig: AlertsConfig | null = null;
  let alertsState: AlertsState = {};

  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<FileData>;
      for (const site of raw.sites ?? []) {
        sites.set(site.id, site);
      }
      for (const key of raw.keys ?? []) {
        keys.set(key.key, key);
      }
      licenseKey = raw.license ?? null;
      alertsConfig = raw.alerts?.config ?? null;
      alertsState = raw.alerts?.state ?? {};
    } catch {
      // Corrupt/unreadable: quarantine the bad file (so the next write does not
      // silently clobber it) and start empty rather than crash the server.
      try {
        renameSync(filePath, `${filePath}.corrupt.${String(Date.now())}`);
      } catch {
        // best effort
      }
      console.warn(`metadata file unreadable; quarantined and starting empty: ${filePath}`);
    }
  }

  function persist(): void {
    const data: FileData = {
      sites: [...sites.values()],
      keys: [...keys.values()],
      license: licenseKey,
      alerts: { config: alertsConfig, state: alertsState }
    };
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, filePath);
  }

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
      const site: Site = { id: input.id, domain: input.domain ?? "", createdAt: new Date().toISOString() };
      sites.set(site.id, site);
      try {
        persist();
      } catch (error) {
        sites.delete(site.id); // roll back so memory matches disk
        return fail(error);
      }
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
      const apiKey: ApiKey = { key, siteId: input.siteId, scope: input.scope, createdAt: new Date().toISOString() };
      keys.set(key, apiKey);
      try {
        persist();
      } catch (error) {
        keys.delete(key); // roll back
        return fail(error);
      }
      return Promise.resolve(apiKey);
    },
    revokeKey(key: string): Promise<boolean> {
      const existing = keys.get(key);
      if (existing === undefined) {
        return Promise.resolve(false);
      }
      keys.delete(key);
      try {
        persist();
      } catch (error) {
        keys.set(key, existing); // roll back
        return fail(error);
      }
      return Promise.resolve(true);
    },
    getLicenseKey(): Promise<string | null> {
      return Promise.resolve(licenseKey);
    },
    setLicenseKey(key: string | null): Promise<void> {
      const previous = licenseKey;
      licenseKey = key;
      try {
        persist();
      } catch (error) {
        licenseKey = previous; // roll back so memory matches disk
        return fail(error);
      }
      return Promise.resolve();
    },
    getAlertsConfig(): Promise<AlertsConfig | null> {
      return Promise.resolve(alertsConfig);
    },
    setAlertsConfig(config: AlertsConfig): Promise<void> {
      const previous = alertsConfig;
      alertsConfig = config;
      try {
        persist();
      } catch (error) {
        alertsConfig = previous; // roll back
        return fail(error);
      }
      return Promise.resolve();
    },
    getAlertsState(): Promise<AlertsState> {
      return Promise.resolve({ ...alertsState });
    },
    setAlertsState(state: AlertsState): Promise<void> {
      const previous = alertsState;
      alertsState = { ...state };
      try {
        persist();
      } catch (error) {
        alertsState = previous; // roll back
        return fail(error);
      }
      return Promise.resolve();
    }
  };
}
