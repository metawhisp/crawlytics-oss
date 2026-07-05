import { createHash } from "node:crypto";

/**
 * Privacy-preserving visitor key: hash(secret + day + ip) truncated to 64 bits,
 * returned as a decimal string for ClickHouse UInt64. The daily rotation makes
 * long-term cross-day tracking of humans impossible by design.
 */
export function dailyIpHash(ip: string, secret: string, day: string): string {
  const digest = createHash("sha256").update(`${secret} ${day} ${ip}`).digest();
  return digest.readBigUInt64BE(0).toString(10);
}

/** UTC calendar day (YYYY-MM-DD) for an epoch-ms timestamp. */
export function utcDay(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}
