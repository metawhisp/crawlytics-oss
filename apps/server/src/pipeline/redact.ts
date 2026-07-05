/**
 * Privacy redaction for fields persisted to ClickHouse. AI-referral detection
 * runs on the FULL referer/query first (see enrich.ts); these helpers strip the
 * personal data before storage. Query strings (where tokens/emails/search terms
 * live) are dropped entirely; referers are reduced to their origin.
 */

/**
 * Reduce a referer to `scheme://host[:port]` — no userinfo, path, query, or
 * fragment, lowercased host. Returns "" for empty, non-http(s), or unparseable
 * input (browsers always send a full URL, so a bare host is treated as junk).
 */
export function refererOrigin(referer: string): string {
  if (referer === "") {
    return "";
  }
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "";
  }
  // URL.origin is already scheme://host[:port], lowercased, with credentials,
  // path, query and fragment removed.
  return url.origin.length <= 255 ? url.origin : "";
}
