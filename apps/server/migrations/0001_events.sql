-- Raw enriched events. One row per HTTP request seen by any sensor.
CREATE TABLE IF NOT EXISTS events (
  site_id LowCardinality(String),
  ts DateTime64(3, 'UTC'),
  ip_hash UInt64,
  bot_ip String DEFAULT '',
  method LowCardinality(String),
  path String,
  path_group String,
  query String DEFAULT '',
  status UInt16,
  bytes UInt64,
  response_ms UInt32 DEFAULT 0,
  ua String,
  actor_type LowCardinality(String),
  bot_id LowCardinality(String) DEFAULT '',
  operator LowCardinality(String) DEFAULT '',
  verification LowCardinality(String) DEFAULT 'na',
  referer String DEFAULT '',
  ai_referral LowCardinality(String) DEFAULT '',
  topic_id LowCardinality(String) DEFAULT '',
  session_id UInt64,
  ingest_source LowCardinality(String) DEFAULT 'api'
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (site_id, actor_type, ts)
TTL toDateTime(ts) + INTERVAL 13 MONTH
