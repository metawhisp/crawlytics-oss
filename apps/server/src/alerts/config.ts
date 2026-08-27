/** Alert configuration + defaults. Alerts are OFF until the owner sets a
 * webhook URL — the server never posts anywhere out of the box. */

export interface AlertRulesConfig {
  /** AI hits in the last hour spiked vs the 7-day hourly average. */
  spike: boolean;
  /** A bot_id seen for the first time (not present in the previous 30 days). */
  newBot: boolean;
  /** Spoofed-verification events appeared in the window. */
  spoof: boolean;
  /** An AI bot hit >=400 on a page that previously served citations fine. */
  brokenCitation: boolean;
}

export interface AlertsConfig {
  /** Empty string = alerts disabled (the default). */
  webhookUrl: string;
  rules: AlertRulesConfig;
  /** Fire spike when last-hour AI hits > factor x 7-day hourly average. */
  spikeFactor: number;
  /** Per (rule, site, subject) silence window after a delivery. */
  cooldownMinutes: number;
}

/** lastFired ISO timestamp per dedup key `rule|site|subject`. */
export type AlertsState = Record<string, string>;

export const DEFAULT_ALERTS_CONFIG: AlertsConfig = {
  webhookUrl: "",
  rules: { spike: true, newBot: true, spoof: true, brokenCitation: true },
  spikeFactor: 3,
  cooldownMinutes: 360
};

/** One fired alert, before dedup/delivery. */
export interface AlertEvent {
  rule: "spike" | "new_bot" | "spoof" | "broken_citation";
  site: string;
  /** What the alert is about (bot id, path, ...) — part of the dedup key. */
  subject: string;
  /** Human-readable one-liner for the webhook message. */
  text: string;
}

export function dedupKey(event: AlertEvent): string {
  return `${event.rule}|${event.site}|${event.subject}`;
}
