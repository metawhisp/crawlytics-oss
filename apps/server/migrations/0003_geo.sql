-- Geo/network enrichment from edge sensors (Cloudflare cf object)
ALTER TABLE events ADD COLUMN IF NOT EXISTS country LowCardinality(String) DEFAULT '';

ALTER TABLE events ADD COLUMN IF NOT EXISTS asn UInt32 DEFAULT 0;

ALTER TABLE events ADD COLUMN IF NOT EXISTS as_org LowCardinality(String) DEFAULT ''
