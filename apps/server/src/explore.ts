/**
 * Generic breakdown query builder for the Explore tab (OpenPanel-style
 * event explorer). Metrics, dimensions and filters are strict whitelists
 * mapped to SQL expressions; user values travel only as bound parameters.
 */

export interface ChQueryClientLike {
  query(options: {
    query: string;
    query_params?: Record<string, unknown>;
    format?: string;
  }): Promise<{ json(): Promise<unknown> }>;
}

export const EXPLORE_METRICS: Record<string, string> = {
  hits: "count()",
  bots: "uniqIf(bot_id, bot_id != '')",
  pages: "uniq(path_group)",
  sessions: "uniq(session_id)",
  bytes: "sum(bytes)",
  errors: "countIf(status >= 400)"
};

export const EXPLORE_DIMENSIONS: Record<string, string> = {
  bot_id: "if(bot_id = '', '(none)', bot_id)",
  operator: "if(operator = '', '(unknown)', operator)",
  actor_type: "actor_type",
  verification: "verification",
  country: "if(country = '', '(unknown)', country)",
  as_org: "if(as_org = '', '(unknown)', as_org)",
  path_group: "path_group",
  status: "concat(toString(intDiv(status, 100)), 'xx')",
  ai_referral: "if(ai_referral = '', '(none)', ai_referral)",
  hour: "toString(toHour(ts))",
  weekday: "toString(toDayOfWeek(ts))",
  ingest_source: "ingest_source"
};

export const EXPLORE_FILTERS: Record<string, string> = {
  actor_type: "actor_type",
  verification: "verification",
  operator: "operator",
  country: "country",
  bot_id: "bot_id"
};

export interface ExploreRequest {
  site: string;
  hours: number;
  metric: string;
  dimension: string;
  filters: Record<string, string>;
}

export interface ExploreRow {
  key: string;
  value: number;
}

export async function exploreQuery(
  client: ChQueryClientLike,
  request: ExploreRequest
): Promise<ExploreRow[]> {
  // Object.hasOwn, not a truthiness check: `metric = "toString"` would otherwise
  // resolve through Object.prototype and splice a function body into the SQL.
  if (!Object.hasOwn(EXPLORE_METRICS, request.metric)) {
    throw new Error(`unknown metric: ${request.metric}`);
  }
  const metricSql = EXPLORE_METRICS[request.metric] as string;
  if (!Object.hasOwn(EXPLORE_DIMENSIONS, request.dimension)) {
    throw new Error(`unknown dimension: ${request.dimension}`);
  }
  const dimensionSql = EXPLORE_DIMENSIONS[request.dimension] as string;

  const params: Record<string, unknown> = { site: request.site, hours: request.hours };
  const conditions = ["site_id = {site:String}", "ts > now() - INTERVAL {hours:UInt32} HOUR"];

  for (const [key, value] of Object.entries(request.filters)) {
    if (!Object.hasOwn(EXPLORE_FILTERS, key)) {
      throw new Error(`unknown filter: ${key}`);
    }
    const column = EXPLORE_FILTERS[key] as string;
    if (value === "") {
      continue;
    }
    conditions.push(`${column} = {f_${key}:String}`);
    params[`f_${key}`] = value;
  }

  const query = `
    SELECT ${dimensionSql} AS key, ${metricSql} AS value
    FROM events
    WHERE ${conditions.join(" AND ")}
    GROUP BY key
    ORDER BY value DESC
    LIMIT 50`;

  const result = await client.query({ query, query_params: params, format: "JSONEachRow" });
  const rows = (await result.json()) as Array<{ key: string; value: string | number }>;
  return rows.map((row) => ({ key: row.key, value: Number(row.value) || 0 }));
}
