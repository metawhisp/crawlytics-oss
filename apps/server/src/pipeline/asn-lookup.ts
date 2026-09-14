import { readFile, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

/**
 * IP -> network lookup over the iptoasn.com dump (PDDL v1.0, public domain, so
 * it can travel inside the image we hand to self-hosters).
 *
 * Why this exists: a raw access log carries an IP and nothing else. Only an
 * edge like Cloudflare tells us whose address it is, so without this every
 * install that is NOT behind Cloudflare loses the network column — and with it
 * the ability to tell a bot renting a server from a person on a home line.
 *
 * File format, one range per line:
 *   start_ip \t end_ip \t asn \t country \t as_org
 * Ranges are disjoint and sorted; unannounced space appears as asn 0
 * ("Not routed") and is reported as unknown rather than as a network.
 *
 * Stored in typed arrays with a deduplicated label table. The obvious
 * array-of-objects version measured 280 MB of heap for the real 716k-range
 * dump, which is more than the rest of the server puts together and would
 * price this out of a small VPS.
 */

export interface NetworkInfo {
  /** ISO-3166 alpha-2, as published in the dump. */
  country: string;
  asn: number;
  asOrg: string;
}

export interface AsnLookup {
  /** The network announcing this address, or null when nothing does. */
  find(ip: string): NetworkInfo | null;
  /** Ranges parsed out of the file — 0 means the lookup is inert, not broken. */
  readonly size: number;
}

const IPV4_GROUPS = 4;
const IPV6_GROUPS = 8;
const MAX_OCTET = 255;
const HEX_GROUP = /^[0-9a-f]{1,4}$/iu;
/** ASNs are 32-bit. A larger number would wrap inside Uint32Array and quietly
 * attribute traffic to the wrong network — 4294967297 becomes AS1. */
const MAX_ASN = 4_294_967_295;

function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== IPV4_GROUPS) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (part === "" || part.length > 3 || !/^\d+$/u.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > MAX_OCTET) {
      return null;
    }
    value = value * 256 + octet;
  }
  return value;
}

/** Split into two 64-bit halves so a range fits two BigUint64Array slots. */
function parseIpv6(ip: string): { hi: bigint; lo: bigint } | null {
  // IPv4-mapped forms (::ffff:1.2.3.4) never appear in the dump; refuse rather
  // than guess at a half-parsed address.
  if (!ip.includes(":") || ip.includes(".")) {
    return null;
  }
  const halves = ip.split("::");
  if (halves.length > 2) {
    return null;
  }
  const split = (part: string | undefined): string[] => (part === undefined || part === "" ? [] : part.split(":"));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  if (halves.length === 1 && head.length !== IPV6_GROUPS) {
    return null;
  }
  const filled = head.length + tail.length;
  if (filled > IPV6_GROUPS || (halves.length === 2 && filled === IPV6_GROUPS)) {
    return null;
  }
  const groups: string[] = [...head, ...(Array(IPV6_GROUPS - filled).fill("0") as string[]), ...tail];

  let hi = 0n;
  let lo = 0n;
  for (const [index, group] of groups.entries()) {
    if (!HEX_GROUP.test(group)) {
      return null;
    }
    const value = BigInt(Number.parseInt(group, 16));
    if (index < IPV6_GROUPS / 2) {
      hi = (hi << 16n) | value;
    } else {
      lo = (lo << 16n) | value;
    }
  }
  return { hi, lo };
}

interface ParsedLine {
  asn: number;
  label: string;
  v4?: { start: number; end: number };
  v6?: { startHi: bigint; startLo: bigint; endHi: bigint; endLo: bigint };
}

/** Country and organisation share one slot: they always travel together. */
const LABEL_SEPARATOR = "\t";

function parseLine(line: string): ParsedLine | null {
  const [start, end, asnText, country, asOrg] = line.split("\t");
  if (start === undefined || end === undefined || asnText === undefined || !/^\d+$/u.test(asnText)) {
    return null;
  }
  const asn = Number(asnText);
  if (asn > MAX_ASN) {
    return null;
  }
  const base = { asn, label: `${country ?? ""}${LABEL_SEPARATOR}${asOrg ?? ""}` };

  const start4 = parseIpv4(start);
  const end4 = parseIpv4(end);
  if (start4 !== null && end4 !== null) {
    return { ...base, v4: { start: start4, end: end4 } };
  }
  const start6 = parseIpv6(start);
  const end6 = parseIpv6(end);
  if (start6 && end6) {
    return { ...base, v6: { startHi: start6.hi, startLo: start6.lo, endHi: end6.hi, endLo: end6.lo } };
  }
  return null;
}

function compare6(aHi: bigint, aLo: bigint, bHi: bigint, bLo: bigint): number {
  if (aHi !== bHi) {
    return aHi < bHi ? -1 : 1;
  }
  if (aLo !== bLo) {
    return aLo < bLo ? -1 : 1;
  }
  return 0;
}

/** Rightmost index whose start is <= the probe, or -1. */
function lastStartingAtOrBefore(length: number, startsAtOrBefore: (index: number) => boolean): number {
  let low = 0;
  let high = length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (startsAtOrBefore(mid)) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** Reorders every column by `order`. Only runs when the file arrives unsorted. */
function reorder<T extends Uint32Array | BigUint64Array>(column: T, order: Uint32Array): T {
  const copy = column.slice() as T;
  for (let i = 0; i < order.length; i += 1) {
    // @ts-expect-error -- Uint32Array and BigUint64Array share this indexer shape
    // but TypeScript will not unify their element types through the generic.
    column[i] = copy[order[i] as number];
  }
  return column;
}

/**
 * Walks the file without splitting it into an array first: `tsv.split("\n")` on
 * the real dump materialises 716k string objects, and every one of them is a
 * V8 slice that keeps the whole 45 MB source alive.
 */
function eachLine(tsv: string, visit: (line: string) => void): void {
  let from = 0;
  while (from < tsv.length) {
    const next = tsv.indexOf("\n", from);
    const end = next === -1 ? tsv.length : next;
    if (end > from) {
      // Trim a CR so a file saved with Windows line endings does not leave one
      // glued to the organisation name of every row.
      const stop = tsv.charCodeAt(end - 1) === 13 ? end - 1 : end;
      if (stop > from) {
        visit(tsv.slice(from, stop));
      }
    }
    if (next === -1) {
      break;
    }
    from = next + 1;
  }
}

/**
 * Detaches a string from the buffer it was sliced out of. V8 represents
 * `big.slice(a, b)` as a view onto `big`, so storing 84k labels taken from the
 * dump would pin all 45 MB of it for the lifetime of the process.
 */
function detach(value: string): string {
  return Buffer.from(value, "utf8").toString("utf8");
}

export function createAsnLookup(tsv: string): AsnLookup {
  // Two passes over the source rather than one pass plus an intermediate array:
  // holding the parsed form of every row costs far more than parsing twice, and
  // this runs once at boot.
  let count4 = 0;
  let count6 = 0;
  eachLine(tsv, (line) => {
    const row = parseLine(line);
    if (row?.v4) {
      count4 += 1;
    } else if (row?.v6) {
      count6 += 1;
    }
  });

  const labels: string[] = [];
  const labelIds = new Map<string, number>();
  const labelId = (label: string): number => {
    const existing = labelIds.get(label);
    if (existing !== undefined) {
      return existing;
    }
    const id = labels.length;
    const flat = detach(label);
    labels.push(flat);
    labelIds.set(flat, id);
    return id;
  };

  const start4 = new Uint32Array(count4);
  const end4 = new Uint32Array(count4);
  const asn4 = new Uint32Array(count4);
  const label4 = new Uint32Array(count4);
  const startHi6 = new BigUint64Array(count6);
  const startLo6 = new BigUint64Array(count6);
  const endHi6 = new BigUint64Array(count6);
  const endLo6 = new BigUint64Array(count6);
  const asn6 = new Uint32Array(count6);
  const label6 = new Uint32Array(count6);

  let at4 = 0;
  let at6 = 0;
  eachLine(tsv, (line) => {
    const row = parseLine(line);
    if (row?.v4) {
      start4[at4] = row.v4.start;
      end4[at4] = row.v4.end;
      asn4[at4] = row.asn;
      label4[at4] = labelId(row.label);
      at4 += 1;
    } else if (row?.v6) {
      startHi6[at6] = row.v6.startHi;
      startLo6[at6] = row.v6.startLo;
      endHi6[at6] = row.v6.endHi;
      endLo6[at6] = row.v6.endLo;
      asn6[at6] = row.asn;
      label6[at6] = labelId(row.label);
      at6 += 1;
    }
  });
  // Only needed while filling. Keeping it would pin 84k more strings for the
  // life of the process for no reason.
  labelIds.clear();

  // The published dump is sorted, and re-sorting 716k ranges on every boot would
  // be waste — but binary search over an unsorted file returns wrong networks
  // silently, so check, and only pay when a hand-edited file needs it.
  const sortIfNeeded = (): void => {
    let sorted4 = true;
    for (let i = 1; i < count4 && sorted4; i += 1) {
      sorted4 = (start4[i - 1] ?? 0) <= (start4[i] ?? 0);
    }
    if (!sorted4) {
      const order = Uint32Array.from({ length: count4 }, (_, i) => i).sort(
        (a, b) => (start4[a] ?? 0) - (start4[b] ?? 0)
      );
      reorder(start4, order);
      reorder(end4, order);
      reorder(asn4, order);
      reorder(label4, order);
    }

    let sorted6 = true;
    for (let i = 1; i < count6 && sorted6; i += 1) {
      sorted6 =
        compare6(startHi6[i - 1] ?? 0n, startLo6[i - 1] ?? 0n, startHi6[i] ?? 0n, startLo6[i] ?? 0n) <= 0;
    }
    if (!sorted6) {
      const order = Uint32Array.from({ length: count6 }, (_, i) => i).sort((a, b) =>
        compare6(startHi6[a] ?? 0n, startLo6[a] ?? 0n, startHi6[b] ?? 0n, startLo6[b] ?? 0n)
      );
      reorder(startHi6, order);
      reorder(startLo6, order);
      reorder(endHi6, order);
      reorder(endLo6, order);
      reorder(asn6, order);
      reorder(label6, order);
    }
  };
  sortIfNeeded();

  function infoAt(asn: number, labelIndex: number): NetworkInfo | null {
    // asn 0 is the dump's way of saying "nobody announces this" — not a network.
    if (asn === 0) {
      return null;
    }
    const [country = "", asOrg = ""] = (labels[labelIndex] ?? "").split(LABEL_SEPARATOR);
    return { country, asn, asOrg };
  }

  function find(ip: string): NetworkInfo | null {
    const address4 = parseIpv4(ip);
    if (address4 !== null) {
      const index = lastStartingAtOrBefore(count4, (at) => (start4[at] ?? Infinity) <= address4);
      if (index < 0 || address4 > (end4[index] ?? -1)) {
        return null;
      }
      return infoAt(asn4[index] ?? 0, label4[index] ?? 0);
    }

    const address6 = parseIpv6(ip);
    if (!address6) {
      return null;
    }
    const index = lastStartingAtOrBefore(
      count6,
      (at) => compare6(startHi6[at] ?? 0n, startLo6[at] ?? 0n, address6.hi, address6.lo) <= 0
    );
    if (index < 0) {
      return null;
    }
    if (compare6(address6.hi, address6.lo, endHi6[index] ?? 0n, endLo6[index] ?? 0n) > 0) {
      return null;
    }
    return infoAt(asn6[index] ?? 0, label6[index] ?? 0);
  }

  return { find, size: count4 + count6 };
}

// The published dump is 8 MB compressed / 45 MB plain. These bounds leave room
// for it to grow several times over while stopping a poisoned download or a
// mistyped CRAWLYTICS_ASN_DB from exhausting memory before the catch can help:
// a decompression bomb throws instead of filling the heap.
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

/**
 * Loads the dump from disk, gzipped or plain. The image ships the compressed
 * form: 8 MB instead of 45 for identical data, at the cost of one decompression
 * at boot.
 *
 * Returns null when the file is missing, unreadable or corrupt — a self-host
 * that never downloaded it must still start and ingest, just without the
 * network column. A broken database is never a reason to refuse traffic.
 */
export async function loadAsnLookup(path: string): Promise<AsnLookup | null> {
  try {
    const { size } = await stat(path);
    if (size > MAX_FILE_BYTES) {
      return null;
    }
    const raw = await readFile(path);
    return createAsnLookup(
      path.endsWith(".gz") ? gunzipSync(raw, { maxOutputLength: MAX_UNPACKED_BYTES }).toString("utf8") : raw.toString("utf8")
    );
  } catch {
    return null;
  }
}
