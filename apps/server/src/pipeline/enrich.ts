import { classifyReferral, createDetector } from "@crawlytics/detector";
import type { Detector, IpVerifier } from "@crawlytics/detector";
import type { BotRegistryEntry } from "@crawlytics/registry";
import type { EnrichedEvent, RawLogEvent } from "@crawlytics/shared";

import type { AsnLookup } from "./asn-lookup.js";
import { dailyIpHash, utcDay } from "./ip-hash.js";
import { pathGroup, splitPathQuery } from "./path-group.js";
import { refererOrigin } from "./redact.js";
import { createSessionizer } from "./sessionizer.js";
import type { Sessionizer } from "./sessionizer.js";

export interface EnricherOptions {
  bots: BotRegistryEntry[];
  /** Secret for daily IP hashing (from config). */
  secret: string;
  /** Optional: skips verification when absent. */
  verifier?: IpVerifier;
  sessionizer?: Sessionizer;
  detector?: Detector;
  ingestSource?: string;
  /**
   * Optional IP -> network database. Used only to fill fields the sensor could
   * not supply: an edge like Cloudflare knows the address better than an hourly
   * dump, so whatever it reports wins.
   */
  network?: AsnLookup;
}

export type Enricher = (siteId: string, event: RawLogEvent) => Promise<EnrichedEvent>;

/** Server-side enrichment: raw sensor event -> ClickHouse row. */
export function createEnricher(options: EnricherOptions): Enricher {
  const detector = options.detector ?? createDetector(options.bots);
  const sessionizer = options.sessionizer ?? createSessionizer();
  const ingestSource = options.ingestSource ?? "api";

  return async function enrich(siteId: string, event: RawLogEvent): Promise<EnrichedEvent> {
    const tsMs = Date.parse(event.ts);
    const classification = detector.classify(event.ua);
    const isBot = classification.actorType !== "human";

    const ipHash = dailyIpHash(event.ip, options.secret, utcDay(tsMs));

    // A plain access log carries none of these, which is why an install not
    // behind an edge would otherwise have no network data at all.
    // Empty string and 0 are the unknown sentinels in this schema, so a sensor
    // reporting either is reporting nothing — treat it as a gap to fill rather
    // than as an answer that blocks the lookup.
    const missingNetwork = !event.country || !event.asn || !event.asOrg;
    const network = missingNetwork ? (options.network?.find(event.ip) ?? null) : null;
    const { pathname, query } = splitPathQuery(event.path);

    let verification = "na";
    if (isBot && classification.botId && options.verifier) {
      verification = await options.verifier.verify(classification.botId, event.ip);
    }

    // Classification uses the FULL referer + query; only redacted values are stored.
    const aiReferral = isBot ? "" : (classifyReferral(event.referer, query) ?? "");
    const sessionKey = `${siteId}|${ipHash}|${event.ua}`;

    return {
      site_id: siteId,
      ts: tsMs,
      ip_hash: ipHash,
      bot_ip: isBot ? event.ip : "",
      method: event.method.toUpperCase(),
      path: pathname,
      path_group: pathGroup(pathname),
      query: "",
      status: event.status,
      bytes: event.bytes,
      response_ms: Math.round(event.responseMs ?? 0),
      ua: event.ua,
      actor_type: classification.actorType,
      bot_id: classification.botId ?? "",
      operator: classification.operator ?? "",
      verification,
      referer: refererOrigin(event.referer),
      ai_referral: aiReferral,
      topic_id: "",
      country: event.country || network?.country || "",
      asn: event.asn || network?.asn || 0,
      as_org: event.asOrg || network?.asOrg || "",
      session_id: sessionizer.assign(sessionKey, tsMs),
      ingest_source: ingestSource
    };
  };
}
