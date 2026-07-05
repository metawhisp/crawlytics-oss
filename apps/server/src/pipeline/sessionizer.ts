import { createHash } from "node:crypto";

export interface SessionizerOptions {
  /** Idle timeout: a gap longer than this starts a new session. Default 30 min. */
  windowMs?: number;
  /** Max tracked visitor keys (LRU eviction). Default 100_000. */
  maxEntries?: number;
}

export interface Sessionizer {
  /** Session id (decimal UInt64 string) for a visitor key at a moment in time. */
  assign(key: string, tsMs: number): string;
}

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 100_000;

interface SessionState {
  id: string;
  lastSeen: number;
}

/**
 * Rolling-idle-window sessionization. The id derives from the visitor key plus
 * the session start, so server restarts only ever split sessions, never merge
 * unrelated visitors.
 */
export function createSessionizer(options: SessionizerOptions = {}): Sessionizer {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const sessions = new Map<string, SessionState>();

  function assign(key: string, tsMs: number): string {
    const existing = sessions.get(key);
    if (existing && tsMs - existing.lastSeen <= windowMs) {
      existing.lastSeen = Math.max(existing.lastSeen, tsMs);
      sessions.delete(key);
      sessions.set(key, existing);
      return existing.id;
    }

    const id = sessionId(key, tsMs);
    if (!existing && sessions.size >= maxEntries) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) {
        sessions.delete(oldest);
      }
    }
    sessions.delete(key);
    sessions.set(key, { id, lastSeen: tsMs });
    return id;
  }

  return { assign };
}

function sessionId(key: string, startMs: number): string {
  const digest = createHash("sha256").update(`${key} ${String(startMs)}`).digest();
  return digest.readBigUInt64BE(0).toString(10);
}
