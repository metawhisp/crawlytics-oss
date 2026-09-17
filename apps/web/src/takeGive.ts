/** How the Take-vs-Give panel judges a vendor.
 *
 * The scale this replaces was taker < 0.01, low < 0.1, sender above. Measured
 * over three months on two live sites, the observed range was 0.0028 to 0.023:
 * "sender" could not be reached, the single best vendor on each site was
 * labelled "low", and one vendor landed on opposite sides of the 0.01 line on
 * two sites. A scale whose good end never occurs is not a scale, and the words
 * it produced told the owner the opposite of the truth.
 *
 * So there are no invented constants here. The verdicts are statements of fact
 * — this one cannot send anyone, this one could and did not, this one does —
 * and the only derived number, the point below which "sent nobody" stops
 * meaning anything, comes from the site's own best rate.
 */

export interface VendorRow {
  vendor: string;
  crawls: number;
  clicks: number;
  ratio: number | null;
  /** False when the vendor has no consumer assistant that could send anyone. */
  hasAssistant: boolean;
}

export type Verdict =
  /** No consumer assistant exists. Zero visitors is the design, not a letdown —
   * and for the owner this is the plainest case there is: pure cost. */
  | { kind: "only-takes" }
  /** Visitors arrived from an assistant whose crawler this site never saw. */
  | { kind: "sends-without-crawling" }
  /** It sends people. `perVisitor` is how many crawls one visitor costs. */
  | { kind: "sends"; perVisitor: number }
  /** It has an assistant, it crawled enough for silence to mean something, and
   * it sent nobody. */
  | { kind: "sent-nobody" }
  /** Too few crawls for zero visitors to be evidence of anything. */
  | { kind: "not-enough"; needed: number };

export interface ClassifiedVendor extends VendorRow {
  verdict: Verdict;
}

/**
 * The number of crawls below which zero visitors is unremarkable: at the best
 * rate this site has ever achieved, a vendor with fewer crawls than this would
 * still show zero more than half the time. Above it, silence is a finding.
 */
export function evidenceFloor(rows: readonly VendorRow[]): number {
  const best = bestRate(rows);
  if (best <= 0 || best >= 1) {
    // Nobody on this site sends anyone, so there is no rate to reason from and
    // no vendor's zero can be held against it.
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil(Math.log(0.5) / Math.log(1 - best));
}

function bestRate(rows: readonly VendorRow[]): number {
  let best = 0;
  for (const row of rows) {
    if (row.crawls > 0 && row.clicks > 0) {
      best = Math.max(best, row.clicks / row.crawls);
    }
  }
  return best;
}

export function classifyVendors(rows: readonly VendorRow[]): ClassifiedVendor[] {
  const floor = evidenceFloor(rows);
  return rows.map((row) => ({ ...row, verdict: verdictFor(row, floor) }));
}

function verdictFor(row: VendorRow, floor: number): Verdict {
  if (!row.hasAssistant) {
    return { kind: "only-takes" };
  }
  if (row.clicks > 0) {
    return row.crawls === 0
      ? { kind: "sends-without-crawling" }
      : { kind: "sends", perVisitor: row.crawls / row.clicks };
  }
  return row.crawls < floor ? { kind: "not-enough", needed: floor } : { kind: "sent-nobody" };
}

/** "1 in 44" — a rate somebody can act on, rather than "0.0230". */
export function perVisitorText(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return "—";
  }
  return `1 in ${String(Math.round(1 / ratio))}`;
}
