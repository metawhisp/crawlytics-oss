import type { RawLogEvent } from "./types.js";

export const INGEST_BATCH_MAX = 5000;

const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 5000;
const DEFAULT_MAX_RETRIES = 3;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PostEventsOptions {
  url: string;
  key: string;
  fetch?: FetchLike;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface PostEventsSummary {
  /** Events the server said it accepted — not the number handed over. */
  sent: number;
  /** Events the server read and refused, one at a time. */
  rejected: number;
  requests: number;
}

export async function postEvents(
  events: readonly RawLogEvent[],
  options: PostEventsOptions
): Promise<PostEventsSummary> {
  if (events.length === 0) {
    return { rejected: 0, requests: 0, sent: 0 };
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }

  const ingestUrl = buildIngestUrl(options.url);
  let requests = 0;
  let sent = 0;
  let rejected = 0;

  for (let offset = 0; offset < events.length; offset += INGEST_BATCH_MAX) {
    const chunk = events.slice(offset, offset + INGEST_BATCH_MAX);
    try {
      const outcome = await postChunk(chunk, ingestUrl, options, fetchImpl);
      sent += outcome.accepted;
      rejected += outcome.rejected;
    } catch (error) {
      // How far it got, attached to whatever went wrong. A caller that keeps
      // the events has to know which ones the server already committed:
      // putting all of them back re-sends the accepted ones, and the events
      // table has no unique key, so those rows simply double.
      throw withDelivered(error, offset);
    }
    requests += 1;
  }

  return { rejected, requests, sent };
}

async function postChunk(
  events: readonly RawLogEvent[],
  url: string,
  options: PostEventsOptions,
  fetchImpl: FetchLike
): Promise<{ accepted: number; rejected: number }> {
  const body = JSON.stringify({ events });
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.key}`,
          "Content-Type": "application/json"
        },
        body
      });
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(getBackoffDelayMs(attempt, options));
        continue;
      }

      throw new Error(`Ingest POST failed: ${formatUnknownError(error)}`, { cause: error });
    }

    if (response.ok) {
      // The server reads events one at a time, so a 202 can carry a count of
      // the ones it refused. Reporting the batch size instead would hide every
      // per-event drop from the import summary and the tailer's heartbeat.
      return await readOutcome(response, events.length);
    }

    if (isRetryableStatus(response.status) && attempt < maxRetries) {
      await sleep(getRetryDelayMs(response, attempt, options));
      continue;
    }

    throw await buildHttpError(response);
  }

  // The loop either returns or throws; this is unreachable and only here
  // because the compiler cannot see that.
  throw new Error("Ingest POST retry loop ended without a result");
}

async function readOutcome(
  response: Response,
  handed: number
): Promise<{ accepted: number; rejected: number }> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "accepted" in body) {
      const { accepted, rejected } = body as { accepted: unknown; rejected?: unknown };
      if (typeof accepted === "number") {
        return {
          accepted,
          rejected: typeof rejected === "number" ? rejected : Math.max(0, handed - accepted)
        };
      }
    }
  } catch {
    // 204, an empty body, or anything not JSON: an older server that does not
    // report this. Everything handed over counts as accepted, as it did then.
  }
  return { accepted: handed, rejected: 0 };
}

function buildIngestUrl(url: string): string {
  return `${url.replace(/\/+$/u, "")}/api/ingest`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function getRetryDelayMs(
  response: Response,
  attempt: number,
  options: PostEventsOptions
): number {
  const retryAfterDelay = parseRetryAfterMs(response.headers.get("Retry-After"));
  if (retryAfterDelay !== undefined) {
    return Math.min(retryAfterDelay, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  }

  return getBackoffDelayMs(attempt, options);
}

function getBackoffDelayMs(attempt: number, options: PostEventsOptions): number {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  return Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) {
    return undefined;
  }

  return Math.max(0, retryAt - Date.now());
}

/** How many events of the batch reached the server before this error. Present
 * on every error postEvents throws. */
export interface DeliveredSoFar {
  delivered: number;
}

function withDelivered(error: unknown, delivered: number): unknown {
  if (typeof error === "object" && error !== null) {
    Object.defineProperty(error, "delivered", { value: delivered, enumerable: true });
    return error;
  }
  return Object.assign(new Error(String(error)), { delivered });
}

/** Carries the status, so a caller holding events can tell "come back later"
 * from "this will never be accepted" without parsing the message. */
export class IngestHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "IngestHttpError";
    this.status = status;
  }
}

async function buildHttpError(response: Response): Promise<Error> {
  const body = (await response.text()).trim();
  const statusText = response.statusText.length === 0 ? "" : ` ${response.statusText}`;
  const bodyText = body.length === 0 ? "" : `: ${body.slice(0, 512)}`;

  return new IngestHttpError(
    `Ingest POST failed with HTTP ${String(response.status)}${statusText}${bodyText}`,
    response.status
  );
}

async function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
