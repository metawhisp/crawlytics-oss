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
  /** `claimedBot` = identity used most recently by that IP; `claimedVariants` =
   * how many different identities it wore in the window. */
  spoofedSources: Array<{
    ip: string;
    country: string;
    asOrg: string;
    claimedBot: string;
    claimedVariants: number;
    hits: number;
    lastSeen: string;
  }>;
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

/**
 * A landing page AI sent people to, split by bot class. The three bot counts are
 * independent channels (one actor_type per request), NOT funnel stages: clicks
 * with zero crawls are ordinary here.
 */
export interface AiLandingPage {
  page: string;
  /** ai_training hits — bots collecting text to train on. */
  training: number;
  /** ai_search hits — answer-engine indexers. */
  search: number;
  /** ai_fetcher hits — live retrieval while answering someone. */
  fetch: number;
  /** Humans who arrived via an AI referral. */
  clicked: number;
}

// The route keeps its original path: it is an address, not a claim about nesting.
export const getAiLandingPages = (site: string, days: number, limit = 50) =>
  getJson<{ pages: AiLandingPage[] }>(
    `/api/v1/funnels?site=${encodeURIComponent(site)}&days=${days}&limit=${limit}`
  );

/** A page AI actually cites — measured from real traffic, not sampled prompts. */
export interface CitedPage {
  page: string;
  /** Live on-demand fetches by assistants answering a user right now (ai_fetcher). */
  fetched: number;
  /** Hits by AI search indexers that surface pages in answers (ai_search). */
  surfaced: number;
  /** Humans who landed here from an AI assistant. */
  clicked: number;
  lastCited: string;
}

export interface Citations {
  pages: CitedPage[];
  bySource: Array<{ source: string; clicks: number }>;
  byOperator: Array<{ operator: string; crawls: number }>;
  feed: Array<{ ts: string; botId: string; operator: string; actorType: string; path: string; country: string }>;
  /** AI hits on robots.txt, sitemaps and assets — real traffic, not citations.
   * Optional on purpose: a cached SPA can outlive a rollback to an API that
   * never sent this field, and reading `.length` off undefined would blank the
   * whole panel. The other new fields only render a number, so they can't throw. */
  infra?: Array<{ page: string; hits: number }>;
}

export const getCitations = (site: string, days: number, limit = 50) =>
  getJson<Citations>(`/api/v1/citations?site=${encodeURIComponent(site)}&days=${days}&limit=${limit}`);

/** Actionable crawl problems, straight from logs. */
export interface CrawlHealth {
  /** Pages where non-spoofed AI bots hit >=400 — a citation pointing at a broken
   * page. `everOk` false = the URL never worked, true = a live page broke. */
  broken: Array<{ page: string; aiErrors: number; sampleStatus: number; lastHit: string; everOk: boolean }>;
  /** Pages humans visit but no AI bot has crawled in the window. Scanner sessions
   * are excluded; `readers` is how many distinct sessions read the page. */
  blindSpots: Array<{ page: string; humanHits: number; readers: number }>;
}

export const getCrawlHealth = (site: string, days: number, limit = 50) =>
  getJson<CrawlHealth>(`/api/v1/crawl-health?site=${encodeURIComponent(site)}&days=${days}&limit=${limit}`);

/** Take-vs-give per AI vendor: crawls taken vs human clicks its assistant sends back. */
export interface CrawlToReferRow {
  vendor: string;
  crawls: number;
  clicks: number;
  /** clicks / crawls; null when crawls = 0. */
  ratio: number | null;
  /** False when the vendor has no consumer assistant — 0 clicks is expected. */
  hasAssistant: boolean;
}

export const getCrawlToRefer = (site: string, days: number) =>
  getJson<{ rows: CrawlToReferRow[] }>(`/api/v1/crawl-to-refer?site=${encodeURIComponent(site)}&days=${days}`);

export type BotPolicy = "allow" | "deny";

export const getRobotsSuggestion = (site: string, train: BotPolicy, search: BotPolicy, fetchPolicy: BotPolicy) =>
  getJson<{ robotsTxt: string; llmsTxt: string }>(
    `/api/v1/robots-suggestion?site=${encodeURIComponent(site)}&train=${train}&search=${search}&fetch=${fetchPolicy}`
  );

/** Alerts config. webhookUrl = "" means alerts are OFF (the default). */
export interface AlertsConfig {
  webhookUrl: string;
  rules: { spike: boolean; newBot: boolean; spoof: boolean; brokenCitation: boolean };
  spikeFactor: number;
  cooldownMinutes: number;
}

export const getAlerts = () => getJson<AlertsConfig>("/api/v1/alerts");

export async function putAlerts(config: AlertsConfig): Promise<AlertsConfig> {
  const response = await fetch("/api/v1/alerts", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config)
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(failure.error ?? `save failed (${response.status})`);
  }
  return (await response.json()) as AlertsConfig;
}

export const sendTestAlert = () => postJson<{ ok: boolean }>("/api/v1/alerts/test", {});

export const exportCsvUrl = (site: string, hours: number, table: string) =>
  `/api/v1/export.csv?${qs(site, hours)}&table=${table}`;

/** CSV export for the day-windowed tables (citations, funnels). */
export const exportDailyCsvUrl = (site: string, days: number, table: string) =>
  `/api/v1/export.csv?site=${encodeURIComponent(site)}&hours=24&table=${table}&days=${days}`;

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
