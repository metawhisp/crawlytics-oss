/** The alerts tick: config -> per-site rules -> cooldown dedup -> delivery ->
 * state. Single-runner assumption (one server process); the state lives in the
 * metadata store so a restart doesn't re-send everything. Fail-open everywhere:
 * a broken ClickHouse or webhook skips the tick, never crashes the process. */

import type { ChQueryClientLike } from "../explore.js";
import type { MetadataStore } from "../metadata/index.js";
import type { AlertEvent } from "./config.js";
import { dedupKey } from "./config.js";
import type { WebhookPayload } from "./deliver.js";
import { evaluateRules } from "./rules.js";

export interface AlertsRunnerDeps {
  metadata: MetadataStore;
  client: ChQueryClientLike;
  deliver: (url: string, payload: WebhookPayload) => Promise<boolean>;
  /** Rule look-back in minutes; should cover ~2 scheduler intervals. */
  windowMinutes?: number;
  now?: () => number;
}

export interface AlertsRunner {
  /** Runs one evaluation pass; returns the alerts that were delivered. */
  tick(): Promise<AlertEvent[]>;
}

/** Keep at most this many dedup entries; oldest are dropped first. */
const STATE_MAX_ENTRIES = 1000;

/** Drops entries that no longer silence anything (older than the cooldown) and
 * caps the map so broken_citation paths can't grow the file forever. */
export function pruneAlertsState(
  state: Record<string, string>,
  nowMs: number,
  cooldownMs: number
): { state: Record<string, string>; changed: boolean } {
  const entries = Object.entries(state)
    .filter(([, iso]) => {
      const at = Date.parse(iso);
      return Number.isFinite(at) && nowMs - at < cooldownMs;
    })
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, STATE_MAX_ENTRIES);
  const next = Object.fromEntries(entries);
  return { state: next, changed: entries.length !== Object.keys(state).length };
}

export function createAlertsRunner(deps: AlertsRunnerDeps): AlertsRunner {
  const now = deps.now ?? Date.now;
  const windowMinutes = deps.windowMinutes ?? 10;
  // In-flight guard: a slow tick (sluggish ClickHouse/webhook) must not overlap
  // with the next interval firing — overlapping ticks would read stale state
  // and double-send the same alert.
  let running = false;

  async function tick(): Promise<AlertEvent[]> {
    if (running) {
      return [];
    }
    running = true;
    try {
      const config = await deps.metadata.getAlertsConfig();
      if (config === null || config.webhookUrl === "") {
        return [];
      }
      const enabled = Object.values(config.rules).some(Boolean);
      if (!enabled) {
        return [];
      }

      const cooldownMs = config.cooldownMinutes * 60_000;
      const pruned = pruneAlertsState(await deps.metadata.getAlertsState(), now(), cooldownMs);
      const state = pruned.state;
      const delivered: AlertEvent[] = [];
      let stateDirty = pruned.changed;

      for (const site of await deps.metadata.listSites()) {
        const fired = await evaluateRules(deps.client, site.id, {
          rules: config.rules,
          spikeFactor: config.spikeFactor,
          windowMinutes
        });
        for (const event of fired) {
          const key = dedupKey(event);
          const lastFired = state[key];
          if (lastFired !== undefined && now() - Date.parse(lastFired) < cooldownMs) {
            continue;
          }
          const ok = await deps.deliver(config.webhookUrl, {
            text: event.text,
            rule: event.rule,
            site: event.site,
            subject: event.subject
          });
          if (ok) {
            state[key] = new Date(now()).toISOString();
            stateDirty = true;
            delivered.push(event);
          }
          // failed delivery: no state write -> the alert retries next tick
        }
      }

      if (stateDirty) {
        await deps.metadata.setAlertsState(state);
      }
      return delivered;
    } catch (error) {
      // fail-open: a broken tick must never take the server down
      console.error("alerts tick failed:", error);
      return [];
    } finally {
      running = false;
    }
  }

  return { tick };
}
