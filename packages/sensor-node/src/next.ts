import { createSensor, type CreateSensorOptions, type RawSensorEvent } from "./sensor.js";

export interface NextRequestLike {
  headers: {
    get(name: string): string | null;
  };
  ip?: string;
  method?: string;
  nextUrl?: {
    pathname?: string;
  };
  url: string;
}

export type NextSensor = (request: NextRequestLike) => void;

export function nextSensor(options: CreateSensorOptions): NextSensor {
  const sensor = createSensor(options);

  return (request) => {
    try {
      sensor.record(buildNextEvent(request));
    } catch {
      // fail-open
    }
  };
}

function buildNextEvent(request: NextRequestLike): RawSensorEvent {
  return {
    // Next.js middleware runs before a response exists, so status and bytes are unavailable here.
    // Full response capture requires route instrumentation instead of middleware.
    bytes: 0,
    ip: getClientIp(request),
    method: request.method ?? "",
    path: getPath(request),
    referer: getHeader(request, "referer") || getHeader(request, "referrer"),
    status: 0,
    ts: new Date().toISOString(),
    ua: getHeader(request, "user-agent")
  };
}

function getClientIp(request: NextRequestLike): string {
  if (typeof request.ip === "string" && request.ip.length > 0) {
    return request.ip;
  }

  const forwardedFor = getHeader(request, "x-forwarded-for");
  if (forwardedFor.length === 0) {
    return "";
  }

  return forwardedFor.split(",")[0]?.trim() ?? "";
}

function getPath(request: NextRequestLike): string {
  if (typeof request.nextUrl?.pathname === "string") {
    return request.nextUrl.pathname;
  }

  return new URL(request.url).pathname;
}

function getHeader(request: NextRequestLike, name: string): string {
  try {
    return request.headers.get(name) ?? "";
  } catch {
    return "";
  }
}
