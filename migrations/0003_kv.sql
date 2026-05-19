-- 0003_kv.sql — generic key/value store for ops toggles.
-- Known keys (see RUNBOOK.md):
--   alerts.disabled = "1"   match worker exits early without sending any digests

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT
);
