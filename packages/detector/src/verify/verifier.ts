import { Resolver } from "node:dns/promises";

import type { BotRegistryEntry } from "@crawlytics/registry";

import { RangeSet, extractCidrs, parseCidr, parseIp } from "./cidr.js";
import type { IpRange } from "./cidr.js";

export type VerificationStatus = "na" | "verified" | "unverified" | "spoofed";

export interface DnsResolverLike {
  reverse(ip: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export interface IpVerifierOptions {
  entries: BotRegistryEntry[];
  /** Injectable for tests / custom transports. Defaults to global fetch. */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Injectable for tests. Defaults to node:dns with a 3s timeout. */
  resolver?: DnsResolverLike;
  /** Vendor range documents TTL. Default 24h. */
  rangesTtlMs?: number;
  /** rDNS verdict cache TTL. Default 1h. */
  rdnsTtlMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface IpVerifier {
  /**
   * Verifies that an IP legitimately belongs to the claimed bot.
   * - "verified": IP inside published ranges, or FCrDNS confirmed
   * - "spoofed": a definitive check succeeded and failed the match
   * - "unverified": verification data unavailable (network/DNS failure)
   * - "na": the bot has no published verification method
   * Failures never produce "spoofed" (fail-open).
   */
  verify(botId: string, ip: string): Promise<VerificationStatus>;
  /** Prefetches every distinct ip_source document. */
  refresh(): Promise<void>;
}

const DEFAULT_RANGES_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RDNS_TTL_MS = 60 * 60 * 1000;
/** How long a vendor that could not be read is left alone. Short, because the
 * bots behind it answer "na" or fall through to DNS meanwhile. */
const FAILED_RANGES_TTL_MS = 5 * 60 * 1000;
const RDNS_CACHE_MAX = 10_000;
/** DNS rcodes that positively assert "this record does not exist". */
const NEGATIVE_DNS_CODES = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "NOTFOUND"]);

export function createIpVerifier(options: IpVerifierOptions): IpVerifier {
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const resolver = options.resolver ?? createDefaultResolver();
  const rangesTtlMs = options.rangesTtlMs ?? DEFAULT_RANGES_TTL_MS;
  const rdnsTtlMs = options.rdnsTtlMs ?? DEFAULT_RDNS_TTL_MS;
  const now = options.now ?? Date.now;

  const entriesById = new Map(options.entries.map((entry) => [entry.bot_id, entry]));
  // `stale` marks an entry we could not refresh: either the vendor was
  // unreachable or its document held no readable address. It carries the last
  // good set if there ever was one, and it expires much sooner, so a broken
  // vendor is retried in minutes instead of being asked again by every event.
  const rangeCache = new Map<string, { set: RangeSet | null; fetchedAt: number; stale: boolean }>();

  function remember(url: string, set: RangeSet | null, stale: boolean): RangeSet | null {
    rangeCache.set(url, { set, fetchedAt: now(), stale });
    return set;
  }
  const rdnsCache = new Map<string, { status: VerificationStatus; expiresAt: number }>();

  async function getRangeSet(url: string): Promise<RangeSet | null> {
    const cached = rangeCache.get(url);
    if (cached && now() - cached.fetchedAt < (cached.stale ? FAILED_RANGES_TTL_MS : rangesTtlMs)) {
      return cached.set;
    }
    try {
      const doc = await fetchJson(url);
      const ranges = extractCidrs(doc)
        .map((cidr) => parseCidr(cidr))
        .filter((range): range is IpRange => range !== null);
      if (ranges.length === 0) {
        // A document that parses but holds no address is not a list saying
        // "this IP is not ours" — it is no list at all, and an empty RangeSet
        // is truthy, so the caller below would read it as a definitive miss and
        // answer "spoofed". That breaks the fail-open promise above verify()
        // for every bot with no reverse-DNS fallback. Vendors serve error pages
        // with status 200, change formats, and key documents by address (walk()
        // reads values, not keys) — all of which land here.
        //
        // Remembered as stale rather than not remembered at all: verify() runs
        // once per bot event, and enrichment runs a whole batch of them at
        // once, so "ask again next time" means asking the vendor once per event
        // for as long as the outage lasts.
        return remember(url, cached?.set ?? null, true);
      }
      return remember(url, new RangeSet(ranges), false);
    } catch {
      // stale-on-error: an expired snapshot beats no data, and the same
      // once-per-event storm applies to a vendor that is simply unreachable.
      return remember(url, cached?.set ?? null, true);
    }
  }

  async function fcrdns(ip: string, suffixes: string[]): Promise<VerificationStatus> {
    const cacheKey = `${ip}|${suffixes.join(",")}`;
    const cached = rdnsCache.get(cacheKey);
    if (cached && cached.expiresAt > now()) {
      return cached.status;
    }

    const status = await fcrdnsUncached(ip, suffixes);

    // transient failures are not cached so the next request retries
    if (status !== "unverified") {
      if (rdnsCache.size >= RDNS_CACHE_MAX) {
        const oldest = rdnsCache.keys().next().value;
        if (oldest !== undefined) {
          rdnsCache.delete(oldest);
        }
      }
      rdnsCache.set(cacheKey, { status, expiresAt: now() + rdnsTtlMs });
    }
    return status;
  }

  async function fcrdnsUncached(ip: string, suffixes: string[]): Promise<VerificationStatus> {
    let ptrs: string[];
    try {
      ptrs = await resolver.reverse(ip);
    } catch (error) {
      // verified crawlers always publish PTR records: a positive NXDOMAIN is a spoof signal
      return isNegativeDns(error) ? "spoofed" : "unverified";
    }

    const matching = ptrs.filter((ptr) => matchesSuffix(ptr, suffixes));
    if (matching.length === 0) {
      return "spoofed";
    }

    let sawTransient = false;
    for (const host of matching) {
      const verdict = await forwardConfirm(host, ip);
      if (verdict === "verified") {
        return "verified";
      }
      if (verdict === "unverified") {
        sawTransient = true;
      }
    }
    return sawTransient ? "unverified" : "spoofed";
  }

  async function forwardConfirm(hostname: string, ip: string): Promise<VerificationStatus> {
    const target = parseIp(ip);
    if (!target) {
      return "unverified";
    }

    let sawTransient = false;
    const addresses: string[] = [];
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    for (const result of results) {
      if (result.status === "fulfilled") {
        addresses.push(...result.value);
      } else if (!isNegativeDns(result.reason)) {
        sawTransient = true;
      }
    }

    for (const address of addresses) {
      const parsed = parseIp(address);
      if (parsed && parsed.family === target.family && parsed.value === target.value) {
        return "verified";
      }
    }
    return sawTransient ? "unverified" : "spoofed";
  }

  async function verify(botId: string, ip: string): Promise<VerificationStatus> {
    const entry = entriesById.get(botId);
    const suffixes = entry?.rdns_suffixes ?? [];
    if (!entry || (!entry.ip_source && suffixes.length === 0)) {
      return "na";
    }
    if (!parseIp(ip)) {
      return "unverified";
    }

    let rangeVerdict: VerificationStatus | null = null;
    if (entry.ip_source) {
      const set = await getRangeSet(entry.ip_source);
      if (set) {
        if (set.contains(ip)) {
          return "verified";
        }
        rangeVerdict = "spoofed";
      }
    }

    if (suffixes.length > 0) {
      // vendor IP lists can lag behind reality; FCrDNS is authoritative
      const dnsVerdict = await fcrdns(ip, suffixes);
      if (dnsVerdict !== "unverified") {
        return dnsVerdict;
      }
      return rangeVerdict ?? "unverified";
    }

    return rangeVerdict ?? "unverified";
  }

  async function refresh(): Promise<void> {
    const urls = new Set<string>();
    for (const entry of entriesById.values()) {
      if (entry.ip_source) {
        urls.add(entry.ip_source);
      }
    }
    await Promise.all([...urls].map((url) => getRangeSet(url)));
  }

  return { verify, refresh };
}

function matchesSuffix(ptr: string, suffixes: string[]): boolean {
  const host = ptr.toLowerCase().replace(/\.$/, "");
  return suffixes.some((suffix) => {
    const normalized = suffix.toLowerCase().replace(/\.$/, "");
    if (normalized.startsWith(".")) {
      return host.endsWith(normalized);
    }
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function isNegativeDns(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && NEGATIVE_DNS_CODES.has(code);
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${String(response.status)}`);
  }
  const data: unknown = await response.json();
  return data;
}

function createDefaultResolver(): DnsResolverLike {
  const resolver = new Resolver({ timeout: 3_000, tries: 1 });
  return {
    reverse: (ip) => resolver.reverse(ip),
    resolve4: (hostname) => resolver.resolve4(hostname),
    resolve6: (hostname) => resolver.resolve6(hostname)
  };
}
