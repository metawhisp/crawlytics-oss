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
  sent: number;
  requests: number;
}

export async function postEvents(
  events: readonly RawLogEvent[],
  options: PostEventsOptions
): Promise<PostEventsSummary> {
  if (events.length === 0) {
    return { requests: 0, sent: 0 };
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available");
  }

  const ingestUrl = buildIngestUrl(options.url);
  let requests = 0;

  for (let offset = 0; offset < events.length; offset += INGEST_BATCH_MAX) {
    const chunk = events.slice(offset, offset + INGEST_BATCH_MAX);
    await postChunk(chunk, ingestUrl, options, fetchImpl);
    requests += 1;
  }

  return { requests, sent: events.length };
}

async function postChunk(
  events: readonly RawLogEvent[],
  url: string,
  options: PostEventsOptions,
  fetchImpl: FetchLike
): Promise<void> {
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
      return;
    }

    if (isRetryableStatus(response.status) && attempt < maxRetries) {
      await sleep(getRetryDelayMs(response, attempt, options));
      continue;
    }

    throw await buildHttpError(response);
  }
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

async function buildHttpError(response: Response): Promise<Error> {
  const body = (await response.text()).trim();
  const statusText = response.statusText.length === 0 ? "" : ` ${response.statusText}`;
  const bodyText = body.length === 0 ? "" : `: ${body.slice(0, 512)}`;

  return new Error(`Ingest POST failed with HTTP ${String(response.status)}${statusText}${bodyText}`);
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
