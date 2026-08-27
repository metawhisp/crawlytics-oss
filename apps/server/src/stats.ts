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
  /** `claimedBot` is the identity used MOST RECENTLY by that IP; `claimedVariants`
   * is how many different identities it wore in the window (1 = a single mask). */
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

/** Daily hits per page for the top-N pages, aligned to a shared date axis. */
export interface PagesDailyResult {
  /** Sorted date strings (YYYY-MM-DD) present in the range — the chart x-axis. */
  dates: string[];
  /** Top-N pages by total hits, for the page selector (most popular first). */
  pages: Array<{ page: string; total: number }>;
  /** Per page: a hits-per-date array aligned with `dates` (0 where no data). */
  series: Array<{ page: string; hits: number[] }>;
}

/**
 * One landing page that an AI assistant sent people to, split by which class of
 * bot visited it.
 *
 * These are INDEPENDENT CHANNELS, not funnel stages. actor_type labels the bot
 * that made a request; a page can be fetched live without ever being crawled for
 * training, and a human can click through to a page no bot touched at all. Any
 * UI that stacks them as crawled -> surfaced -> clicked is claiming a nesting
 * the data cannot have.
 */
export interface AiLandingPageRow {
  page: string;
  /** ai_training hits — bots collecting text to train on. */
  training: number;
  /** ai_search hits — answer-engine indexers. */
  search: number;
  /** ai_fetcher hits — live retrieval while answering someone. */
  fetch: number;
  /** Humans who landed here via an AI referral (the actual click-throughs). */
  clicked: number;
}

/** A page AI actually cites — measured from real traffic, not sampled prompts. */
export interface CitedPageRow {
  page: string;
  /** Live on-demand fetches by assistants answering a user right now (ai_fetcher). */
  fetched: number;
  /** Hits by AI search indexers that surface pages in answers (ai_search). */
  surfaced: number;
  /** Humans who landed here from an AI assistant (ai_referral != ''). */
  clicked: number;
  lastCited: string;
}

export interface CitationsResult {
  pages: CitedPageRow[];
  /** Human click-throughs per assistant (ai_referral). */
  bySource: Array<{ source: string; clicks: number }>;
  /** AI crawl volume per vendor (operator). */
  byOperator: Array<{ operator: string; crawls: number }>;
  /** Latest retrieval-bot hits (ai_fetcher/ai_search) — the live citation feed. */
  feed: Array<{ ts: string; botId: string; operator: string; actorType: string; path: string; country: string }>;
  /** AI hits on paths excluded from `pages` — robots.txt, sitemaps, assets.
   * Real traffic, just not citations; surfaced so the number doesn't vanish. */
  infra: Array<{ page: string; hits: number }>;
}

/** Actionable crawl problems, straight from logs. */
export interface CrawlHealthResult {
  /** Pages where NON-SPOOFED AI bots hit >=400 — a citation link pointing at a
   * broken page. `everOk` distinguishes a page that died (true) from a URL that
   * never existed (false). */
  broken: Array<{ page: string; aiErrors: number; sampleStatus: number; lastHit: string; everOk: boolean }>;
  /** Pages humans visit but NO AI bot has crawled in the window — invisible to AI.
   * Scanner sessions are excluded; `readers` is the number of distinct sessions. */
  blindSpots: Array<{ page: string; humanHits: number; readers: number }>;
}

/** How much a vendor takes (crawls) vs gives back (human clicks from its assistant). */
export interface CrawlToReferRow {
  /** Crawl-side operator name, or the referral source when no crawler was seen. */
  vendor: string;
  crawls: number;
  clicks: number;
  /** clicks / crawls; null when crawls = 0 (can't divide — pure "sender"). */
  ratio: number | null;
  /** False when the vendor has no consumer assistant that could ever send clicks
   * (bytedance, amazon, ...) — "0 clicks" is expected there, not an insult. */
  hasAssistant: boolean;
}

export interface StatsStore {
  overview(site: string, hours: number): Promise<OverviewResult>;
  bots(site: string, hours: number): Promise<TopBotRow[]>;
  botDetail(site: string, hours: number, botId: string): Promise<BotDetailResult>;
  pages(site: string, hours: number, search: string): Promise<TopPageRow[]>;
  security(site: string, hours: number): Promise<SecurityResult>;
  /** Daily per-page hits for charting; returns the top `limit` pages by total. */
  pagesDaily(site: string, days: number, limit?: number): Promise<PagesDailyResult>;
  /** Landing pages that got AI referral click-throughs, split by bot class. */
  aiLandingPages(site: string, days: number, limit?: number): Promise<AiLandingPageRow[]>;
  /** Pages AI cites (live fetches, answer-index hits, human click-throughs) + live feed. */
  citations(site: string, days: number, limit?: number): Promise<CitationsResult>;
  /** Broken-citation pages (AI hit >=400) and AI blind spots (human-only pages). */
  crawlHealth(site: string, days: number, limit?: number): Promise<CrawlHealthResult>;
  /** Take-vs-give per AI vendor: crawl volume vs human clicks its assistant sends back. */
  crawlToRefer(site: string, days: number): Promise<{ rows: CrawlToReferRow[] }>;
}

const WINDOW = "site_id = {site:String} AND ts > now() - INTERVAL {hours:UInt32} HOUR";
const PREV_WINDOW =
  "site_id = {site:String} AND ts > now() - INTERVAL {hours2:UInt32} HOUR AND ts <= now() - INTERVAL {hours:UInt32} HOUR";

// Paths that are never "a page": static assets and infrastructure files. This
// lived inline in the blind-spots query only, so the citations panel shipped
// without it and ranked /robots.txt above every article on the site. One
// definition, every panel that talks about content.
const ASSET_EXTENSIONS =
  "css|js|mjs|map|json|xml|txt|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp3|mp4|webm|pdf|zip|gz";
const CONTENT_PATH_FILTER = `NOT match(path_group, '(?i)\\\\.(${ASSET_EXTENSIONS})$')
    AND NOT startsWith(path_group, '/.well-known/')`;

// Deliberately NARROWER than ASSET_EXTENSIONS: these are the files a browser
// pulls automatically to render a page. .json/.xml/.txt/.pdf are left out — a
// scanner requests those on purpose, a renderer does not.
const RENDER_ASSET_MATCH = `match(path_group, '(?i)\\\\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|woff2?)$')`;

// A forged user-agent is not an AI assistant reading you. Anything that claims
// to measure AI attention has to drop spoofed traffic, or a scanner wearing a
// ChatGPT UA shows up as a citation.
const NOT_SPOOFED = "verification != 'spoofed'";

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

// Landing pages that received AI referral click-throughs, each split by the bot
// class that visited. Queried from raw events because "clicked" needs
// ai_referral (the rollup only keeps actor_type).
//
// The three bot columns are disjoint by construction — actor_type is a single
// label per request — so they sum to the page's AI hits and must never be drawn
// as stages of one another.
const AI_LANDING_PAGES_QUERY = `
  SELECT path_group AS page,
         countIf(actor_type = 'ai_training') AS training_hits,
         countIf(actor_type = 'ai_search') AS search_hits,
         countIf(actor_type = 'ai_fetcher') AS fetch_hits,
         countIf(actor_type = 'human' AND ai_referral != '') AS clicked
  FROM events
  WHERE site_id = {site:String} AND ts >= now() - INTERVAL {days:UInt32} DAY
    AND ${NOT_SPOOFED}
  GROUP BY path_group
  HAVING clicked > 0
  ORDER BY clicked DESC, training_hits + search_hits + fetch_hits DESC
  LIMIT {limit:UInt32}`;

// Pages AI cites, from raw events (needs ai_referral alongside path_group, which
// the rollups don't keep). fetched = live per-prompt retrieval (the strongest
// "cited right now" signal), surfaced = answer-index crawls, clicked = humans
// arriving from an assistant.
const CITED_PAGES_QUERY = `
  SELECT path_group AS page,
         countIf(actor_type = 'ai_fetcher') AS fetched,
         countIf(actor_type = 'ai_search') AS surfaced,
         countIf(actor_type = 'human' AND ai_referral != '') AS clicked,
         max(ts) AS last_cited
  FROM events
  WHERE site_id = {site:String} AND ts >= now() - INTERVAL {days:UInt32} DAY
    AND (actor_type IN ('ai_fetcher', 'ai_search') OR (actor_type = 'human' AND ai_referral != ''))
    AND ${NOT_SPOOFED}
    AND ${CONTENT_PATH_FILTER}
  GROUP BY path_group
  ORDER BY (fetched + clicked) DESC, surfaced DESC
  LIMIT {limit:UInt32}`;

// The infrastructure traffic CITED_PAGES_QUERY drops. Not citations — real AI
// bots read robots.txt and sitemaps — but worth one line above the table so the
// number does not simply vanish from the dashboard.
const AI_INFRA_HITS_QUERY = `
  SELECT path_group AS page, count() AS hits
  FROM events
  WHERE site_id = {site:String} AND ts >= now() - INTERVAL {days:UInt32} DAY
    AND actor_type LIKE 'ai_%'
    AND ${NOT_SPOOFED}
    AND NOT (${CONTENT_PATH_FILTER})
  GROUP BY path_group
  ORDER BY hits DESC
  LIMIT 5`;

const CITED_BY_SOURCE_QUERY = `
  SELECT ai_referral AS source, count() AS clicks
  FROM events
  WHERE site_id = {site:String} AND ts >= now() - INTERVAL {days:UInt32} DAY
    AND actor_type = 'human' AND ai_referral != ''
  GROUP BY source ORDER BY clicks DESC`;

const CITED_BY_OPERATOR_QUERY = `
  SELECT operator, count() AS crawls
  FROM events
  WHERE site_id = {site:String} AND ts >= now() - INTERVAL {days:UInt32} DAY
    AND actor_type LIKE 'ai_%' AND operator != ''
    AND ${NOT_SPOOFED}
  GROUP BY operator ORDER BY crawls DESC`;

// Live feed: latest retrieval hits only (ai_fetcher/ai_search) — training crawls
// are volume noise here, they don't mean "cited". Time-bounded to the selected
// range so the query never scans all retained partitions on a large install.
const CITED_FEED_QUERY = `
  SELECT ts, bot_id, operator, actor_type, path, country
  FROM events
  WHERE site_id = {site:String} AND ts >= now() - INTERVAL {days:UInt32} DAY
    AND actor_type IN ('ai_fetcher', 'ai_search')
    AND ${NOT_SPOOFED}
  ORDER BY ts DESC LIMIT 30`;

// Pages where AI bots ran into errors — a broken page that AI links to or
// re-crawls is a lost citation. argMax(status, ts) = the most recent status.
//
// verification != 'spoofed' is load-bearing, not a nicety: a vulnerability
// scanner that forges an AI user-agent IS classified ai_*, so without this the
// panel fills up with /.env and /.aws/credentials probes and buries the real
// broken pages. 'unverified' stays in — most installs never enable verification,
// and dropping it would empty the panel for them.
//
// ever_ok answers "did this path ever work *for AI* in the window": false means
// AI is chasing a URL that never existed (fix with a redirect), true means a
// live page broke (fix the page).
const BROKEN_CITATIONS_QUERY = `
  SELECT path_group AS page,
         countIf(status >= 400) AS ai_errors,
         argMax(status, ts) AS sample_status,
         max(ts) AS last_hit,
         countIf(status < 400) > 0 AS ever_ok
  FROM events
  WHERE site_id = {site:String} AND ts >= now() - INTERVAL {days:UInt32} DAY
    AND actor_type LIKE 'ai_%'
    AND verification != 'spoofed'
  GROUP BY path_group
  HAVING ai_errors > 0
  ORDER BY ai_errors DESC
  LIMIT {limit:UInt32}`;

// Pages real humans read that no AI bot has fetched in the window — content
// invisible to AI. Needs human traffic as the baseline: sites that only ingest
// bot traffic get an empty list (documented in the UI empty-state).
// "Page" means successful GET/HEAD non-asset paths — otherwise every stylesheet,
// bundle and API endpoint humans load would show up as a "blind spot".
//
// This panel claims "pages PEOPLE read", so it may only count sessions that
// behaved like a browser — one that fetched at least one render asset. actor_type
// "human" is the classifier's fallback for any user-agent it does not recognise
// (matcher.ts:132). Measured on a live site: of 8809 sessions filed as "human",
// only 991 ever requested the main script — 89% never rendered anything.
//
// An earlier version excluded sessions that walked >= 20 distinct paths. It
// caught a single sweeping scanner and completely missed the distributed kind,
// which is what a public site actually gets — after that fix /.env still topped
// the list with 18 hits from 17 separate one-path sessions. Requiring browser
// behaviour catches both, because no scanner pulls the stylesheet.
//
// Fail-open via {browserOnly:UInt8}: a site whose assets are served by a CDN the
// sensor never sees has no render-asset rows at all, and filtering on them would
// empty the panel instead of cleaning it.
//
// Keys on session_id: bot_ip is empty for humans (enrich.ts:52) and ip_hash is
// re-salted daily, so neither identifies a visitor across the window.
const BLIND_SPOTS_QUERY = `
  SELECT path_group AS page,
         countIf(actor_type = 'human' AND status < 400) AS human_hits,
         uniqIf(session_id, actor_type = 'human' AND status < 400) AS readers
  FROM events
  WHERE site_id = {site:String} AND ts >= now() - INTERVAL {days:UInt32} DAY
    AND method IN ('GET', 'HEAD')
    AND ${CONTENT_PATH_FILTER}
    AND (
      -- Bot rows must ALWAYS survive this WHERE: they are what the HAVING below
      -- checks for AI coverage. Filtering them out here would make "no AI has
      -- seen this page" trivially true and turn every page into a blind spot.
      actor_type != 'human'
      OR {browserOnly:UInt8} = 0
      OR session_id IN (
        SELECT session_id FROM events
        WHERE site_id = {site:String} AND ts >= now() - INTERVAL {days:UInt32} DAY
          AND actor_type = 'human'
          AND ${RENDER_ASSET_MATCH}
        GROUP BY session_id
      )
    )
  GROUP BY path_group
  HAVING countIf(actor_type LIKE 'ai_%' AND ${NOT_SPOOFED}) = 0 AND human_hits > 0
  ORDER BY human_hits DESC
  LIMIT {limit:UInt32}`;

// Does this site's sensor see render assets at all? If not, the browser-behaviour
// filter has nothing to work with and must be skipped rather than empty the panel.
const HAS_RENDER_ASSETS_QUERY = `
  SELECT count() AS n
  FROM (
    SELECT 1 FROM events
    WHERE site_id = {site:String} AND ts >= now() - INTERVAL {days:UInt32} DAY
      AND actor_type = 'human' AND ${RENDER_ASSET_MATCH}
    LIMIT 1
  )`;

// Crawl volume per vendor from the daily rollup (cheap; no ai_referral needed
// here). `date > today() - days` = exactly the last `days` calendar dates
// including today — `>=` would silently include one extra day.
const CRAWLS_BY_OPERATOR_QUERY = `
  SELECT operator, sum(hits) AS crawls
  FROM daily_bot_stats
  WHERE site_id = {site:String} AND date > today() - {days:UInt32}
    AND actor_type LIKE 'ai_%' AND operator != ''
    AND ${NOT_SPOOFED}
  GROUP BY operator ORDER BY crawls DESC`;

// Human click-throughs per assistant from the daily referrals rollup.
const CLICKS_BY_SOURCE_QUERY = `
  SELECT ai_referral AS source, sum(hits) AS clicks
  FROM daily_referrals
  WHERE site_id = {site:String} AND date > today() - {days:UInt32}
  GROUP BY source ORDER BY clicks DESC`;

/** Crawl-side operator -> the ai_referral source of the same vendor's assistant. */
const OPERATOR_TO_REFERRAL: Record<string, string> = {
  openai: "chatgpt",
  anthropic: "claude",
  perplexity: "perplexity",
  google: "gemini",
  microsoft: "copilot",
  deepseek: "deepseek",
  xai: "grok",
  mistral: "mistral",
  meta: "meta"
};

/** Joins crawls (by operator) with clicks (by ai_referral) into take-vs-give rows.
 * Operators without a consumer assistant keep clicks=0; referral sources with no
 * observed crawler get crawls=0 and a null ratio (never divide by zero). */
export function joinCrawlToRefer(
  crawls: Array<{ operator: string; crawls: number }>,
  clicks: Array<{ source: string; clicks: number }>
): CrawlToReferRow[] {
  const clicksBySource = new Map(clicks.map((row) => [row.source, row.clicks]));
  const usedSources = new Set<string>();

  const rows: CrawlToReferRow[] = crawls.map((row) => {
    // Object.hasOwn: row.operator comes from the database, and a plain index
    // would resolve inherited members ("toString", "constructor") to functions.
    const source = Object.hasOwn(OPERATOR_TO_REFERRAL, row.operator) ? OPERATOR_TO_REFERRAL[row.operator] : undefined;
    const clicked = source !== undefined ? clicksBySource.get(source) ?? 0 : 0;
    if (source !== undefined && clicksBySource.has(source)) {
      usedSources.add(source);
    }
    return {
      vendor: row.operator,
      crawls: row.crawls,
      clicks: clicked,
      ratio: row.crawls > 0 ? clicked / row.crawls : null,
      hasAssistant: source !== undefined
    };
  });

  for (const row of clicks) {
    if (!usedSources.has(row.source)) {
      rows.push({ vendor: row.source, crawls: 0, clicks: row.clicks, ratio: null, hasAssistant: true });
    }
  }

  return rows.sort((a, b) => b.crawls - a.crawls || b.clicks - a.clicks || a.vendor.localeCompare(b.vendor));
}

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
      // argMax(..., ts), never any(): a forging IP rotates user-agents, and any()
      // returns an ARBITRARY member of the group. On a live site that labelled at
      // least 441 hits "chatgpt-user" while chatgpt-user's own spoofed total was
      // 349. claimed_variants exposes the rotation instead of hiding it.
      rows<{
        ip: string;
        country: string;
        as_org: string;
        claimed: string;
        claimed_variants: string;
        hits: string;
        last_seen: string;
      }>(
        // One argMax over a tuple, ordered by the whole tuple: picking bot_id,
        // country and as_org with three separate argMax calls could take them
        // from three different rows, and argMax on a tie is documented as
        // nondeterministic — second-resolution logs tie constantly. `ip` is the
        // secondary sort key so the 50-row cutoff is stable when many sources
        // share a hit count.
        `SELECT ip, latest.1 AS claimed, latest.2 AS country, latest.3 AS as_org,
                claimed_variants, hits, last_seen
         FROM (
           SELECT bot_ip AS ip,
                  argMax((bot_id, country, as_org), (ts, bot_id, country, as_org)) AS latest,
                  uniq(bot_id) AS claimed_variants,
                  count() AS hits, max(ts) AS last_seen
           FROM events WHERE ${WINDOW} AND verification = 'spoofed' AND bot_ip != ''
           GROUP BY bot_ip ORDER BY hits DESC, ip LIMIT 50
         )`,
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
        claimedVariants: toNum(row.claimed_variants),
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

  async function aiLandingPages(site: string, days: number, limit = 50): Promise<AiLandingPageRow[]> {
    const raw = await rows<{
      page: string;
      training_hits: string;
      search_hits: string;
      fetch_hits: string;
      clicked: string;
    }>(AI_LANDING_PAGES_QUERY, { site, days, limit });
    return raw.map((row) => ({
      page: row.page,
      training: toNum(row.training_hits),
      search: toNum(row.search_hits),
      fetch: toNum(row.fetch_hits),
      clicked: toNum(row.clicked)
    }));
  }

  async function citations(site: string, days: number, limit = 50): Promise<CitationsResult> {
    const params = { site, days };
    const [pages, bySource, byOperator, feed, infra] = await Promise.all([
      rows<{ page: string; fetched: string; surfaced: string; clicked: string; last_cited: string }>(
        CITED_PAGES_QUERY,
        { ...params, limit }
      ),
      rows<{ source: string; clicks: string }>(CITED_BY_SOURCE_QUERY, params),
      rows<{ operator: string; crawls: string }>(CITED_BY_OPERATOR_QUERY, params),
      rows<{ ts: string; bot_id: string; operator: string; actor_type: string; path: string; country: string }>(
        CITED_FEED_QUERY,
        params
      ),
      rows<{ page: string; hits: string }>(AI_INFRA_HITS_QUERY, params)
    ]);

    return {
      pages: pages.map((row) => ({
        page: row.page,
        fetched: toNum(row.fetched),
        surfaced: toNum(row.surfaced),
        clicked: toNum(row.clicked),
        lastCited: row.last_cited
      })),
      bySource: bySource.map((row) => ({ source: row.source, clicks: toNum(row.clicks) })),
      byOperator: byOperator.map((row) => ({ operator: row.operator, crawls: toNum(row.crawls) })),
      feed: feed.map((row) => ({
        ts: row.ts,
        botId: row.bot_id,
        operator: row.operator,
        actorType: row.actor_type,
        path: row.path,
        country: row.country
      })),
      infra: infra.map((row) => ({ page: row.page, hits: toNum(row.hits) }))
    };
  }

  async function crawlHealth(site: string, days: number, limit = 50): Promise<CrawlHealthResult> {
    const params = { site, days, limit };
    const assetProbe = await rows<{ n: string }>(HAS_RENDER_ASSETS_QUERY, { site, days });
    const browserOnly = toNum(assetProbe[0]?.n) > 0 ? 1 : 0;
    const [broken, blindSpots] = await Promise.all([
      rows<{ page: string; ai_errors: string; sample_status: string; last_hit: string; ever_ok: number }>(
        BROKEN_CITATIONS_QUERY,
        params
      ),
      rows<{ page: string; human_hits: string; readers: string }>(BLIND_SPOTS_QUERY, { ...params, browserOnly })
    ]);

    return {
      broken: broken.map((row) => ({
        page: row.page,
        aiErrors: toNum(row.ai_errors),
        sampleStatus: toNum(row.sample_status),
        lastHit: row.last_hit,
        everOk: toNum(row.ever_ok) === 1
      })),
      blindSpots: blindSpots.map((row) => ({
        page: row.page,
        humanHits: toNum(row.human_hits),
        readers: toNum(row.readers)
      }))
    };
  }

  async function crawlToRefer(site: string, days: number): Promise<{ rows: CrawlToReferRow[] }> {
    const params = { site, days };
    const [crawls, clicks] = await Promise.all([
      rows<{ operator: string; crawls: string }>(CRAWLS_BY_OPERATOR_QUERY, params),
      rows<{ source: string; clicks: string }>(CLICKS_BY_SOURCE_QUERY, params)
    ]);
    return {
      rows: joinCrawlToRefer(
        crawls.map((row) => ({ operator: row.operator, crawls: toNum(row.crawls) })),
        clicks.map((row) => ({ source: row.source, clicks: toNum(row.clicks) }))
      )
    };
  }

  return {
    overview,
    bots,
    botDetail,
    pages,
    security,
    pagesDaily,
    aiLandingPages,
    citations,
    crawlHealth,
    crawlToRefer
  };
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
