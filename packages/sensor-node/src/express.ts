import type { IncomingHttpHeaders } from "node:http";

import { createSensor, type CreateSensorOptions, type RawSensorEvent } from "./sensor.js";

type RequestHeaderValue = IncomingHttpHeaders[string];
type ResponseHeaderValue = number | string | string[] | undefined;

export interface ExpressRequestLike {
  headers?: IncomingHttpHeaders;
  ip?: string;
  method?: string;
  originalUrl?: string;
  url?: string;
}

export interface ExpressResponseLike {
  statusCode?: number;
  getHeader(name: string): ResponseHeaderValue;
  on(event: "finish", listener: () => void): unknown;
}

export type ExpressNextFunction = () => void;

export type ExpressMiddleware = (
  req: ExpressRequestLike,
  res: ExpressResponseLike,
  next: ExpressNextFunction
) => void;

export type ExpressSensorOptions = CreateSensorOptions;

export function expressSensor(options: ExpressSensorOptions): ExpressMiddleware {
  const sensor = createSensor(options);

  return (req, res, next) => {
    try {
      res.on("finish", () => {
        try {
          sensor.record(buildExpressEvent(req, res));
        } catch {
          // fail-open
        }
      });
    } catch {
      // fail-open
    }

    next();
  };
}

function buildExpressEvent(req: ExpressRequestLike, res: ExpressResponseLike): RawSensorEvent {
  const headers = req.headers ?? {};
  const contentLength = Number(res.getHeader("content-length")) || 0;

  return {
    bytes: contentLength,
    ip: getClientIp(req, headers),
    method: req.method ?? "",
    path: req.originalUrl ?? req.url ?? "",
    referer: getHeaderString(headers.referer) || getHeaderString(headers.referrer),
    status: Number.isFinite(res.statusCode) ? Number(res.statusCode) : 0,
    ts: new Date().toISOString(),
    ua: getHeaderString(headers["user-agent"])
  };
}

function getClientIp(req: ExpressRequestLike, headers: IncomingHttpHeaders): string {
  if (typeof req.ip === "string" && req.ip.length > 0) {
    return req.ip;
  }

  const forwardedFor = getHeaderString(headers["x-forwarded-for"]);
  if (forwardedFor.length === 0) {
    return "";
  }

  return forwardedFor.split(",")[0]?.trim() ?? "";
}

function getHeaderString(value: RequestHeaderValue): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return value ?? "";
}
