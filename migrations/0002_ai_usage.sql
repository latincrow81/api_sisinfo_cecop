-- 0002_ai_usage.sql — daily Workers AI neuron budget tracking for the enrich worker.
-- One row per UTC day. The enrich worker upserts after every batch.

CREATE TABLE IF NOT EXISTS ai_usage (
  day             TEXT PRIMARY KEY,                         -- YYYY-MM-DD UTC
  neurons_used    INTEGER NOT NULL DEFAULT 0,
  embeds_count    INTEGER NOT NULL DEFAULT 0,
  summaries_count INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT
);
