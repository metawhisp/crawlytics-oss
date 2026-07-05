export interface ParsedIp {
  family: 4 | 6;
  value: bigint;
}

export interface IpRange {
  family: 4 | 6;
  start: bigint;
  end: bigint;
}

/**
 * Parses an IPv4/IPv6 address. IPv4-mapped IPv6 addresses (::ffff:a.b.c.d)
 * are normalized to IPv4 so they match IPv4 ranges.
 */
export function parseIp(input: string): ParsedIp | null {
  const ip = input.trim();
  if (!ip) {
    return null;
  }

  if (ip.includes(":")) {
    const value = parseIpv6(ip);
    if (value === null) {
      return null;
    }
    if (value >> 32n === 0xffffn) {
      return { family: 4, value: value & 0xffffffffn };
    }
    return { family: 6, value };
  }

  const value = parseIpv4(ip);
  return value === null ? null : { family: 4, value };
}

/** Parses a CIDR block; a bare IP is treated as a host route (/32 or /128). */
export function parseCidr(input: string): IpRange | null {
  const cidr = input.trim();
  const slash = cidr.indexOf("/");

  if (slash === -1) {
    const ip = parseIp(cidr);
    return ip ? { family: ip.family, start: ip.value, end: ip.value } : null;
  }

  const ip = parseIp(cidr.slice(0, slash));
  const prefixPart = cidr.slice(slash + 1);
  if (!ip || !/^\d{1,3}$/.test(prefixPart)) {
    return null;
  }

  const bits = ip.family === 4 ? 32 : 128;
  const prefix = Number(prefixPart);
  if (prefix > bits) {
    return null;
  }

  const hostBits = BigInt(bits - prefix);
  const start = (ip.value >> hostBits) << hostBits;
  const end = start + (1n << hostBits) - 1n;
  return { family: ip.family, start, end };
}

/** Sorted, merged set of IP ranges with O(log n) lookups. */
export class RangeSet {
  private readonly v4: IpRange[];
  private readonly v6: IpRange[];

  constructor(ranges: IpRange[]) {
    this.v4 = normalizeRanges(ranges.filter((range) => range.family === 4));
    this.v6 = normalizeRanges(ranges.filter((range) => range.family === 6));
  }

  get size(): number {
    return this.v4.length + this.v6.length;
  }

  contains(ip: string): boolean {
    const parsed = parseIp(ip);
    if (!parsed) {
      return false;
    }
    const ranges = parsed.family === 4 ? this.v4 : this.v6;

    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const range = ranges[mid];
      if (!range) {
        return false;
      }
      if (parsed.value < range.start) {
        high = mid - 1;
      } else if (parsed.value > range.end) {
        low = mid + 1;
      } else {
        return true;
      }
    }
    return false;
  }
}

/**
 * Walks an arbitrary JSON document and collects every string that is a valid
 * CIDR block or bare IP. Tolerant of vendor format differences: OpenAI/Google
 * style {prefixes:[{ipv4Prefix}]}, flat arrays, nested objects.
 */
export function extractCidrs(doc: unknown): string[] {
  const found = new Set<string>();
  walk(doc, found);
  return [...found];
}

function walk(node: unknown, found: Set<string>): void {
  if (typeof node === "string") {
    const trimmed = node.trim();
    if (parseCidr(trimmed)) {
      found.add(trimmed);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, found);
    }
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const value of Object.values(node)) {
      walk(value, found);
    }
  }
}

function normalizeRanges(ranges: IpRange[]): IpRange[] {
  const sorted = [...ranges].sort((left, right) =>
    left.start < right.start ? -1 : left.start > right.start ? 1 : 0
  );
  const merged: IpRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1n) {
      if (range.end > last.end) {
        last.end = range.end;
      }
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function parseIpv4(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(ip: string): bigint | null {
  const doubleColon = ip.indexOf("::");
  if (doubleColon !== -1 && ip.indexOf("::", doubleColon + 1) !== -1) {
    return null;
  }

  let headPart = ip;
  let tailPart = "";
  if (doubleColon !== -1) {
    headPart = ip.slice(0, doubleColon);
    tailPart = ip.slice(doubleColon + 2);
  } else if (ip.startsWith(":") || ip.endsWith(":")) {
    return null;
  }

  const head = expandGroups(headPart);
  const tail = expandGroups(tailPart);
  if (head === null || tail === null) {
    return null;
  }

  const total = head.length + tail.length;
  if (doubleColon === -1 ? total !== 8 : total > 7) {
    return null;
  }

  const groups = [...head, ...Array.from({ length: 8 - total }, () => 0n), ...tail];
  let value = 0n;
  for (const group of groups) {
    value = (value << 16n) | group;
  }
  return value;
}

function expandGroups(chunk: string): bigint[] | null {
  if (chunk === "") {
    return [];
  }
  const groups: bigint[] = [];
  for (const part of chunk.split(":")) {
    if (part.includes(".")) {
      // embedded IPv4 tail, e.g. ::ffff:192.0.2.1
      const v4 = parseIpv4(part);
      if (v4 === null) {
        return null;
      }
      groups.push(v4 >> 16n, v4 & 0xffffn);
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
        return null;
      }
      groups.push(BigInt(Number.parseInt(part, 16)));
    }
  }
  return groups;
}
