import { randomBytes } from "node:crypto";

/**
 * Metadata layer contract (sites, API keys, license). Backed by an in-memory
 * store (tests + env fallback) and, later, Postgres/Drizzle. Keys carry a
 * scope so the public read API / MCP can use read-only bearer keys that are
 * distinct from ingest keys and from the dashboard session.
 */

export type KeyScope = "ingest" | "read";

export interface Site {
  id: string;
  domain: string;
  createdAt: string;
}

export interface ApiKey {
  key: string;
  siteId: string;
  scope: KeyScope;
  createdAt: string;
}

export interface CreateSiteInput {
  id: string;
  domain?: string;
}

export interface CreateKeyInput {
  siteId: string;
  scope: KeyScope;
  /** Explicit key value; generated when omitted. */
  key?: string;
}

export interface MetadataStore {
  /** Resolve an ingest-scoped key to its site id, or null. */
  resolveIngestKey(key: string): Promise<string | null>;
  /** Resolve a read-scoped key to its site id, or null. */
  resolveReadKey(key: string): Promise<string | null>;
  listSites(): Promise<Site[]>;
  getSite(id: string): Promise<Site | null>;
  createSite(input: CreateSiteInput): Promise<Site>;
  listKeys(siteId: string): Promise<ApiKey[]>;
  createKey(input: CreateKeyInput): Promise<ApiKey>;
  revokeKey(key: string): Promise<boolean>;
  /** The stored license key, or null. Lets the UI persist a key entered at runtime. */
  getLicenseKey(): Promise<string | null>;
  /** Persist (or clear with null) the license key. */
  setLicenseKey(key: string | null): Promise<void>;
}

/** `cwi_…` for ingest, `cwr_…` for read — the prefix makes scope visible. */
export function generateApiKey(scope: KeyScope): string {
  const prefix = scope === "ingest" ? "cwi" : "cwr";
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}
