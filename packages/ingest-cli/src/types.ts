export interface RawLogEvent {
  ts: string;
  ip: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  ua: string;
  referer: string;
  responseMs?: number;
}

export type LogFormat =
  | "apache"
  | "nginx-combined"
  | "nginx-json"
  | "caddy-json"
  | "cloudflare-ndjson"
  | "jsonl";
