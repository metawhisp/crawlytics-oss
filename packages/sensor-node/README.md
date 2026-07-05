# @crawlytics/sensor-node

Fail-open Node sensors for Crawlytics.

## Core

```ts
import { createSensor } from "@crawlytics/sensor-node";

const sensor = createSensor({
  key: process.env["CRAWLYTICS_KEY"] ?? "",
  url: process.env["CRAWLYTICS_URL"] ?? "http://localhost:3000"
});

sensor.record({
  bytes: 0,
  ip: "203.0.113.10",
  method: "GET",
  path: "/robots.txt",
  referer: "",
  status: 200,
  ts: new Date().toISOString(),
  ua: "GPTBot/1.3"
});
```

## Express

```ts
import express from "express";
import { expressSensor } from "@crawlytics/sensor-node";

const app = express();

app.use(
  expressSensor({
    key: process.env["CRAWLYTICS_KEY"] ?? "",
    url: process.env["CRAWLYTICS_URL"] ?? "http://localhost:3000"
  })
);
```

## Next.js Middleware

```ts
import { nextSensor, type NextRequestLike } from "@crawlytics/sensor-node";

const recordCrawlyticsRequest = nextSensor({
  key: process.env["CRAWLYTICS_KEY"] ?? "",
  url: process.env["CRAWLYTICS_URL"] ?? "http://localhost:3000"
});

export function middleware(request: NextRequestLike) {
  recordCrawlyticsRequest(request);

  // In a real Next.js app, import NextResponse from "next/server" and return:
  // return NextResponse.next();
}
```

The Next.js adapter is request-side only because middleware runs before the
response is produced. It records method, path, user agent, referer, and client IP,
but response status and bytes are not available in middleware and are sent as
`status: 0` and `bytes: 0`. Full response capture requires route instrumentation,
which is outside this middleware adapter.

The sensor buffers raw events and posts them to `/api/ingest` in the background.
All reporting errors are swallowed so analytics cannot break the host app.
