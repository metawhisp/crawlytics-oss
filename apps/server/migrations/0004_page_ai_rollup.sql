-- Daily per-page AI rollup that knows whether a hit was forged.
--
-- daily_page_stats cannot answer this: it has no verification column, and a
-- SummingMergeTree cannot gain one because the ORDER BY is fixed. The pages
-- chart was therefore reading raw events twice over a window of up to a year,
-- which is fine on a small site and punishing on a large one.
--
-- This file creates the table and nothing else. It shipped with a backfill and
-- a view, and both moved to 0005 because neither was safe to run twice: an
-- unconditional INSERT ... SELECT into a SummingMergeTree adds the history to
-- itself. Editing an applied migration is normally wrong, but the only instance
-- that ever ran this one is ours, while every self-host upgrading from the
-- public release runs it for the first time — and would otherwise run the
-- unsafe version. 0005 reaches the same end state from either side.
--
-- errors sits immediately after hits so the column order matches what
-- ALTER TABLE ... ADD COLUMN produces on an instance that already has the
-- six-column table.
CREATE TABLE IF NOT EXISTS daily_page_ai_stats (
  site_id LowCardinality(String),
  date Date,
  path_group String,
  actor_type LowCardinality(String),
  verification LowCardinality(String),
  hits UInt64,
  errors UInt64
)
ENGINE = SummingMergeTree
ORDER BY (site_id, date, path_group, actor_type, verification)
