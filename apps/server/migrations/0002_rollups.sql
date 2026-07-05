-- Daily per-bot rollup
CREATE TABLE IF NOT EXISTS daily_bot_stats (
  site_id LowCardinality(String),
  date Date,
  actor_type LowCardinality(String),
  bot_id LowCardinality(String),
  operator LowCardinality(String),
  verification LowCardinality(String),
  hits UInt64,
  bytes UInt64,
  errors UInt64
)
ENGINE = SummingMergeTree
ORDER BY (site_id, date, actor_type, bot_id, operator, verification);

CREATE MATERIALIZED VIEW IF NOT EXISTS daily_bot_stats_mv TO daily_bot_stats AS
SELECT
  site_id,
  toDate(ts) AS date,
  actor_type,
  bot_id,
  operator,
  verification,
  count() AS hits,
  sum(bytes) AS bytes,
  countIf(status >= 400) AS errors
FROM events
GROUP BY site_id, date, actor_type, bot_id, operator, verification;

-- Daily per-page rollup
CREATE TABLE IF NOT EXISTS daily_page_stats (
  site_id LowCardinality(String),
  date Date,
  path_group String,
  actor_type LowCardinality(String),
  operator LowCardinality(String),
  hits UInt64,
  errors UInt64
)
ENGINE = SummingMergeTree
ORDER BY (site_id, date, path_group, actor_type, operator);

CREATE MATERIALIZED VIEW IF NOT EXISTS daily_page_stats_mv TO daily_page_stats AS
SELECT
  site_id,
  toDate(ts) AS date,
  path_group,
  actor_type,
  operator,
  count() AS hits,
  countIf(status >= 400) AS errors
FROM events
GROUP BY site_id, date, path_group, actor_type, operator;

-- Daily AI-referral rollup (human traffic from assistants)
CREATE TABLE IF NOT EXISTS daily_referrals (
  site_id LowCardinality(String),
  date Date,
  ai_referral LowCardinality(String),
  path_group String,
  hits UInt64
)
ENGINE = SummingMergeTree
ORDER BY (site_id, date, ai_referral, path_group);

CREATE MATERIALIZED VIEW IF NOT EXISTS daily_referrals_mv TO daily_referrals AS
SELECT
  site_id,
  toDate(ts) AS date,
  ai_referral,
  path_group,
  count() AS hits
FROM events
WHERE ai_referral != ''
GROUP BY site_id, date, ai_referral, path_group
