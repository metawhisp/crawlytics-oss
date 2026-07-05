export interface Kpis {
  aiHits: number;
  uniqueBots: number;
  verified: number;
  spoofed: number;
  aiReferrals: number;
  botErrors: number;
}

export interface BotRow {
  botId: string;
  operator: string;
  actorType: string;
  hits: number;
  pages: number;
  spoofed: number;
  errors: number;
  lastSeen: string;
}

export interface PageRow {
  pathGroup: string;
  aiHits: number;
  trainingHits: number;
  searchHits: number;
  fetcherHits: number;
  bots: number;
  hits: number;
  lastAiHit: string;
}

export interface Overview {
  kpis: Kpis;
  prevKpis: Kpis;
  timeseries: Array<Record<string, number | string>>;
  topBots: BotRow[];
  topPages: PageRow[];
  referrals: Array<{ source: string; hits: number }>;
  recent: Array<{
    ts: string;
    actorType: string;
    botId: string;
    operator: string;
    verification: string;
    path: string;
    aiReferral: string;
    status: number;
  }>;
  sites: string[];
}

export interface BotDetail {
  timeseries: Array<{ t: string; hits: number }>;
  topPages: Array<{ path: string; hits: number; errors: number; lastSeen: string }>;
  statuses: Array<{ statusClass: string; hits: number }>;
  sources: Array<{ ip: string; country: string; asOrg: string; hits: number; verification: string }>;
  countries: Array<{ country: string; hits: number }>;
}

export interface Security {
  spoofedByBot: Array<{ botId: string; hits: number; ips: number }>;
  spoofedSources: Array<{ ip: string; country: string; asOrg: string; claimedBot: string; hits: number; lastSeen: string }>;
}

export interface Session {
  /** Whether a valid license currently unlocks the dashboard. */
  dashboardEnabled: boolean;
  /** Present only when the dashboard is unlocked. */
  authed?: boolean;
  passwordRequired?: boolean;
}

export interface LicenseResult {
  ok: boolean;
  dashboardEnabled?: boolean;
  error?: string;
  note?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} -> ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(failure.error ?? `${url} -> ${response.status}`);
  }
  return (await response.json()) as T;
}

export const getSession = () => getJson<Session>("/api/session");

export async function login(password: string): Promise<boolean> {
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  return response.ok;
}

/** End the session — clears the cookie and revokes all outstanding sessions.
 * Returns false if the server did not confirm (so the UI must NOT drop the session). */
export async function logout(): Promise<boolean> {
  try {
    const response = await fetch("/api/logout", { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}

/** Submit a license key to unlock the dashboard at runtime (POST /api/license). */
export async function submitLicense(key: string): Promise<LicenseResult> {
  const response = await fetch("/api/license", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key })
  });
  const body = (await response.json().catch(() => ({}))) as {
    dashboardEnabled?: boolean;
    error?: string;
    note?: string;
  };
  return { ok: response.ok, ...body };
}

export interface Site {
  id: string;
  domain: string;
  createdAt: string;
}

export interface ApiKey {
  key: string;
  siteId: string;
  scope: "ingest" | "read";
  createdAt: string;
}

export interface SiteStatus {
  lastEventAt: string | null;
  recentEvents: number;
}

export const listSites = () => getJson<{ sites: Site[] }>("/api/v1/sites");
export const createSite = (id: string, domain: string) =>
  postJson<Site>("/api/v1/sites", domain ? { id, domain } : { id });
export const createKey = (siteId: string, scope: "ingest" | "read") =>
  postJson<ApiKey>(`/api/v1/sites/${encodeURIComponent(siteId)}/keys`, { scope });
export const getSiteStatus = (siteId: string) =>
  getJson<SiteStatus>(`/api/v1/sites/${encodeURIComponent(siteId)}/status`);

const qs = (site: string, hours: number) => `site=${encodeURIComponent(site)}&hours=${hours}`;

export const getOverview = (site: string, hours: number) => getJson<Overview>(`/api/v1/overview?${qs(site, hours)}`);
export const getBots = (site: string, hours: number) => getJson<{ bots: BotRow[] }>(`/api/v1/bots?${qs(site, hours)}`);
export const getBotDetail = (site: string, hours: number, botId: string) =>
  getJson<BotDetail>(`/api/v1/bot/${encodeURIComponent(botId)}?${qs(site, hours)}`);
export const getPages = (site: string, hours: number, q: string) =>
  getJson<{ pages: PageRow[] }>(`/api/v1/pages?${qs(site, hours)}&q=${encodeURIComponent(q)}`);
export const getSecurity = (site: string, hours: number) => getJson<Security>(`/api/v1/security?${qs(site, hours)}`);

export interface PagesDaily {
  /** Sorted YYYY-MM-DD date strings — the chart x-axis. */
  dates: string[];
  /** Top-N pages by total hits (most popular first) — drives the page selector. */
  pages: Array<{ page: string; total: number }>;
  /** Per page: hits-per-date aligned with `dates` (0 where no data). */
  series: Array<{ page: string; hits: number[] }>;
}

export const getPagesDaily = (site: string, days: number, limit = 30) =>
  getJson<PagesDaily>(`/api/v1/pages-daily?site=${encodeURIComponent(site)}&days=${days}&limit=${limit}`);

/** A landing page with its AI-engagement funnel: crawled -> surfaced -> clicked. */
export interface ReferralFunnel {
  page: string;
  crawled: number;
  surfaced: number;
  clicked: number;
}

export const getFunnels = (site: string, days: number, limit = 50) =>
  getJson<{ pages: ReferralFunnel[] }>(
    `/api/v1/funnels?site=${encodeURIComponent(site)}&days=${days}&limit=${limit}`
  );

export const exportCsvUrl = (site: string, hours: number, table: string) =>
  `/api/v1/export.csv?${qs(site, hours)}&table=${table}`;

export interface ExploreRow {
  key: string;
  value: number;
}

export const getExplore = (
  site: string,
  hours: number,
  metric: string,
  dimension: string,
  filters: Record<string, string>
) => {
  const extra = Object.entries(filters)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `&${key}=${encodeURIComponent(value)}`)
    .join("");
  return getJson<{ rows: ExploreRow[] }>(
    `/api/v1/explore?${qs(site, hours)}&metric=${metric}&dimension=${dimension}${extra}`
  );
};
