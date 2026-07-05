import { nextSensor, type NextRequestLike } from "@crawlytics/sensor-node";

const recordCrawlyticsRequest = nextSensor({
  key: process.env["CRAWLYTICS_KEY"] ?? "",
  url: process.env["CRAWLYTICS_URL"] ?? "https://analytics.example.com"
});

export function middleware(request: NextRequestLike) {
  recordCrawlyticsRequest(request);

  // In a real Next.js app, import NextResponse from "next/server" and return:
  // return NextResponse.next();
}
