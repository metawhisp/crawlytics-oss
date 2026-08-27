/** Webhook delivery — strictly fail-open: an unreachable webhook must never
 * throw into the runner loop or crash the server. One retry, then give up
 * (the runner re-fires the alert on a later tick because state isn't saved). */

export interface WebhookPayload {
  /** Human-readable message — also what Slack-compatible webhooks render. */
  text: string;
  rule: string;
  site: string;
  subject: string;
}

const TIMEOUT_MS = 10_000;

export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  let lastError = "non-2xx response";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (response.ok) {
        return true;
      }
      lastError = `HTTP ${String(response.status)}`;
    } catch (error) {
      // network error / timeout — retry once, then report failure
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  console.warn(`alert webhook delivery failed (${payload.rule}/${payload.site}): ${lastError}`);
  return false;
}
