import { z } from "zod";

/** Raw event as sent by every sensor (log tailer, edge worker, middleware). */
export const rawLogEventSchema = z.object({
  /** ISO 8601 timestamp with timezone. */
  ts: z.string().datetime({ offset: true }),
  ip: z.string().min(1).max(64),
  method: z.string().min(1).max(16),
  /** Path including query string. */
  path: z.string().min(1).max(4096),
  status: z.number().int().min(0).max(999),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  ua: z.string().max(4096).default(""),
  referer: z.string().max(4096).default(""),
  responseMs: z.number().min(0).max(3_600_000).optional(),
  /** ISO 3166-1 alpha-2, from edge sensors (Cloudflare cf.country). */
  country: z.string().length(2).optional(),
  asn: z.number().int().min(0).max(4_294_967_295).optional(),
  asOrg: z.string().max(256).optional()
});

export type RawLogEvent = z.infer<typeof rawLogEventSchema>;

export const ingestBatchSchema = z.object({
  events: z.array(rawLogEventSchema).min(1).max(5000)
});

export type IngestBatch = z.infer<typeof ingestBatchSchema>;

/** Fully enriched event — one row in the ClickHouse `events` table. */
export interface EnrichedEvent {
  site_id: string;
  /** Epoch milliseconds (UTC). Sinks format for their storage. */
  ts: number;
  /** Daily-salted hash of the client IP, as a decimal UInt64 string. */
  ip_hash: string;
  /** Raw IP, kept for bots only ("" for humans — GDPR-friendly). */
  bot_ip: string;
  method: string;
  path: string;
  path_group: string;
  query: string;
  status: number;
  bytes: number;
  response_ms: number;
  ua: string;
  actor_type: string;
  bot_id: string;
  operator: string;
  verification: string;
  referer: string;
  ai_referral: string;
  topic_id: string;
  country: string;
  asn: number;
  as_org: string;
  /** Decimal UInt64 string. */
  session_id: string;
  ingest_source: string;
}
