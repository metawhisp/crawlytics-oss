-- Rebuilds daily_page_ai_stats from events, safely and within a bounded window.
--
-- Safe to run twice BY CONSTRUCTION, which is the point. Migrations are recorded
-- in _migrations after their statements run, so a process killed in between runs
-- them again on the next boot. For a SummingMergeTree that is fatal unless the
-- rebuild starts from empty — hence the TRUNCATE. (The bookkeeping row is also
-- written synchronously now; this is the second layer, not a replacement.)
--
-- Order matters: the view is dropped first so nothing writes into the table
-- while it is being refilled, and recreated last so no row is counted by both
-- the backfill and the view. Migrations run before the server listens, so
-- nothing is ingesting during this window.
--
-- Three trajectories, one end state:
--   * this instance      — 0004 already applied, ALTER adds the column, rebuild
--   * upgrade from the public release — 0004 creates the table, rebuild is cheap
--   * fresh install      — the table is empty, the backfill selects nothing
--
-- The 365-day bound matches the largest window the API will serve (days is
-- capped at 365) and leaves out data nothing can display, while events are
-- retained for 13 months. Consequence, accepted: a log line older than a year
-- replayed through ingest enters the rollup via the view, and a later rebuild
-- drops it again. Neither state is reachable through the API.
ALTER TABLE daily_page_ai_stats ADD COLUMN IF NOT EXISTS errors UInt64 DEFAULT 0;

DROP VIEW IF EXISTS daily_page_ai_stats_mv;

TRUNCATE TABLE daily_page_ai_stats;

INSERT INTO daily_page_ai_stats (site_id, date, path_group, actor_type, verification, hits, errors)
SELECT site_id, toDate(ts) AS date, path_group, actor_type, verification,
       count() AS hits, countIf(status >= 400) AS errors
FROM events
WHERE actor_type LIKE 'ai_%' AND toDate(ts) >= today() - 365
GROUP BY site_id, date, path_group, actor_type, verification;

CREATE MATERIALIZED VIEW daily_page_ai_stats_mv TO daily_page_ai_stats
(
  site_id LowCardinality(String),
  date Date,
  path_group String,
  actor_type LowCardinality(String),
  verification LowCardinality(String),
  hits UInt64,
  errors UInt64
) AS
SELECT site_id, toDate(ts) AS date, path_group, actor_type, verification,
       count() AS hits, countIf(status >= 400) AS errors
FROM events
WHERE actor_type LIKE 'ai_%'
GROUP BY site_id, date, path_group, actor_type, verification
