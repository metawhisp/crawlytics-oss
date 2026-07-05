/** Query layer for the dashboard. All queries are parameterized — never interpolate. */

export interface ChQueryClientLike {
  query(options: {
    query: string;
    query_params?: Record<string, unknown>;
    format?: string;
  }): Promise<{ json(): Promise<unknown> }>;
}

export interface OverviewKpis {
  aiHits: number;
  uniqueBots: number;
  verified: number;
  spoofed: number;
  aiReferrals: number;
  botErrors: number;
}

export interface TopBotRow {
  botId: string;
  operator: string;
  actorType: string;
  hits: number;
  pages: number;
  spoofed: number;
  errors: number;
  lastSeen: string;
}

export interface TopPageRow {
  pathGroup: string;
  aiHits: number;
  trainingHits: number;
  searchHits: number;
  fetcherHits: number;
  bots: number;
  hits: number;
  lastAiHit: string;
}

export interface RecentRow {
  ts: string;
  actorType: string;
  botId: string;
  operator: string;
  verification: string;
  path: string;
  aiReferral: string;
  status: number;
}

export interface OverviewResult {
  kpis: OverviewKpis;
  prevKpis: OverviewKpis;
  timeseries: Array<Record<string, number | string>>;
  topBots: TopBotRow[];
  topPages: TopPageRow[];
  referrals: Array<{ source: string; hits: number }>;
  recent: RecentRow[];
  sites: string[];
}

export interface BotDetailResult {
  timeseries: Array<{ t: string; hits: number }>;
  topPages: Array<{ path: string; hits: number; errors: number; lastSeen: string }>;
  statuses: Array<{ statusClass: string; hits: number }>;
  sources: Array<{ ip: string; country: string; asOrg: string; hits: number; verification: string }>;
  countries: Array<{ country: string; hits: number }>;
}

export interface SecurityResult {
  spoofedByBot: Array<{ botId: string; hits: number; ips: number }>;
  spoofedSources: Array<{ ip: string; country: string; asOrg: string; claimedBot: string; hits: number; lastSeen: string }>;
}

/** Daily hits per page for the top-N pages, aligned to a shared date axis. */
export interface PagesDailyResult {
  /** Sorted date strings (YYYY-MM-DD) present in the range — the chart x-axis. */
  dates: string[];
  /** Top-N pages by total hits, for the page selector (most popular first). */
  pages: Array<{ page: string; total: number }>;
  /** Per page: a hits-per-date array aligned with `dates` (0 where no data). */
  series: Array<{ page: string; hits: number[] }>;
}

/** One landing page with its AI-engagement funnel: crawled -> surfaced -> clicked. */
export interface ReferralFunnelRow {
  page: string;
  /** AI read the page (ai_training + ai_fetcher hits). */
  crawled: number;
  /** AI search engines hit the page (ai_search). */
  surfaced: number;
  /** Humans landed on the page via an AI referral (the actual click-throughs). */
  clicked: number;
}

export interface StatsStore {
  overview(site: string, hours: number): Promise<OverviewResult>;
  bots(site: string, hours: number): Promise<TopBotRow[]>;
  botDetail(site: string, hours: number, botId: string): Promise<BotDetailResult>;
  pages(site: string, hours: number, search: string): Promise<TopPageRow[]>;
  security(site: string, hours: number): Promise<SecurityResult>;
  /** Daily per-page hits for charting; returns the top `limit` pages by total. */
  pagesDaily(site: string, days: number, limit?: number): Promise<PagesDailyResult>;
  /** Landing pages that got AI referral click-throughs, with the crawled->surfaced->clicked funnel. */
  referralFunnels(site: string, days: number, limit?: number): Promise<ReferralFunnelRow[]>;
}

const WINDOW = "site_id = {site:String} AND ts > now() - INTERVAL {hours:UInt32} HOUR";
const PREV_WINDOW =
  "site_id = {site:String} AND ts > now() - INTERVAL {hours2:UInt32} HOUR AND ts <= now() - INTERVAL {hours:UInt32} HOUR";

const KPI_SELECT = `
  countIf(actor_type LIKE 'ai_%') AS ai_hits,
  uniqIf(bot_id, actor_type LIKE 'ai_%' AND bot_id != '') AS unique_bots,
  countIf(verification = 'verified') AS verified,
  countIf(verification = 'spoofed') AS spoofed,
  countIf(ai_referral != '') AS ai_referrals,
  countIf(actor_type != 'human' AND status >= 400) AS bot_errors`;

const BOTS_QUERY = `
  SELECT bot_id, any(operator) AS operator, any(actor_type) AS actor_type,
         count() AS hits, uniq(path) AS pages,
         countIf(verification = 'spoofed') AS spoofed,
         countIf(status >= 400) AS errors, max(ts) AS last_seen
  FROM events WHERE ${WINDOW} AND bot_id != ''
  GROUP BY bot_id ORDER BY hits DESC LIMIT {limit:UInt32}`;

const PAGES_QUERY = `
  SELECT path_group,
         countIf(actor_type LIKE 'ai_%') AS ai_hits,
         countIf(actor_type = 'ai_training') AS training_hits,
         countIf(actor_type = 'ai_search') AS search_hits,
         countIf(actor_type = 'ai_fetcher') AS fetcher_hits,
         uniqIf(bot_id, bot_id != '') AS bots, count() AS hits,
         maxIf(ts, actor_type LIKE 'ai_%') AS last_ai_hit
  FROM events WHERE ${WINDOW}
    AND ({q:String} = '' OR positionCaseInsensitive(path_group, {q:String}) > 0)
  GROUP BY path_group HAVING ai_hits > 0 OR bots > 0
  ORDER BY ai_hits DESC, hits DESC LIMIT {limit:UInt32}`;

// Daily AI hits per page from the rollup, restricted to the top-N pages by total
// AI hits. AI-only (actor_type LIKE 'ai_%') — the rollup also holds human/search/
// social rows, which must not pollute an "AI hits per page" chart.
const PAGES_DAILY_QUERY = `
  SELECT date, path_group AS page, sum(hits) AS hits
  FROM daily_page_stats
  WHERE site_id = {site:String} AND date >= today() - {days:UInt32} AND actor_type LIKE 'ai_%'
    AND path_group IN (
      SELECT path_group FROM daily_page_stats
      WHERE site_id = {site:String} AND date >= today() - {days:UInt32} AND actor_type LIKE 'ai_%'
      GROUP BY path_group ORDER BY sum(hits) DESC LIMIT {limit:UInt32}
    )
  GROUP BY date, page
  ORDER BY page, date`;

// Landing pages that received AI referral click-throughs, each with its
// crawled -> surfaced -> clicked funnel. Queried from raw events because the
// "clicked" stage needs ai_referral (the rollup only keeps actor_type).
const REFERRAL_FUNNELS_QUERY = `
  SELECT path_group AS page,
         countIf(actor_type IN ('ai_training', 'ai_fetcher')) AS crawled,
         countIf(actor_type = 'ai_search') AS surfaced,
         countIf(actor_type = 'human' AND ai_referral != '') AS clicked
  FROM events
  WHERE site_id = {site:String} AND ts >= now() - INTERVAL {days:UInt32} DAY
  GROUP BY path_group
  HAVING clicked > 0
  ORDER BY clicked DESC, crawled DESC
  LIMIT {limit:UInt32}`;

export function createStatsStore(client: ChQueryClientLike): StatsStore {
  async function rows<T>(query: string, params?: Record<string, unknown>): Promise<T[]> {
    const result = await client.query({ query, query_params: params ?? {}, format: "JSONEachRow" });
    return (await result.json()) as T[];
  }

  function kpisFrom(row: Record<string, string> | undefined): OverviewKpis {
    return {
      aiHits: toNum(row?.["ai_hits"]),
      uniqueBots: toNum(row?.["unique_bots"]),
      verified: toNum(row?.["verified"]),
      spoofed: toNum(row?.["spoofed"]),
      aiReferrals: toNum(row?.["ai_referrals"]),
      botErrors: toNum(row?.["bot_errors"])
    };
  }

  function mapBots(rowsIn: Array<Record<string, string>>): TopBotRow[] {
    return rowsIn.map((row) => ({
      botId: row["bot_id"] ?? "",
      operator: row["operator"] ?? "",
      actorType: row["actor_type"] ?? "",
      hits: toNum(row["hits"]),
      pages: toNum(row["pages"]),
      spoofed: toNum(row["spoofed"]),
      errors: toNum(row["errors"]),
      lastSeen: row["last_seen"] ?? ""
    }));
  }

  function mapPages(rowsIn: Array<Record<string, string>>): TopPageRow[] {
    return rowsIn.map((row) => ({
      pathGroup: row["path_group"] ?? "",
      aiHits: toNum(row["ai_hits"]),
      trainingHits: toNum(row["training_hits"]),
      searchHits: toNum(row["search_hits"]),
      fetcherHits: toNum(row["fetcher_hits"]),
      bots: toNum(row["bots"]),
      hits: toNum(row["hits"]),
      lastAiHit: row["last_ai_hit"] ?? ""
    }));
  }

  async function overview(site: string, hours: number): Promise<OverviewResult> {
    const params = { site, hours };

    const [kpis, prevKpis, timeseries, topBots, topPages, referrals, recent, sites] = await Promise.all([
      rows<Record<string, string>>(`SELECT ${KPI_SELECT} FROM events WHERE ${WINDOW}`, params),
      rows<Record<string, string>>(`SELECT ${KPI_SELECT} FROM events WHERE ${PREV_WINDOW}`, {
        ...params,
        hours2: hours * 2
      }),
      rows<{ t: string; actor_type: string; c: string }>(
        `SELECT toStartOfHour(ts) AS t, actor_type, count() AS c
         FROM events WHERE ${WINDOW}
         GROUP BY t, actor_type ORDER BY t`,
        params
      ),
      rows<Record<string, string>>(BOTS_QUERY, { ...params, limit: 10 }),
      rows<Record<string, string>>(PAGES_QUERY, { ...params, q: "", limit: 10 }),
      rows<{ source: string; hits: string }>(
        `SELECT ai_referral AS source, count() AS hits
         FROM events WHERE ${WINDOW} AND ai_referral != ''
         GROUP BY source ORDER BY hits DESC`,
        params
      ),
      rows<{
        ts: string;
        actor_type: string;
        bot_id: string;
        operator: string;
        verification: string;
        path: string;
        ai_referral: string;
        status: number | string;
      }>(
        `SELECT ts, actor_type, bot_id, operator, verification, path, ai_referral, status
         FROM events WHERE ${WINDOW}
           AND (actor_type != 'human' OR ai_referral != '')
         ORDER BY ts DESC LIMIT 30`,
        params
      ),
      rows<{ site_id: string }>(`SELECT DISTINCT site_id FROM events ORDER BY site_id`)
    ]);

    return {
      kpis: kpisFrom(kpis[0]),
      prevKpis: kpisFrom(prevKpis[0]),
      timeseries: pivotTimeseries(timeseries),
      topBots: mapBots(topBots),
      topPages: mapPages(topPages),
      referrals: referrals.map((row) => ({ source: row.source, hits: toNum(row.hits) })),
      recent: recent.map((row) => ({
        ts: row.ts,
        actorType: row.actor_type,
        botId: row.bot_id,
        operator: row.operator,
        verification: row.verification,
        path: row.path,
        aiReferral: row.ai_referral,
        status: toNum(row.status)
      })),
      sites: sites.map((row) => row.site_id)
    };
  }

  async function bots(site: string, hours: number): Promise<TopBotRow[]> {
    return mapBots(await rows(BOTS_QUERY, { site, hours, limit: 100 }));
  }

  async function botDetail(site: string, hours: number, botId: string): Promise<BotDetailResult> {
    const params = { site, hours, bot: botId };
    const botWindow = `${WINDOW} AND bot_id = {bot:String}`;

    const [timeseries, topPages, statuses, sources, countries] = await Promise.all([
      rows<{ t: string; hits: string }>(
        `SELECT toStartOfHour(ts) AS t, count() AS hits FROM events WHERE ${botWindow} GROUP BY t ORDER BY t`,
        params
      ),
      rows<{ path: string; hits: string; errors: string; last_seen: string }>(
        `SELECT path, count() AS hits, countIf(status >= 400) AS errors, max(ts) AS last_seen
         FROM events WHERE ${botWindow} GROUP BY path ORDER BY hits DESC LIMIT 20`,
        params
      ),
      rows<{ status_class: string; hits: string }>(
        `SELECT concat(toString(intDiv(status, 100)), 'xx') AS status_class, count() AS hits
         FROM events WHERE ${botWindow} GROUP BY status_class ORDER BY status_class`,
        params
      ),
      rows<{ ip: string; country: string; as_org: string; hits: string; verification: string }>(
        `SELECT bot_ip AS ip, any(country) AS country, any(as_org) AS as_org,
                count() AS hits, any(verification) AS verification
         FROM events WHERE ${botWindow} AND bot_ip != ''
         GROUP BY bot_ip ORDER BY hits DESC LIMIT 20`,
        params
      ),
      rows<{ country: string; hits: string }>(
        `SELECT country, count() AS hits FROM events WHERE ${botWindow} AND country != ''
         GROUP BY country ORDER BY hits DESC LIMIT 10`,
        params
      )
    ]);

    return {
      timeseries: timeseries.map((row) => ({ t: row.t, hits: toNum(row.hits) })),
      topPages: topPages.map((row) => ({
        path: row.path,
        hits: toNum(row.hits),
        errors: toNum(row.errors),
        lastSeen: row.last_seen
      })),
      statuses: statuses.map((row) => ({ statusClass: row.status_class, hits: toNum(row.hits) })),
      sources: sources.map((row) => ({
        ip: row.ip,
        country: row.country,
        asOrg: row.as_org,
        hits: toNum(row.hits),
        verification: row.verification
      })),
      countries: countries.map((row) => ({ country: row.country, hits: toNum(row.hits) }))
    };
  }

  async function pages(site: string, hours: number, search: string): Promise<TopPageRow[]> {
    return mapPages(await rows(PAGES_QUERY, { site, hours, q: search, limit: 100 }));
  }

  async function security(site: string, hours: number): Promise<SecurityResult> {
    const params = { site, hours };
    const [byBot, sources] = await Promise.all([
      rows<{ bot_id: string; hits: string; ips: string }>(
        `SELECT bot_id, count() AS hits, uniq(bot_ip) AS ips
         FROM events WHERE ${WINDOW} AND verification = 'spoofed'
         GROUP BY bot_id ORDER BY hits DESC`,
        params
      ),
      rows<{ ip: string; country: string; as_org: string; claimed: string; hits: string; last_seen: string }>(
        `SELECT bot_ip AS ip, any(country) AS country, any(as_org) AS as_org,
                any(bot_id) AS claimed, count() AS hits, max(ts) AS last_seen
         FROM events WHERE ${WINDOW} AND verification = 'spoofed' AND bot_ip != ''
         GROUP BY bot_ip ORDER BY hits DESC LIMIT 50`,
        params
      )
    ]);

    return {
      spoofedByBot: byBot.map((row) => ({ botId: row.bot_id, hits: toNum(row.hits), ips: toNum(row.ips) })),
      spoofedSources: sources.map((row) => ({
        ip: row.ip,
        country: row.country,
        asOrg: row.as_org,
        claimedBot: row.claimed,
        hits: toNum(row.hits),
        lastSeen: row.last_seen
      }))
    };
  }

  async function pagesDaily(site: string, days: number, limit = 30): Promise<PagesDailyResult> {
    const raw = await rows<{ date: string; page: string; hits: string }>(PAGES_DAILY_QUERY, { site, days, limit });
    const dateSet = new Set<string>();
    const totals = new Map<string, number>();
    const byPage = new Map<string, Map<string, number>>();
    for (const row of raw) {
      const hits = toNum(row.hits);
      dateSet.add(row.date);
      totals.set(row.page, (totals.get(row.page) ?? 0) + hits);
      const perDate = byPage.get(row.page) ?? new Map<string, number>();
      perDate.set(row.date, hits);
      byPage.set(row.page, perDate);
    }
    const dates = [...dateSet].sort();
    const pages = [...totals.entries()]
      .map(([page, total]) => ({ page, total }))
      .sort((a, b) => b.total - a.total);
    const series = pages.map(({ page }) => ({
      page,
      hits: dates.map((date) => byPage.get(page)?.get(date) ?? 0)
    }));
    return { dates, pages, series };
  }

  async function referralFunnels(site: string, days: number, limit = 50): Promise<ReferralFunnelRow[]> {
    const raw = await rows<{ page: string; crawled: string; surfaced: string; clicked: string }>(
      REFERRAL_FUNNELS_QUERY,
      { site, days, limit }
    );
    return raw.map((row) => ({
      page: row.page,
      crawled: toNum(row.crawled),
      surfaced: toNum(row.surfaced),
      clicked: toNum(row.clicked)
    }));
  }

  return { overview, bots, botDetail, pages, security, pagesDaily, referralFunnels };
}

export function pivotTimeseries(
  rows: Array<{ t: string; actor_type: string; c: string | number }>
): Array<Record<string, number | string>> {
  const buckets = new Map<string, Record<string, number | string>>();
  for (const row of rows) {
    const bucket = buckets.get(row.t) ?? { t: row.t };
    bucket[row.actor_type] = toNum(row.c);
    buckets.set(row.t, bucket);
  }
  return [...buckets.values()];
}

/** Serializes rows to CSV (RFC 4180-ish, UTF-8). */
export function toCsv(rowsIn: Array<Record<string, unknown>>): string {
  if (rowsIn.length === 0) {
    return "";
  }
  const first = rowsIn[0];
  if (!first) {
    return "";
  }
  const headers = Object.keys(first);
  const escape = (value: unknown): string => {
    let text: string;
    if (typeof value === "string") {
      text = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      text = String(value);
    } else if (value == null) {
      text = "";
    } else {
      text = JSON.stringify(value);
    }
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [headers.join(",")];
  for (const row of rowsIn) {
    lines.push(headers.map((header) => escape(row[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function toNum(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
