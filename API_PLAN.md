# SECOP Semantic Search API — Execution Plan

**Project:** Semantic search + email-alert API over SECOP II active tenders, for SMEs picking a sector.
**Scope of this plan:** API only. Frontend is built on Vercel by another engineer; this repo exposes an HTTP contract and an `openapi.yaml`.
**Hosting:** Cloudflare (Workers + Workers AI + R2) + Turso (libSQL) + Resend. Strictly free tier.

---

## 1. Decisions locked in

| # | Decision | Value |
|---|---|---|
| D1 | Dataset | **`p6dx-8zbt`** — SECOP II - Procesos de Contratación (NOT `jbjy-vk9h` Contratos) |
| D2 | Sector scope | **Per-alert, user-chosen.** Ingest all sectors of currently-open tenders. Each alert carries its own `unspsc_segments[]` + budget band. |
| D3 | Backfill window on first run | **Open tenders only** — `estado='Publicado' AND fecha_de_recepcion_de > now()` (~2.2k rows at time of planning) |
| D4 | Embedding model | `@cf/baai/bge-m3` (1024-dim, multilingual, strong Spanish) on Workers AI |
| D5 | Summary model | `@cf/meta/llama-3.1-8b-instruct` on Workers AI, Spanish prompt, strict JSON output |
| D6 | Email | Resend (free: 100/day, 3k/mo) with verified sender domain |
| D7 | Vector store | Turso (libSQL) `F32_BLOB(1024)` + `libsql_vector_idx`. Single DB for vectors + relational. |
| D8 | Auth for alerts | Passwordless: HMAC-signed magic-link tokens emailed via Resend. No frontend-held API key. |
| D9 | Cron cadence | Every 6h: `0 */6 * * *` UTC |
| D10 | Watermark column | `fecha_de_ultima_publicaci` (catches addenda, not just first publish) |

---

## 2. Dataset evidence (do not re-litigate)

Confirmed live against Socrata on 2026-05-18:

- ~**2,221 currently-open tenders** (`Publicado` + `fecha_de_recepcion_de > now()`) — fits any free vector store.
- ~**500–3,400 row updates per day** dataset-wide. Filtered to alert sectors: tens-hundreds/day. Within 10k Workers AI neurons/day.
- Real active sample (NIT 800131070, "Mantenimiento y repuestos de cómputo", precio_base 49,565,304 COP, recepción 2026-05-19) confirms all required fields are populated on real rows.

### Socrata field-name gotchas (hard-code exactly)

Spanish accents were dropped inconsistently. The exact API names are:

- `descripci_n_del_procedimiento` (no `ó`)
- `fecha_de_ultima_publicaci` (truncated, no `ón`)
- `justificaci_n_modalidad_de`
- `ciudad_de_la_unidad_de`, `nombre_de_la_unidad_de`
- `urlproceso` → Socrata **URL type**, returns `{"url": "..."}` not a string. Flatten on ingest.

### "Open and SME-relevant" predicate (used in ingest AND search)

```
estado_del_procedimiento = 'Publicado'
AND fecha_de_recepcion_de > now()
AND precio_base BETWEEN <sme_min> AND <sme_max>          -- per-alert tunable
AND starts_with(codigo_principal_de_categoria, 'V1.<segment>')   -- UNSPSC segment(s)
```

UNSPSC value format from Socrata is `V1.SS.FF.CC.PP` — segment is positions 4–5 of the string.

---

## 3. Stack

| Layer | Service | Free-tier ceiling |
|---|---|---|
| Compute / API / cron | Cloudflare Workers + Cron Triggers | 100k req/day; 15 min CPU per cron run |
| AI (embed + summarize) | Workers AI | 10,000 Neurons/day |
| Vectors + relational | Turso (libSQL) | 9 GB storage, 1B row reads/mo |
| Raw payloads | R2 | 10 GB storage, 1M Class A / 10M Class B ops/mo |
| Email | Resend | 3k/mo, 100/day |
| Secrets | Wrangler secrets | Free |
| Observability | Workers Analytics + Logs | Free |

### Deliberately not used

- AWS (Lambda/SES/RDS/EC2): 12-month limits, SES sandbox friction, EC2 babysitting for embeddings.
- Bedrock / OpenAI: no free tier.
- OpenSearch: no free tier.
- Cloudflare Vectorize: tighter stored-vector ceiling than Turso for this corpus shape.

---

## 4. Architecture

```
                Socrata (datos.gov.co, p6dx-8zbt)
                            │ paged HTTPS pull, $where on fecha_de_ultima_publicaci
        Cron(6h) ──► Worker:ingest
                            │
                ┌───────────┼────────────┐
                ▼           ▼            ▼
              R2 (raw   Turso staging   watermark row
              gz audit)  (new IDs)       updated
                            │
                            ▼
                     Worker:enrich  ──► Workers AI: bge-m3 embed
                            │           Workers AI: llama-3.1-8b summarize (JSON)
                            ▼
                     Turso tenders (vec + meta)
                            │
                            ▼
                     Worker:match  ──► Resend (daily digest per email)
                            ▲
                            │
   Vercel frontend ──HTTPS──► Worker:api  ── CORS allowlist
                                /search /tenders/{id} /sectors /facets
                                /alerts/* (HMAC-token gated)
```

---

## 5. Frontend contract (handoff items)

The Vercel engineer consumes:

1. **`openapi.yaml`** committed at repo root and served from `GET /openapi.yaml`.
2. **CORS allowlist**: production Vercel domain, preview-deploy regex `*.vercel.app`, custom domain. Configured in the Worker code (not Cloudflare dashboard) so it ships through PRs.
3. **Auth model**:
   - **Public read**: `/health`, `/sectors`, `/facets`, `/search`, `/tenders/{id}` — no auth; per-IP rate limit via Cloudflare Rate Limiting Rules.
   - **Alert mutations**: passwordless magic link. Frontend posts `{email, query, filters}` to `POST /alerts`, API stores a draft (`verified=0`) and emails a one-time HMAC token. Subsequent `GET/PATCH/DELETE /alerts*` require `?token=`. Unsubscribe link in every email needs no auth (single-use token in URL).
4. **Error envelope**:
   ```json
   { "error": { "code": "VALIDATION_ERROR", "message": "human readable", "details": { } } }
   ```
   with documented codes: `VALIDATION_ERROR`, `NOT_FOUND`, `RATE_LIMITED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `INTERNAL`.
5. **Pagination**: cursor-based (`?cursor=&limit=`), opaque base64 cursor. Default `limit=20`, max `100`.
6. **Versioning**: prefix `/v1/...`. Breaking changes go to `/v2/...`.
7. **Postman collection** committed at `docs/postman.json` for manual testing.

### API surface (frozen for v1)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/health` | public | liveness + downstream check |
| GET | `/v1/openapi.yaml` | public | machine-readable contract |
| GET | `/v1/sectors` | public | UNSPSC segments + tender counts, for sector picker |
| GET | `/v1/facets` | public | dynamic counts for modalidad / estado / departamento |
| POST | `/v1/search` | public | `{query, unspsc_segments?, min_value?, max_value?, modalidad?, top_k?, cursor?}` → ranked tenders w/ summary |
| GET | `/v1/tenders/{id}` | public | full normalized tender + summary |
| POST | `/v1/alerts` | public | draft alert + send magic link |
| GET | `/v1/alerts/verify` | `?token=` | activate draft |
| GET | `/v1/alerts` | `?email=&token=` | list mine |
| PATCH | `/v1/alerts/{id}` | `?token=` | update |
| DELETE | `/v1/alerts/{id}` | `?token=` | unsubscribe |

---

## 6. Turso schema

```sql
CREATE TABLE tenders (
  id TEXT PRIMARY KEY,                                  -- id_del_proceso
  entidad TEXT, nit_entidad TEXT,
  departamento TEXT, ciudad TEXT,
  objeto TEXT,                                          -- descripci_n_del_procedimiento
  nombre TEXT,                                          -- nombre_del_procedimiento
  unspsc TEXT,                                          -- codigo_principal_de_categoria, e.g. V1.43.21.22.01
  unspsc_segment TEXT GENERATED ALWAYS AS (substr(unspsc, 4, 2)) STORED,
  modalidad TEXT, tipo_contrato TEXT, subtipo_contrato TEXT,
  precio_base REAL,
  estado TEXT, fase TEXT,
  fecha_publicacion TEXT,                               -- fecha_de_publicacion_del
  fecha_ultima TEXT,                                    -- fecha_de_ultima_publicaci   (watermark)
  fecha_recepcion TEXT,                                 -- fecha_de_recepcion_de
  url TEXT,                                             -- flattened from urlproceso.url
  summary_es TEXT,                                      -- AI-generated, JSON {summary, requirements[], who_should_bid}
  embedding F32_BLOB(1024),
  ingested_at TEXT, embedded_at TEXT
);
CREATE INDEX idx_tenders_active   ON tenders(estado, fecha_recepcion);
CREATE INDEX idx_tenders_unspsc   ON tenders(unspsc_segment, precio_base);
CREATE INDEX idx_tenders_vec      ON tenders(libsql_vector_idx(embedding));

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  query TEXT, query_embedding F32_BLOB(1024),
  unspsc_segments TEXT,                                 -- JSON array of 2-char codes
  min_value REAL, max_value REAL,
  modalidad TEXT,                                       -- nullable filter
  departamento TEXT,                                    -- nullable filter
  min_score REAL DEFAULT 0.55,
  verified INTEGER DEFAULT 0,
  last_sent_at TEXT, created_at TEXT
);
CREATE INDEX idx_alerts_email    ON alerts(email);
CREATE INDEX idx_alerts_verified ON alerts(verified);

CREATE TABLE watermark (
  dataset TEXT PRIMARY KEY,
  last_fecha_ultima TEXT,
  last_run_at TEXT,
  last_run_rows INTEGER
);
```

### Canonical search query

```sql
SELECT t.*, vector_distance_cos(t.embedding, :qvec) AS score
FROM vector_top_k('idx_tenders_vec', :qvec, 200) AS knn
JOIN tenders t ON t.rowid = knn.id
WHERE t.estado = 'Publicado'
  AND t.fecha_recepcion > :now
  AND (:segments_json IS NULL OR t.unspsc_segment IN (SELECT value FROM json_each(:segments_json)))
  AND t.precio_base BETWEEN :min_v AND :max_v
ORDER BY score
LIMIT :top_k;
```

---

## 7. Workers AI prompts

### Embedding
- Input text: `nombre + "\n" + objeto + "\n" + tipo_contrato + " " + modalidad`. Strip extra whitespace. Truncate to 2k chars (bge-m3 handles long context but this saves neurons).
- Same builder used for the alert's query text on subscription.

### Summary (strict JSON, Spanish)

```
Sistema: Eres un analista de contratación pública en Colombia. Devuelve SOLO JSON válido.

Usuario: Resume este proceso de contratación SECOP II para una PYME. Devuelve:
{
  "resumen": string (máx 280 caracteres, qué se contrata y para quién),
  "requisitos_clave": string[] (máx 5),
  "perfil_proveedor": string (1 frase: qué tipo de PYME debería ofertar)
}

Datos:
- Entidad: {entidad} ({ciudad}, {departamento})
- Nombre: {nombre}
- Objeto: {objeto}
- Modalidad: {modalidad}
- Tipo: {tipo_contrato}
- Precio base: {precio_base} COP
- Recepción de ofertas hasta: {fecha_recepcion}
```

Parse + validate with Zod. On parse failure, retry once with a "JSON only" reminder; if that fails, store `null` and log.

---

## 8. Repo layout

```
.
├── API_PLAN.md
├── openapi.yaml                 # generated; committed
├── wrangler.toml                # workspaces or per-worker tomls
├── package.json
├── tsconfig.json
├── docs/
│   ├── postman.json
│   └── RUNBOOK.md
├── shared/
│   ├── socrata.ts               # paged client, $where builder
│   ├── tursoClient.ts
│   ├── ai.ts                    # embed + summarize
│   ├── hmac.ts                  # magic-link tokens
│   └── schema.ts                # Zod schemas (source of OpenAPI)
├── migrations/
│   └── 0001_init.sql
└── workers/
    ├── ingest/                  # cron + manual backfill
    ├── enrich/                  # queue consumer; or polled in cron
    ├── api/                     # HTTP API
    └── match/                   # post-enrich; sends digests
```

---

## 9. Phases (each = one Claude Code session)

### P0 — Repo scaffold
**Deliverable:** repo deploys an empty `/health` Worker; Turso DB + migration applied; CI green.
- `wrangler init` (TypeScript), set up monorepo with shared lib.
- Create Turso DB, run `0001_init.sql` migration.
- GitHub Actions: typecheck, lint, `wrangler deploy --dry-run` per worker.
- Commit empty `openapi.yaml` skeleton + Postman collection scaffold.
- Wire secrets via `wrangler secret put`: `TURSO_URL`, `TURSO_TOKEN`, `RESEND_API_KEY`, `HMAC_SECRET`.

### P1 — Ingest worker + cron
**Deliverable:** cron pulls every 6h, R2 has gzipped batches, Turso has rows (no embeddings yet).
- Socrata client: paged `GET /resource/p6dx-8zbt.json` with `$where=fecha_de_ultima_publicaci > '{watermark}' AND estado_del_procedimiento='Publicado' AND fecha_de_recepcion_de > '{now}'` and `$order=fecha_de_ultima_publicaci ASC`, `$limit=1000`.
- Gzip raw page → R2 `raw/dt=YYYY-MM-DD/<run_id>-<page>.json.gz`.
- Normalize (flatten `urlproceso`, parse dates, extract `unspsc_segment`) and upsert into `tenders` with `embedding=NULL`.
- Update `watermark` row at end of run.
- Manual route `POST /admin/backfill` (auth: `Authorization: Bearer ${ADMIN_TOKEN}`) for re-running.
- Test: idempotent re-run produces zero net changes; watermark advances monotonically.

### P2 — Enrich worker
**Deliverable:** every tender ends up with `embedding` and `summary_es`.
- Selector: `WHERE embedding IS NULL ORDER BY fecha_ultima ASC LIMIT 50`.
- Per row: build embed-text, call `@cf/baai/bge-m3`; call `@cf/meta/llama-3.1-8b-instruct` with the JSON-strict prompt; validate JSON; write back `embedding`, `summary_es`, `embedded_at`.
- Neuron budget guard: track `neurons_used_today` in a Turso row; stop early at 8,000 to leave headroom.
- Triggered from cron (after ingest) and on-demand `POST /admin/enrich`.

### P3 — Search API + OpenAPI
**Deliverable:** all public read endpoints live; frontend dev unblocked.
- Implement with **Hono** + `@hono/zod-openapi` (Zod schemas double as OpenAPI source).
- Endpoints: `/health`, `/openapi.yaml`, `/sectors`, `/facets`, `/search`, `/tenders/{id}`.
- CORS: allowlist driven by env var `ALLOWED_ORIGINS` (comma list, supports `*.vercel.app` regex via a helper).
- Cloudflare Rate Limiting Rules: 60 req/min/IP on `/search`, 600 req/min/IP elsewhere.
- Error envelope helper + structured logs.
- Generate `openapi.yaml` in CI; fail build if drift vs Zod schemas.
- Hand Postman collection + URL to Vercel dev.

### P4 — Alerts
**Deliverable:** end-to-end create → verify → match → digest → unsubscribe.
- **Day 1:** Resend domain verify (DNS — start early).
- HMAC util (`Web Crypto` HS256), 7-day token for management, single-use token for unsub.
- `POST /alerts`: validate, persist draft with `verified=0`, embed query, send magic link.
- `GET /alerts/verify`, `GET /alerts`, `PATCH /alerts/{id}`, `DELETE /alerts/{id}`.
- Match worker (runs after enrich): for each `verified=1` alert, run the canonical search query restricted to `fecha_ultima > alert.last_sent_at`. Group by email. Send one digest per email per day. Update `last_sent_at`.
- Email template: subject `Nuevas oportunidades SECOP — {n}`; body lists each tender with link, deadline, summary, score; one-click unsub link in footer.

### P5 — Hardening + handoff
**Deliverable:** observable, documented, transferable.
- Cloudflare Workers Analytics dashboard tile per worker.
- Cost/quota dashboard: neurons/day, Turso row reads, Resend sends, R2 storage. Stored as a `/admin/stats` endpoint + a daily cron that posts to a private Slack/Discord webhook if any quota > 70%.
- `RUNBOOK.md`:
  - Rotate Resend / Turso / HMAC secrets
  - Replay backfill (cleared watermark, dropped table, etc.)
  - Drop & rebuild vector index
  - SES → Resend domain re-verify if DNS changes
  - Emergency disable-alerts flag (Turso `kv` row read at start of match worker)
- Extend `/health` to report: Turso reachable, Workers AI reachable (cached probe), last successful ingest age, last successful enrich age.

---

## 10. Quotas to watch (and what blows them up first)

| Quota | Limit | First thing that breaks it | Mitigation already in plan |
|---|---|---|---|
| Workers AI neurons | 10k/day | Backfilling a wide historical window | Backfill = open-only (~2k rows). Neuron budget guard in enrich. |
| Resend emails | 100/day | Sending one mail per match instead of per-day digest | Daily digest per `(email, day)` in match worker. |
| Turso row reads | 1B/mo | Re-scanning all tenders for every alert | `vector_top_k` returns 200; alert scan is restricted to `fecha_ultima > last_sent_at`. |
| Workers requests | 100k/day | Crawler hitting `/search` | Rate Limiting Rules + cache `Cache-Control: public, max-age=60` on `/search` with vary on body hash. |
| R2 Class A ops | 1M/mo | Writing one R2 object per tender | Batch per page, not per row. |
| Turso storage | 9 GB | Storing 1024-dim float32 vectors for 10M rows (~40 GB) | Open-tender scope keeps row count in low thousands. Periodic prune of `estado != 'Publicado' AND fecha_recepcion < now() - 90d`. |

---

## 11. Out of scope for v1 (track for v2)

- Historical "similar past tenders" feature (would need ingest of awarded + closed rows).
- Bidder/award analytics from `jbjy-vk9h`.
- User accounts beyond email + magic link.
- Multi-tenant API keys for partner integrations.
- Spanish UI copy generation beyond the JSON summary.
- Push notifications (web push / WhatsApp).

---

## 12. How to execute this plan with Claude Code

Start a fresh Claude Code session in this directory and say:

> *"Read API_PLAN.md. Execute Phase P0 (Repo scaffold). Stop after the deliverable is met and report what to verify."*

Repeat per phase. Each phase's "Deliverable" line is the stop condition.
