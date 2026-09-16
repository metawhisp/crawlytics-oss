/** Alert rule evaluation. Each rule is one short parameterized ClickHouse query
 * over a small window — cheap enough to run every few minutes. */

import type { ChQueryClientLike } from "../explore.js";
import type { AlertEvent, AlertRulesConfig } from "./config.js";

/** Below this many AI hits/hour a "spike" is noise, whatever the ratio says —
 * cold-start and low-traffic sites must not page their owner. */
export const SPIKE_MIN_HITS = 20;

// The baseline EXCLUDES the current hour — otherwise a brand-new site's very
// first burst is its own baseline and instantly "spikes". avg_hour = 0 (no
// prior history) never fires: cold starts are not anomalies.
const SPIKE_QUERY = `
  SELECT countIf(ts > now() - INTERVAL 1 HOUR AND actor_type LIKE 'ai_%') AS last_hour,
         countIf(ts <= now() - INTERVAL 1 HOUR AND actor_type LIKE 'ai_%') / (24 * 7 - 1) AS avg_hour
  FROM events
  WHERE site_id = {site:String} AND ts > now() - INTERVAL 7 DAY
    AND verification != 'spoofed'`;

// Half-open windows: current [now-win, now), prior [now-30d, now-win). The
// scalar prior_events guard keeps an empty-history site (first ingest ever)
// from firing "new bot" for every single bot it has ever seen.
//
// Forgeries are excluded from the CURRENT window only. A credential scanner
// wearing a fresh AI user-agent is not a new bot, and the spoof rule already
// reports it — announcing it twice teaches the owner to ignore both.
//
// The 30-day history is deliberately NOT filtered the same way, and the
// asymmetry is the point. Eight registry entries (gptbot, chatgpt-user,
// claudebot, claude-user, claude-searchbot, oai-searchbot, perplexitybot,
// perplexity-user) are verified against a vendor IP list with no reverse-DNS
// fallback, and a stale list is served rather than no list at all. Filtering the
// history would mean that every time a lagging list caught up, a bot that had
// been real all along would be announced as new. A missed notice about a real
// bot whose name a forgery once wore is the cheaper mistake.
const NEW_BOT_QUERY = `
  WITH (
    SELECT count() FROM events
    WHERE site_id = {site:String}
      AND ts >= now() - INTERVAL 30 DAY AND ts < now() - INTERVAL {win:UInt32} MINUTE
  ) AS prior_events
  SELECT bot_id
  FROM events
  WHERE site_id = {site:String} AND bot_id != '' AND ts >= now() - INTERVAL {win:UInt32} MINUTE
    AND verification != 'spoofed'
    AND prior_events > 0
    AND bot_id NOT IN (
      SELECT DISTINCT bot_id FROM events
      WHERE site_id = {site:String} AND bot_id != ''
        AND ts >= now() - INTERVAL 30 DAY AND ts < now() - INTERVAL {win:UInt32} MINUTE
    )
  GROUP BY bot_id
  LIMIT 20`;

const SPOOF_QUERY = `
  SELECT bot_id, count() AS hits
  FROM events
  WHERE site_id = {site:String} AND verification = 'spoofed'
    AND ts > now() - INTERVAL {win:UInt32} MINUTE
  GROUP BY bot_id
  ORDER BY hits DESC
  LIMIT 20`;

// Errors on pages real retrieval bots fetched fine in the last ~30 days — a link an
// assistant may still be handing out is now broken. The error itself must come from a bot that is not a
// forgery, or a credential scanner wearing an AI user-agent pages the owner
// every time it probes /.env.
//
// The "previously fine" set has to exclude forgeries too, and daily_page_stats
// cannot: it has no verification column. An earlier version of this comment
// argued that a forgery in the past "can only ADD a candidate" and was therefore
// safe. That is the bug, not the proof — a page whose only successful history is
// a forged 200 has never been cited by anything, so a real 404 on it today is
// not a broken citation. It reads daily_page_ai_stats now, which keeps
// verification in the sort key.
//
// The actor_type filter is load-bearing on BOTH sides and must survive any
// future move. The rollup holds every ai_* type, and a training crawl is not a
// link an assistant hands out. On the current side it matters just as much: this
// product recommends blocking training bots in robots.txt, so the 403 that
// advice produces would otherwise page the owner about a page whose retrieval
// bots are perfectly happy.
//
// 401 and 403 are not breakage: they are a door the owner closed. actor_type
// cannot see this — a fetcher blocked in robots.txt gets a 403 and is still a
// retrieval bot — so the status has to say it. Measured on the integration
// fixture: without this line, blocking ChatGPT-User pages the owner about every
// page it then asks for. The broken-pages panel (stats.ts) carries the same
// exclusion, because it is the same judgement.
//
// Still a rollup, not a 30-day raw scan on every tick: hits > errors implies at
// least one successful retrieval. The outer scan stays on error rows inside the
// tick window only.
//
// Known and accepted: this trusts "not marked spoofed", not "genuine". Six
// retrieval bots are verified by vendor IP list alone, with no reverse-DNS
// fallback, so a stale list marks a real bot as forged — and a page whose only
// successes came out that way will not alert when it really breaks.
const BROKEN_CITATION_QUERY = `
  SELECT path_group, count() AS errors
  FROM events
  WHERE site_id = {site:String}
    AND actor_type IN ('ai_fetcher', 'ai_search') AND status >= 400
    AND status NOT IN (401, 403)
    AND verification != 'spoofed'
    AND ts > now() - INTERVAL {win:UInt32} MINUTE
    AND path_group IN (
      SELECT path_group FROM daily_page_ai_stats
      WHERE site_id = {site:String} AND date > today() - 31
        AND actor_type IN ('ai_fetcher', 'ai_search')
        AND verification != 'spoofed'
      GROUP BY path_group
      HAVING sum(hits) > sum(errors)
    )
  GROUP BY path_group
  LIMIT 20`;

export interface EvaluateOptions {
  rules: AlertRulesConfig;
  spikeFactor: number;
  /** Look-back for the per-tick rules (new bot / spoof / broken citation). */
  windowMinutes: number;
}

export async function evaluateRules(
  client: ChQueryClientLike,
  site: string,
  options: EvaluateOptions
): Promise<AlertEvent[]> {
  async function rows<T>(query: string, params: Record<string, unknown>): Promise<T[]> {
    const result = await client.query({ query, query_params: params, format: "JSONEachRow" });
    return (await result.json()) as T[];
  }

  const events: AlertEvent[] = [];
  const win = { site, win: options.windowMinutes };

  if (options.rules.spike) {
    const [row] = await rows<{ last_hour: string; avg_hour: string }>(SPIKE_QUERY, { site });
    const lastHour = Number(row?.last_hour ?? 0);
    const avgHour = Number(row?.avg_hour ?? 0);
    // avgHour > 0 = there IS prior history; without it there's no baseline to spike from
    if (lastHour >= SPIKE_MIN_HITS && avgHour > 0 && lastHour > options.spikeFactor * avgHour) {
      events.push({
        rule: "spike",
        site,
        subject: "ai-traffic",
        text: `AI traffic spike on ${site}: ${String(lastHour)} hits in the last hour (avg ${avgHour.toFixed(1)}/h)`
      });
    }
  }

  if (options.rules.newBot) {
    for (const row of await rows<{ bot_id: string }>(NEW_BOT_QUERY, win)) {
      events.push({
        rule: "new_bot",
        site,
        subject: row.bot_id,
        text: `New bot on ${site}: ${row.bot_id} (first time in 30 days)`
      });
    }
  }

  if (options.rules.spoof) {
    for (const row of await rows<{ bot_id: string; hits: string }>(SPOOF_QUERY, win)) {
      events.push({
        rule: "spoof",
        site,
        subject: row.bot_id,
        text: `Spoofed bot on ${site}: something pretending to be ${row.bot_id} (${row.hits} hits)`
      });
    }
  }

  if (options.rules.brokenCitation) {
    for (const row of await rows<{ path_group: string; errors: string }>(BROKEN_CITATION_QUERY, win)) {
      events.push({
        rule: "broken_citation",
        site,
        subject: row.path_group,
        text: `Page AI was fetching is broken on ${site}: ${row.path_group} now returns errors to AI bots (${row.errors} hits)`
      });
    }
  }

  return events;
}
