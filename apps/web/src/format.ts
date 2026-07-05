export function fmtNum(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1000)}K`;
  }
  if (value >= 1_000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  return String(value);
}

/** "2026-06-10 19:31:27" (UTC from ClickHouse) -> "5m ago" */
export function timeAgo(chTs: string, nowMs = Date.now()): string {
  const ms = Date.parse(`${chTs.replace(" ", "T")}Z`);
  if (Number.isNaN(ms)) {
    return chTs;
  }
  const diff = Math.max(0, nowMs - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

export function verifiedShare(verified: number, spoofed: number): string {
  const total = verified + spoofed;
  if (total === 0) {
    return "—";
  }
  return `${Math.round((verified / total) * 100)}%`;
}
