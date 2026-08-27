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
  WHERE site_id = {site:String} AND ts > now() - INTERVAL 7 DAY`;

// Half-open windows: current [now-win, now), prior [now-30d, now-win). The
// scalar prior_events guard keeps an empty-history site (first ingest ever)
// from firing "new bot" for every single bot it has ever seen.
const NEW_BOT_QUERY = `
  WITH (
    SELECT count() FROM events
    WHERE site_id = {site:String}
      AND ts >= now() - INTERVAL 30 DAY AND ts < now() - INTERVAL {win:UInt32} MINUTE
  ) AS prior_events
  SELECT bot_id
  FROM events
  WHERE site_id = {site:String} AND bot_id != '' AND ts >= now() - INTERVAL {win:UInt32} MINUTE
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

// Errors on pages that served citations fine in the last ~30 days — a link AI
// hands out is now broken. The outer scan is error-rows in the tick window
// only; the "previously cited fine" set comes from the daily_page_stats rollup
// (hits > errors implies at least one successful retrieval), never from a
// 30-day raw-events scan on every tick.
const BROKEN_CITATION_QUERY = `
  SELECT path_group, count() AS errors
  FROM events
  WHERE site_id = {site:String} AND actor_type LIKE 'ai_%' AND status >= 400
    AND ts > now() - INTERVAL {win:UInt32} MINUTE
    AND path_group IN (
      SELECT path_group FROM daily_page_stats
      WHERE site_id = {site:String} AND date > today() - 31
        AND actor_type IN ('ai_fetcher', 'ai_search')
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
        text: `Cited page broken on ${site}: ${row.path_group} now returns errors to AI bots (${row.errors} hits)`
      });
    }
  }

  return events;
}
