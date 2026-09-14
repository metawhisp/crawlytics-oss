import type { EnrichedEvent } from "@crawlytics/shared";

/**
 * The canonical integration dataset. It is deliberately shaped like a real log —
 * scanners, spoofed bots and infrastructure paths included — because every panel
 * defect found in production came from clean fixtures hiding messy reality.
 *
 * Every row here exists to make one promise checkable; see the comments.
 */
export const IT_SITE = "it_site";

/** A second site whose sensor never sees render assets (CDN in front). The
 * browser-behaviour filter has nothing to work with there and must fail OPEN. */
export const IT_SITE_NO_ASSETS = "it_noassets";

/** A human session that walks this many distinct paths is a scanner, not a reader. */
export const SCANNER_PATHS = [
  "/wp-login.php",
  "/wp-admin/install.php",
  "/wp-admin/setup-config.php",
  "/wp-json/wp/v2/users",
  "/phpmyadmin/index.php",
  "/administrator/index.php",
  "/.git/config",
  "/config.json",
  "/backup.sql",
  "/vendor/phpunit/phpunit/phpunit.xml",
  "/telescope/requests",
  "/_ignition/health-check",
  "/actuator/env",
  "/server-status",
  "/cgi-bin/luci",
  "/solr/admin/info/system",
  "/druid/index.html",
  "/jenkins/login",
  "/api/v1/settings",
  "/settings.json",
  "/.npmrc",
  "/.docker/config.json",
  "/uploads/shell.php",
  "/old/index.php",
  "/test.php"
];

/** A normal reader's session also touches many distinct URLs — bundles, images,
 * API calls. If those counted toward the scanner threshold, real readers would
 * be filed as sweeps. */
export const READER_ASSET_PATHS = Array.from({ length: 20 }, (_, i) => `/assets/chunk-${String(i)}.js`);

/** The shape a public site actually gets: many one-path sessions, no assets, spread
 * across addresses. A per-session path-count threshold never sees it. */
export const DISTRIBUTED_SCAN_SESSIONS = ["910001", "910002", "910003", "910004", "910005", "910006"];

interface Row {
  path: string;
  status?: number;
  count: number;
  actorType: string;
  botId?: string;
  operator?: string;
  verification?: string;
  aiReferral?: string;
  botIp?: string;
  sessionId?: string;
  minutesAgo?: number;
}

function expand(rows: Row[], startTs: number, siteId: string = IT_SITE): EnrichedEvent[] {
  const events: EnrichedEvent[] = [];
  let seq = 0;
  for (const row of rows) {
    for (let i = 0; i < row.count; i += 1) {
      seq += 1;
      const minutesAgo = (row.minutesAgo ?? 60) + i;
      events.push({
        site_id: siteId,
        ts: startTs - minutesAgo * 60_000,
        ip_hash: String(1_000_000 + seq),
        bot_ip: row.botIp ?? "",
        method: "GET",
        path: row.path,
        path_group: row.path,
        query: "",
        status: row.status ?? 200,
        bytes: 1024,
        response_ms: 30,
        ua: row.botId ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        actor_type: row.actorType,
        bot_id: row.botId ?? "",
        operator: row.operator ?? "",
        verification: row.verification ?? "na",
        referer: "",
        ai_referral: row.aiReferral ?? "",
        topic_id: "",
        country: "US",
        asn: 15169,
        as_org: "TEST-AS",
        session_id: row.sessionId ?? String(500_000 + seq),
        ingest_source: "api"
      });
    }
  }
  return events;
}

export function fixtureEvents(): EnrichedEvent[] {
  const now = Date.now();

  const rows: Row[] = [
    // --- /blog/alpha: a healthy content page. crawled(5) >= surfaced(4) >= clicked(3),
    // so it is the row that a real funnel WOULD satisfy.
    { path: "/blog/alpha", count: 3, actorType: "ai_training", botId: "gptbot", operator: "openai", verification: "verified" },
    { path: "/blog/alpha", count: 4, actorType: "ai_search", botId: "oai-searchbot", operator: "openai", verification: "verified" },
    { path: "/blog/alpha", count: 2, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "verified" },
    { path: "/blog/alpha", count: 3, actorType: "human", aiReferral: "chatgpt", sessionId: "700001" },
    // A browser session on a page AI already crawls. It must NOT become a blind
    // spot — the AI rows have to survive the browser filter to prove coverage.
    { path: "/blog/alpha", count: 1, actorType: "human", sessionId: "930001" },
    { path: "/assets/app.css", count: 1, actorType: "human", sessionId: "930001" },

    // --- A real search engine on a page AI also reads. Verified, welcome, and
    // not AI: a column under "AI attention" that counts it is answering a
    // different question than its heading asks.
    { path: "/blog/alpha", count: 1, actorType: "search_engine", botId: "googlebot", operator: "google", verification: "verified" },

    // --- An AI crawler whose vendor publishes no way to verify it. Not forged,
    // not proven — the third bucket the KPI has to show separately.
    { path: "/blog/alpha", count: 5, actorType: "ai_training", botId: "bytespider", operator: "bytedance", verification: "na" },

    // --- /blog/beta: a click with ZERO AI crawls. Impossible in a funnel,
    // ordinary in this data model — the row that proves the funnel is not one.
    { path: "/blog/beta", count: 1, actorType: "human", aiReferral: "perplexity", sessionId: "700002" },

    // --- /about: a live page that broke. Served 200 earlier in the window, then
    // started 404-ing to a VERIFIED AI bot. This is the row the "broken pages"
    // panel is supposed to be about.
    { path: "/about", count: 2, actorType: "ai_training", botId: "gptbot", operator: "openai", verification: "verified", minutesAgo: 2000 },
    { path: "/about", count: 5, status: 404, actorType: "ai_training", botId: "gptbot", operator: "openai", verification: "verified" },

    // --- /blog/sick: verified AI bot only ever got 500s. Same "never OK" as
    // /blog/ghost, completely different diagnosis — the server is failing, the
    // page is not missing.
    { path: "/blog/sick", count: 2, status: 500, actorType: "ai_search", botId: "oai-searchbot", operator: "openai", verification: "verified" },

    // --- /blog/ghost: AI keeps chasing a URL that never existed here. Same 404,
    // completely different fix (a redirect, not a repair).
    { path: "/blog/ghost", count: 3, status: 404, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "verified" },

    // --- /blog/omega: two identities nobody on this site has seen before, one
    // forged and one real, both arriving inside the alert window. The "new bot"
    // notice must be about the real one only — the forgery is what the spoof rule
    // is for, and saying it twice trains the owner to ignore both.
    // Deliberately its own page: a verified bot on /blog/alpha would move the
    // per-page bot count that a different test pins.
    { path: "/blog/omega", count: 2, actorType: "ai_fetcher", botId: "meta-externalagent", operator: "meta", verification: "spoofed", botIp: "198.51.100.30", minutesAgo: 5 },
    { path: "/blog/omega", count: 1, actorType: "ai_training", botId: "applebot-extended", operator: "apple", verification: "verified", minutesAgo: 5 },

    // --- /blog/phantom: the only page whose "it used to work" evidence is a
    // forgery. A rollup without a verification column cannot tell, so the broken
    // citation rule called this a broken citation — for a page no real AI bot
    // ever retrieved successfully.
    { path: "/blog/phantom", count: 3, status: 200, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "spoofed", minutesAgo: 2000 },
    { path: "/blog/phantom", count: 2, status: 404, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "verified", minutesAgo: 6 },

    // --- /docs/api: the positive control. Real retrieval bot, real successes,
    // now really broken — this is what the alert exists for, and it must survive
    // every filter added to keep the forgeries out.
    { path: "/docs/api", count: 2, status: 200, actorType: "ai_search", botId: "oai-searchbot", operator: "openai", verification: "verified", minutesAgo: 3000 },
    { path: "/docs/api", count: 2, status: 404, actorType: "ai_search", botId: "oai-searchbot", operator: "openai", verification: "verified", minutesAgo: 7 },

    // --- /guide/blocked: retrieval bots fetched it fine and still can. The only
    // errors now are a training crawler hitting the 403 the owner deliberately
    // set — the product itself recommends blocking training bots, so this must
    // never page anyone. The alert is about links assistants hand out.
    { path: "/guide/blocked", count: 2, status: 200, actorType: "ai_search", botId: "oai-searchbot", operator: "openai", verification: "verified", minutesAgo: 2800 },
    { path: "/guide/blocked", count: 2, status: 403, actorType: "ai_training", botId: "gptbot", operator: "openai", verification: "verified", minutesAgo: 8 },

    // --- /blog/train-only: crawled for training, never retrieved to answer
    // anyone. Training is not citation, so a 404 here is not a broken citation.
    // The new rollup holds every ai_* type, so dropping the actor_type filter
    // while moving the query would quietly turn this into an alert.
    { path: "/blog/train-only", count: 2, status: 200, actorType: "ai_training", botId: "gptbot", operator: "openai", verification: "verified", minutesAgo: 2500 },
    { path: "/blog/train-only", count: 2, status: 404, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "verified", minutesAgo: 9 },

    // --- Credential scan wearing an AI user-agent. Ranks ABOVE /about by error
    // count, exactly as in production, and must never be called a broken page.
    { path: "/.env", count: 6, status: 404, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "spoofed", botIp: "198.51.100.10" },
    { path: "/.aws/credentials", count: 4, status: 404, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "spoofed", botIp: "198.51.100.10" },
    { path: "/firebase-credentials.json", count: 3, status: 404, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "spoofed", botIp: "198.51.100.10" },

    // --- A forged burst inside the last hour, big enough to trip the spike
    // alert if anything counts it as AI traffic.
    { path: "/.env", count: 30, status: 404, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "spoofed", botIp: "198.51.100.10", minutesAgo: 2 },

    // --- A forgery now erroring on a page that genuinely served AI fine before.
    // This is the only shape that can reach the broken-citation rule, so it is
    // the only shape that proves the rule ignores forgeries.
    { path: "/blog/alpha", count: 5, status: 404, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "spoofed", botIp: "198.51.100.10", minutesAgo: 3 },

    // --- A forgery wearing an identity nobody else on this page uses, so the
    // bot COUNT changes when forgeries are excluded (a duplicate id would not).
    { path: "/blog/alpha", count: 2, actorType: "ai_fetcher", botId: "claude-user", operator: "anthropic", verification: "spoofed", botIp: "198.51.100.20", minutesAgo: 4 },

    // --- A page only a real search engine ever touched. No AI attention at all,
    // so a panel about AI attention must not list it.
    { path: "/only-search", count: 3, actorType: "search_engine", botId: "googlebot", operator: "google", verification: "verified" },

    // --- /robots.txt: real verified AI bots really do read it. It is not a
    // citation, and it currently outranks every content page.
    { path: "/robots.txt", count: 9, actorType: "ai_search", botId: "perplexitybot", operator: "perplexity", verification: "verified" },
    { path: "/robots.txt", count: 7, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "verified" },

    // --- One human session sweeping 25 distinct paths: a scanner, classified
    // "human" because its UA looks like a browser.
    ...SCANNER_PATHS.map((path) => ({ path, count: 1, actorType: "human", sessionId: "900001" })),

    // --- A legitimate blind spot: real page, three separate readers, no AI hits.
    // Each reader's browser also pulls the stylesheet, which is what marks them
    // as a renderer rather than a fetcher.
    { path: "/blog/gamma", count: 1, actorType: "human", sessionId: "900002" },
    { path: "/assets/app.css", count: 1, actorType: "human", sessionId: "900002" },
    { path: "/blog/gamma", count: 1, actorType: "human", sessionId: "900003" },
    { path: "/assets/app.css", count: 1, actorType: "human", sessionId: "900003" },
    { path: "/blog/gamma", count: 1, actorType: "human", sessionId: "900004" },
    { path: "/assets/app.css", count: 1, actorType: "human", sessionId: "900004" },

    // --- Distributed scan: six separate sessions, one path each, no assets.
    // This is the case the old >=20-paths-per-session filter could not see.
    ...DISTRIBUTED_SCAN_SESSIONS.map((sessionId) => ({
      path: "/.hidden-config",
      count: 1,
      actorType: "human",
      sessionId
    })),

    // --- ...and a forged AI hit on it. A scanner in an AI costume is not AI
    // coverage, so /blog/gamma must STILL count as a blind spot.
    { path: "/blog/gamma", count: 1, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "spoofed", botIp: "198.51.100.10" },

    // --- One reader on /blog/delta whose session also pulls 20 bundles. Only
    // content paths may count toward the scanner threshold, or this reader is
    // misfiled as a sweep and their page vanishes from blind spots.
    { path: "/blog/delta", count: 1, actorType: "human", sessionId: "900005" },
    ...READER_ASSET_PATHS.map((path) => ({ path, count: 1, actorType: "human", sessionId: "900005" })),

    // --- Forged AI traffic on a real content page: citations and the landing
    // channels must not count it, even though the path looks perfectly normal.
    { path: "/blog/alpha", count: 4, actorType: "ai_fetcher", botId: "chatgpt-user", operator: "openai", verification: "spoofed", botIp: "198.51.100.10" },

    // --- One IP wearing three different bot identities. bingbot is the most
    // recent (smallest minutesAgo), googlebot the most numerous.
    { path: "/", count: 5, actorType: "search_engine", botId: "googlebot", operator: "google", verification: "spoofed", botIp: "203.0.113.77", minutesAgo: 300 },
    { path: "/", count: 3, actorType: "ai_fetcher", botId: "claude-user", operator: "anthropic", verification: "spoofed", botIp: "203.0.113.77", minutesAgo: 200 },
    { path: "/", count: 1, actorType: "search_engine", botId: "bingbot", operator: "microsoft", verification: "spoofed", botIp: "203.0.113.77", minutesAgo: 10 }
  ];

  const noAssetSite: Row[] = [
    // Two readers, a real page, and not one asset anywhere on the site.
    { path: "/only-page", count: 1, actorType: "human", sessionId: "920001" },
    { path: "/only-page", count: 1, actorType: "human", sessionId: "920002" }
  ];

  return [...expand(rows, now), ...expand(noAssetSite, now, IT_SITE_NO_ASSETS)];
}
