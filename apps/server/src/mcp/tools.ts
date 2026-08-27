/**
 * MCP tool catalog — read-only analytics plus the pure robots.txt/llms.txt
 * generators.
 *
 * Tenant boundary: the site is taken from the read key that authenticated the
 * connection ({@link McpToolContext.siteId}), never from tool arguments. A model
 * that invents `site: "someone-else"` is silently ignored (zod strips unknown
 * keys), so a key can only ever read the site it was minted for.
 *
 * Nothing here mutates server state. Alert/webhook configuration deliberately
 * stays dashboard-only: a leaked read key must not be able to redirect alerts.
 */
import { z } from "zod";

import type { BotRegistryEntry } from "@crawlytics/registry";

import {
  EXPLORE_DIMENSIONS,
  EXPLORE_FILTERS,
  EXPLORE_METRICS,
  exploreQuery,
  type ChQueryClientLike
} from "../explore.js";
import type { MetadataStore } from "../metadata/store.js";
import { buildLlmsTxt, buildRobotsTxt } from "../robots.js";
import type { StatsStore } from "../stats.js";

/** Marks a failure whose message is safe to hand back to the model: bad
 * arguments, or a capability this server does not have. Everything else is
 * treated as internal and reported generically (it may embed SQL, schema or
 * host names). */
export class McpUserError extends Error {}

export interface McpToolContext {
  /** Site id resolved from the read key — the tenant boundary. */
  siteId: string;
  stats: StatsStore;
  metadata: MetadataStore;
  bots: BotRegistryEntry[];
  /** Raw ClickHouse client; only `explore` needs it. */
  chClient?: ChQueryClientLike;
  /** Server-side sink for unexpected tool failures (they are not shown to the model). */
  onError?: (error: unknown, toolName: string) => void;
}

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema advertised via tools/list. */
  inputSchema: Record<string, unknown>;
  run(ctx: McpToolContext, rawArgs: unknown): Promise<unknown>;
}

interface ArgSpec {
  zod: z.ZodTypeAny;
  json: Record<string, unknown>;
}

function intArg(options: { min: number; max: number; fallback: number; description: string }): ArgSpec {
  return {
    zod: z.coerce.number().int().min(options.min).max(options.max).default(options.fallback),
    json: {
      type: "integer",
      minimum: options.min,
      maximum: options.max,
      default: options.fallback,
      description: options.description
    }
  };
}

const hoursArg = (fallback: number): ArgSpec =>
  intArg({
    min: 1,
    max: 8760,
    fallback,
    description: "Look-back window in hours, counted back from now (max 8760 = 1 year)."
  });

const daysArg = (fallback: number): ArgSpec =>
  intArg({ min: 1, max: 365, fallback, description: "Look-back window in days, counted back from today." });

const limitArg = (max: number, fallback: number): ArgSpec =>
  intArg({ min: 1, max, fallback, description: `Maximum number of rows to return (up to ${String(max)}).` });

const enumArg = (values: string[], description: string): ArgSpec => ({
  // Object.hasOwn-style membership: `in` would accept inherited keys like "toString".
  zod: z.string().refine((value) => values.includes(value), {
    message: `must be one of: ${values.join(", ")}`
  }),
  json: { type: "string", enum: values, description }
});

const policyArg = (description: string): ArgSpec => ({
  zod: z.enum(["allow", "deny"]).default("allow"),
  json: { type: "string", enum: ["allow", "deny"], description }
});

function toolSchema(
  fields: Record<string, ArgSpec>,
  required: string[] = []
): { zod: z.ZodType<Record<string, unknown>>; json: Record<string, unknown> } {
  const shape: Record<string, z.ZodTypeAny> = {};
  const properties: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    shape[key] = spec.zod;
    properties[key] = spec.json;
  }
  return {
    // z.object() strips unknown keys — that is what neutralises an injected `site`.
    zod: z.object(shape),
    json: { type: "object", properties, ...(required.length > 0 ? { required } : {}) }
  };
}

/** Turns a zod failure into a message that names the offending argument, so the
 * model can correct itself on the next call instead of guessing. */
function parseArgs(schema: z.ZodType<Record<string, unknown>>, rawArgs: unknown): Record<string, unknown> {
  const parsed = schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.join(".") : "arguments";
    throw new McpUserError(`invalid argument "${path}": ${issue?.message ?? "validation failed"}`);
  }
  return parsed.data;
}

function defineTool(config: {
  name: string;
  description: string;
  fields: Record<string, ArgSpec>;
  required?: string[];
  run(ctx: McpToolContext, args: Record<string, unknown>): Promise<unknown>;
}): McpTool {
  const schema = toolSchema(config.fields, config.required ?? []);
  return {
    name: config.name,
    description: config.description,
    inputSchema: schema.json,
    // async, so an argument-validation failure surfaces as a rejected promise
    // rather than a synchronous throw the transport would have to special-case.
    run: async (ctx, rawArgs) => config.run(ctx, parseArgs(schema.zod, rawArgs))
  };
}

const num = (args: Record<string, unknown>, key: string): number => args[key] as number;
const str = (args: Record<string, unknown>, key: string): string => args[key] as string;

export const MCP_TOOLS: McpTool[] = [
  defineTool({
    name: "get_overview",
    description:
      "Headline AI-traffic KPIs for the site: AI crawler hits, unique bots, verified vs spoofed bot requests, AI referral click-throughs and bot errors, plus the hourly timeseries, top bots, top pages and recent activity. Start here to understand overall AI visibility.",
    fields: { hours: hoursArg(24) },
    run: async (ctx, args) => {
      const result = await ctx.stats.overview(ctx.siteId, num(args, "hours"));
      // Whitelist, not spread: overview() also carries `sites`, the dashboard's
      // GLOBAL site list (an unscoped SELECT DISTINCT site_id). Passing it
      // through would let one tenant's key enumerate every other site on the
      // instance. Anything added to OverviewResult later stays out by default.
      return {
        kpis: result.kpis,
        prevKpis: result.prevKpis,
        timeseries: result.timeseries,
        topBots: result.topBots,
        topPages: result.topPages,
        referrals: result.referrals,
        recent: result.recent,
        site: ctx.siteId
      };
    }
  }),
  defineTool({
    name: "get_citations",
    description:
      "Which pages AI actually cites, measured from real traffic (not simulated prompts): live on-demand fetches by assistants answering a user right now (ChatGPT-User, Claude-User, Perplexity-User), hits from AI search indexers, and the humans who clicked through from an assistant. Also returns clicks per assistant, crawl volume per vendor, and a live feed of the latest retrieval hits.",
    fields: { days: daysArg(30), limit: limitArg(100, 50) },
    run: (ctx, args) => ctx.stats.citations(ctx.siteId, num(args, "days"), num(args, "limit"))
  }),
  defineTool({
    name: "get_crawl_health",
    description:
      "Actionable problems: (1) broken citations — pages where AI crawlers received a 4xx/5xx, meaning a link inside an AI answer points at a broken page; (2) AI blind spots — pages humans visit but no AI crawler has fetched in the window, i.e. content invisible to AI. Use this to decide what to fix on the site.",
    fields: { days: daysArg(30), limit: limitArg(100, 50) },
    run: (ctx, args) => ctx.stats.crawlHealth(ctx.siteId, num(args, "days"), num(args, "limit"))
  }),
  defineTool({
    name: "get_take_vs_give",
    description:
      "Per AI vendor: how much it crawls (take) versus how many human visitors its assistant sends back (give), with the clicks/crawls ratio. Vendors without a consumer assistant are flagged so that zero clicks is not misread. Use it to decide which crawlers to allow or block.",
    fields: { days: daysArg(30) },
    run: (ctx, args) => ctx.stats.crawlToRefer(ctx.siteId, num(args, "days"))
  }),
  defineTool({
    name: "get_ai_landing_pages",
    description:
      "Landing pages that AI assistants sent humans to. Per page: training (bots collecting training text), search (answer-engine indexers), fetch (live retrieval while answering), clicked (humans who arrived via an AI referral). The three bot counts are INDEPENDENT CHANNELS measured from separate actor types, not funnel stages — a page can have clicks with zero crawls. Only pages that produced click-throughs are returned.",
    fields: { days: daysArg(30), limit: limitArg(100, 50) },
    run: async (ctx, args) => ({
      pages: await ctx.stats.aiLandingPages(ctx.siteId, num(args, "days"), num(args, "limit"))
    })
  }),
  defineTool({
    name: "get_pages_daily",
    description:
      "Daily AI-crawler hits per page over the window — a date axis plus one hits-per-day series per page. Use it for trends: which pages AI is reading more or less over time.",
    fields: { days: daysArg(30), limit: limitArg(50, 30) },
    run: (ctx, args) => ctx.stats.pagesDaily(ctx.siteId, num(args, "days"), num(args, "limit"))
  }),
  defineTool({
    name: "get_top_bots",
    description:
      "Every bot seen in the window with hit counts, distinct pages, spoofed-request count, error count and last-seen time. Covers AI crawlers as well as search engines, SEO tools and other automation.",
    fields: { hours: hoursArg(24) },
    run: async (ctx, args) => ({ bots: await ctx.stats.bots(ctx.siteId, num(args, "hours")) })
  }),
  defineTool({
    name: "get_bot_detail",
    description:
      "Deep dive on one bot: its activity timeseries, the pages it fetched, HTTP status breakdown, source IPs with network owner and verification status, and countries. Use after get_top_bots to investigate a specific crawler.",
    fields: { bot_id: { zod: z.string().min(1).max(200), json: { type: "string", description: "Bot id from get_top_bots, e.g. \"gptbot\"." } }, hours: hoursArg(24) },
    required: ["bot_id"],
    run: (ctx, args) => ctx.stats.botDetail(ctx.siteId, num(args, "hours"), str(args, "bot_id"))
  }),
  defineTool({
    name: "get_top_pages",
    description:
      "Top pages by AI traffic, split into training, AI-search and live-fetch hits, with total hits and last AI hit. Optional substring search to look at one section of the site.",
    fields: {
      hours: hoursArg(24),
      search: {
        zod: z.string().max(200).default(""),
        json: { type: "string", description: "Case-insensitive substring filter on the page path. Empty = all pages." }
      }
    },
    run: async (ctx, args) => ({
      pages: await ctx.stats.pages(ctx.siteId, num(args, "hours"), str(args, "search"))
    })
  }),
  defineTool({
    name: "get_security",
    description:
      "Spoofing report: requests that claimed to be a known bot but failed IP/reverse-DNS verification, grouped by claimed bot and by source IP. Use it to spot scrapers impersonating GPTBot or Googlebot.",
    fields: { hours: hoursArg(24) },
    run: (ctx, args) => ctx.stats.security(ctx.siteId, num(args, "hours"))
  }),
  defineTool({
    name: "explore",
    description:
      "Free-form breakdown: pick one metric and one dimension, optionally filtered, and get the top 50 groups. Use it for questions the fixed reports do not answer, e.g. hits by country, errors by bot, or sessions by AI referral source.",
    fields: {
      metric: enumArg(Object.keys(EXPLORE_METRICS), "What to measure."),
      dimension: enumArg(Object.keys(EXPLORE_DIMENSIONS), "How to group the measurement."),
      hours: hoursArg(24),
      filters: {
        // Advertise exactly the keys the query builder accepts (and cap value
        // length) so a model cannot be led into generating calls that only fail
        // deeper down, and oversized values never reach ClickHouse params.
        zod: z
          .object(
            Object.fromEntries(Object.keys(EXPLORE_FILTERS).map((key) => [key, z.string().max(200).optional()]))
          )
          .default({}),
        json: {
          type: "object",
          properties: Object.fromEntries(
            Object.keys(EXPLORE_FILTERS).map((key) => [key, { type: "string", maxLength: 200 }])
          ),
          additionalProperties: false,
          description: "Optional equality filters; omit for no filtering."
        }
      }
    },
    required: ["metric", "dimension"],
    run: async (ctx, args) => {
      if (!ctx.chClient) {
        throw new McpUserError("explore is unavailable: no ClickHouse client is configured on this server");
      }
      const rows = await exploreQuery(ctx.chClient, {
        site: ctx.siteId,
        hours: num(args, "hours"),
        metric: str(args, "metric"),
        dimension: str(args, "dimension"),
        filters: args["filters"] as Record<string, string>
      });
      return { rows };
    }
  }),
  defineTool({
    name: "generate_robots_txt",
    description:
      "Generates a suggested robots.txt for this site from the live AI-bot registry. Choose a policy per category: training bots (collect content to train models), search bots (index content for AI answers) and fetch bots (retrieve a page live to answer a user). Returns text to paste at /robots.txt — it does not change anything on the server.",
    fields: {
      training: { ...policyArg("Policy for model-training crawlers (GPTBot, ClaudeBot, CCBot...). Default deny."), zod: z.enum(["allow", "deny"]).default("deny") },
      search: policyArg("Policy for AI search indexers (PerplexityBot, OAI-SearchBot...). Default allow."),
      fetch: policyArg("Policy for live on-demand fetchers (ChatGPT-User, Claude-User...). Default allow.")
    },
    run: (ctx, args) =>
      Promise.resolve({
        robotsTxt: buildRobotsTxt(ctx.bots, {
          training: str(args, "training") as "allow" | "deny",
          search: str(args, "search") as "allow" | "deny",
          fetch: str(args, "fetch") as "allow" | "deny"
        })
      })
  }),
  defineTool({
    name: "generate_llms_txt",
    description:
      "Generates an llms.txt skeleton (https://llmstxt.org) for this site — a short machine-readable map of the key pages for AI assistants. Returns text to fill in and publish at /llms.txt; it does not change anything on the server.",
    fields: {},
    run: async (ctx) => {
      const site = await ctx.metadata.getSite(ctx.siteId);
      return { llmsTxt: buildLlmsTxt(site?.domain ?? "") };
    }
  })
];

export function findTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}

export function runTool(tool: McpTool, ctx: McpToolContext, rawArgs: unknown): Promise<unknown> {
  return tool.run(ctx, rawArgs);
}
