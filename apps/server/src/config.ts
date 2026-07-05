export interface ServerConfig {
  port: number;
  host: string;
  /** API key -> site id. */
  keys: Map<string, string>;
  ipHashSecret: string;
  clickhouse: {
    url: string;
    database: string;
    username: string;
    password: string;
  };
}

/**
 * TC_INGEST_KEYS format: "key1:site1,key2:site2".
 * Postgres-backed sites/keys arrive in a later iteration; env config keeps the
 * self-host story to a single container meanwhile.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const keys = new Map<string, string>();
  for (const pair of (env["TC_INGEST_KEYS"] ?? "").split(",")) {
    const [key, siteId] = pair.split(":").map((part) => part.trim());
    if (key && siteId) {
      keys.set(key, siteId);
    }
  }

  const secret = env["TC_IP_HASH_SECRET"];
  if (!secret) {
    throw new Error("TC_IP_HASH_SECRET is required (random string; rotating it resets visitor hashes)");
  }
  // TC_INGEST_KEYS is optional now: with file-backed metadata a fresh instance
  // starts empty and creates sites/keys through onboarding (env keys are seeded
  // when present, but are no longer required to boot).

  return {
    port: Number(env["PORT"] ?? 3000),
    host: env["HOST"] ?? "0.0.0.0",
    keys,
    ipHashSecret: secret,
    clickhouse: {
      url: env["CLICKHOUSE_URL"] ?? "http://localhost:8123",
      database: env["CLICKHOUSE_DATABASE"] ?? "tracecontrol",
      username: env["CLICKHOUSE_USER"] ?? "tracecontrol",
      password: env["CLICKHOUSE_PASSWORD"] ?? "tracecontrol"
    }
  };
}
