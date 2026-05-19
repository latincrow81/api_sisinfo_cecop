-- 0001_init.sql — initial schema for SECOP semantic search API.
-- Target: Turso (libSQL). Run via `turso db shell <db> < migrations/0001_init.sql`.
-- See API_PLAN.md §6 for design rationale.

CREATE TABLE IF NOT EXISTS tenders (
  id                TEXT PRIMARY KEY,                                  -- id_del_proceso
  entidad           TEXT,
  nit_entidad       TEXT,
  departamento      TEXT,
  ciudad            TEXT,
  objeto            TEXT,                                              -- descripci_n_del_procedimiento
  nombre            TEXT,                                              -- nombre_del_procedimiento
  unspsc            TEXT,                                              -- codigo_principal_de_categoria, e.g. V1.43.21.22.01
  unspsc_segment    TEXT GENERATED ALWAYS AS (substr(unspsc, 4, 2)) STORED,
  modalidad         TEXT,
  tipo_contrato     TEXT,
  subtipo_contrato  TEXT,
  precio_base       REAL,
  estado            TEXT,
  fase              TEXT,
  fecha_publicacion TEXT,                                              -- fecha_de_publicacion_del
  fecha_ultima      TEXT,                                              -- fecha_de_ultima_publicaci   (watermark)
  fecha_recepcion   TEXT,                                              -- fecha_de_recepcion_de
  url               TEXT,                                              -- flattened from urlproceso.url
  summary_es        TEXT,                                              -- AI JSON {resumen, requisitos_clave[], perfil_proveedor}
  embedding         F32_BLOB(1024),
  ingested_at       TEXT,
  embedded_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_tenders_active ON tenders(estado, fecha_recepcion);
CREATE INDEX IF NOT EXISTS idx_tenders_unspsc ON tenders(unspsc_segment, precio_base);
CREATE INDEX IF NOT EXISTS idx_tenders_vec    ON tenders(libsql_vector_idx(embedding));

CREATE TABLE IF NOT EXISTS alerts (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  query           TEXT,
  query_embedding F32_BLOB(1024),
  unspsc_segments TEXT,                                                -- JSON array of 2-char codes
  min_value       REAL,
  max_value       REAL,
  modalidad       TEXT,
  departamento    TEXT,
  min_score       REAL DEFAULT 0.55,
  verified        INTEGER DEFAULT 0,
  last_sent_at    TEXT,
  created_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_email    ON alerts(email);
CREATE INDEX IF NOT EXISTS idx_alerts_verified ON alerts(verified);

CREATE TABLE IF NOT EXISTS watermark (
  dataset           TEXT PRIMARY KEY,
  last_fecha_ultima TEXT,
  last_run_at       TEXT,
  last_run_rows     INTEGER
);

INSERT OR IGNORE INTO watermark (dataset, last_fecha_ultima, last_run_at, last_run_rows)
VALUES ('p6dx-8zbt', NULL, NULL, 0);
