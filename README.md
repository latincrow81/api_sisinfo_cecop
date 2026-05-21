# SECOP Semantic Search API

Semantic search + email-alert API over SECOP II active tenders
(Socrata dataset [`p6dx-8zbt`](https://www.datos.gov.co/resource/p6dx-8zbt.json)).
Built for Colombian SMEs to find open public-procurement opportunities by sector and
natural-language query.

- **API:** [`https://secop-api.mescude1.workers.dev`](https://secop-api.mescude1.workers.dev) — `GET /v1/health`, `POST /v1/search`, …
- **OpenAPI:** [`/v1/openapi.yaml`](https://secop-api.mescude1.workers.dev/v1/openapi.yaml) (also committed at [`openapi.yaml`](./openapi.yaml))
- **Plan / decisions:** [`API_PLAN.md`](./API_PLAN.md)
- **Ops:** [`docs/RUNBOOK.md`](./docs/RUNBOOK.md)

---

## What it does

1. **Ingest** — every 6 h, pull currently-open SECOP II tenders from Socrata, gzip the raw
   pages to Linode Object Storage for replay, upsert normalized rows into Turso.
2. **Enrich** — for any tender missing AI artifacts, call Workers AI to compute a
   1024-dim multilingual embedding (`bge-m3`) and a Spanish JSON summary
   (`llama-3.1-8b-instruct`). Budgeted to stay under 8k neurons/day.
3. **Search** — `POST /v1/search` embeds the user's Spanish query and runs a libSQL
   `vector_top_k` against the tender index, filtered by UNSPSC segment, value band,
   modalidad, etc.
4. **Alerts** — passwordless: `POST /v1/alerts` stores a draft and emails a magic-link
   HMAC token via Resend. Once verified, a cron-driven match worker runs each alert's
   embedding against fresh tenders and sends at most one digest email per (email, day).

---

## Architecture

```
                       Socrata (datos.gov.co, p6dx-8zbt)
                                  │  paged HTTPS pull, $where on fecha_de_ultima_publicaci
                                  ▼
              ┌─────► Worker: secop-ingest ───► Linode Object Storage (raw gz audit)
   Cron 6h ──┤        (POST /admin/backfill)         │
              │                                       └──► Turso `tenders` (no embeddings yet)
              │                                                       │
              ▼                                                       │
        Worker: secop-enrich  ──► Workers AI  bge-m3 embed (1024d) ───┤
        (POST /admin/enrich)      Workers AI  llama-3.1-8b summary    │
        neuron-budget guarded                                         ▼
                                                            Turso `tenders` (vec + summary)
                                                                      │
        Cron 30min ──► Worker: secop-match ──► Resend digest email     │
                       (POST /admin/match)    one per (email, day)     │
                       HMAC unsubscribe token in every email           │
                                  ▲                                   │
                                  │                                   ▼
            Vercel frontend ─HTTPS─► Worker: secop-api  ──► Turso  (semantic search,
                                     CORS allowlist                    sectors, facets,
                                     /v1/health /v1/sectors            tender lookup)
                                     /v1/facets /v1/search
                                     /v1/tenders/{id} /v1/alerts/*
                                     /v1/openapi.{yaml,json}
                                     /admin/stats (Bearer)
```

Four Cloudflare Workers share `shared/` (libSQL client, Socrata client, embedding /
summary prompts, HMAC tokens, Resend client, normalization). All bind the same Turso DB.
HMAC_SECRET must match between `secop-api` and `secop-match` so unsubscribe tokens minted
by one verify in the other.

---

## Stack

| Layer | Service | Free-tier ceiling |
|---|---|---|
| Compute / API / cron | Cloudflare Workers + Cron Triggers | 100k req/day; 15 min CPU per cron |
| AI (embed + summarize) | Workers AI (`bge-m3`, `llama-3.1-8b-instruct`) | 10,000 neurons/day (we guard at 8k) |
| Vectors + relational | Turso (libSQL), `F32_BLOB(1024)` + `libsql_vector_idx` | 9 GB storage, 1B row reads/mo |
| Raw audit batches | Linode Object Storage (S3-compatible) | per Linode plan |
| Email | Resend, verified domain | 100/day, 3k/mo |
| Secrets | `wrangler secret` | – |

Rationale for picking each (and what was explicitly rejected) is in
[`API_PLAN.md §3`](./API_PLAN.md).

---

## Repo layout

```
shared/
  src/
    ai.ts            EMBED_MODEL, SUMMARY_MODEL, neuron constants, prompt builders
    email.ts         Resend client (sendEmail) + escapeHtml
    hmac.ts          HS256 token sign/verify (manage_alert / manage_email / unsubscribe)
    normalize.ts     Socrata row → Turso column mapping (urlproceso flatten, date parse)
    schema.ts        re-exports for Zod schemas
    socrata.ts       paged fetch + $where builder (buildOpenTendersWhere)
    tursoClient.ts   createClient wrapper

workers/
  api/        secop-api    HTTP API (Hono + @hono/zod-openapi), alerts, admin/stats, OpenAPI doc
  ingest/     secop-ingest cron-driven Socrata pull, gz to Linode, upsert to Turso
  enrich/     secop-enrich cron + admin, embed + summarize pending tenders, budget-guarded
  match/      secop-match  cron + admin, alert ↔ tender matching, digest sending

migrations/
  0001_init.sql    tenders, alerts, watermark + indexes (incl. libsql_vector_idx)
  0002_ai_usage.sql  daily neuron counter
  0003_kv.sql      kv table (used for `alerts.disabled` emergency flag)

scripts/
  generate-openapi.ts    rebuilds openapi.yaml from Zod schemas
  check-openapi-drift.ts CI guard — fails if Zod ↔ committed yaml diverges
  smoke.ts               end-to-end HTTP smoke for every endpoint

docs/
  RUNBOOK.md     phase-by-phase ops playbook (bootstrap, deploys, rotations, replays)
  postman.json   manual test collection

openapi.yaml     frozen v1 contract, regenerated from Zod
API_PLAN.md      design decisions, dataset evidence, phase plan
```

---

## API surface (v1)

Base: `https://secop-api.<account>.workers.dev`. All paths versioned `/v1/*`. Error
envelope (`workers/api/src/schemas.ts`):

```json
{ "error": { "code": "VALIDATION_ERROR" | "NOT_FOUND" | "RATE_LIMITED" | "TOKEN_INVALID" | "TOKEN_EXPIRED" | "INTERNAL",
             "message": "...", "details": { } } }
```

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/health` | public | Liveness + downstream probes (Turso, Workers AI, ingest age, enrich age) |
| GET | `/v1/openapi.json` / `/v1/openapi.yaml` | public | Machine-readable contract |
| GET | `/v1/sectors` | public | UNSPSC segment counts over open tenders |
| GET | `/v1/facets` | public | `modalidad` / `estado` / `departamento` counts |
| POST | `/v1/search` | public | Semantic search; body `{query, unspsc_segments?, min_value?, max_value?, modalidad?, top_k?}` |
| GET | `/v1/tenders/{id}` | public | Full tender + AI summary |
| POST | `/v1/alerts` | public | Draft alert + email magic link (202) |
| GET | `/v1/alerts/verify?token=` | magic-link | Activate draft |
| GET | `/v1/alerts/unsubscribe?token=` | one-shot link | Delete alert |
| GET | `/v1/alerts?email=&token=` | `manage_email` | List alerts for an email |
| PATCH | `/v1/alerts/{id}?token=` | `manage_alert` | Edit alert |
| DELETE | `/v1/alerts/{id}?token=` | `manage_alert` | Delete alert |
| GET | `/admin/stats` | `Bearer ADMIN_TOKEN` | Quota dashboard (neurons/day, email/day, ingest/enrich freshness) |
| POST | `/admin/backfill?since=` | `Bearer ADMIN_TOKEN` (on `secop-ingest`) | Manual ingest run |
| POST | `/admin/enrich?batch_size=&max_batches=` | `Bearer ADMIN_TOKEN` (on `secop-enrich`) | Manual enrich batch |
| POST | `/admin/match` | `Bearer ADMIN_TOKEN` (on `secop-match`) | Force a digest cycle |

Token scopes (`shared/src/hmac.ts`):

| Scope | Subject | TTL | Issued by | Used by |
|---|---|---|---|---|
| `manage_alert` | alert id | 7 days | magic link in `POST /alerts` | `GET /alerts/verify`, `PATCH`/`DELETE /alerts/{id}` |
| `manage_email` | email | 7 days | (future: digest "manage all" link) | `GET /alerts?email=` |
| `unsubscribe` | alert id | 1 year | every digest email | `GET /alerts/unsubscribe` |

Rotating `HMAC_SECRET` invalidates all outstanding tokens — see RUNBOOK §P5.8.

---

## Quick start (against the live API)

```bash
BASE=https://secop-api.mescude1.workers.dev

# liveness + downstream
curl -s $BASE/v1/health | jq

# sector picker
curl -s $BASE/v1/sectors | jq '.sectors[:5]'

# semantic search
curl -sX POST $BASE/v1/search \
  -H 'content-type: application/json' \
  -d '{
    "query": "mantenimiento de equipos de cómputo",
    "unspsc_segments": ["43"],
    "min_value": 10000000,
    "top_k": 5
  }' | jq '.items[] | {id, score, nombre, precio_base}'

# subscribe (magic link emailed to you)
curl -sX POST $BASE/v1/alerts \
  -H 'content-type: application/json' \
  -d '{
    "email": "you@example.com",
    "query": "consultoría en gestión documental",
    "min_score": 0.55
  }'
```

---

## Data model

Schema in [`migrations/0001_init.sql`](./migrations/0001_init.sql) +
[`0002_ai_usage.sql`](./migrations/0002_ai_usage.sql) +
[`0003_kv.sql`](./migrations/0003_kv.sql).

- `tenders` — id, entity, location, UNSPSC + generated `unspsc_segment` (positions 4–5 of
  `V1.SS.FF.CC.PP`), modalidad, dates, `precio_base`, `summary_es` JSON, `embedding F32_BLOB(1024)`.
- `idx_tenders_vec` — `libsql_vector_idx(embedding)`. Search uses
  `vector_top_k('idx_tenders_vec', :qvec, 200) JOIN tenders ON rowid = knn.id`.
- `alerts` — email, query + `query_embedding`, optional filters, `verified`, `last_sent_at`.
- `watermark` — last `fecha_de_ultima_publicaci` seen per dataset; drives incremental ingest.
- `ai_usage` — per-day neuron counter (embed + summary counts) for the budget guard.
- `kv` — single-row-keyed settings (`alerts.disabled` emergency stop, etc.).

The Socrata "open and SME-relevant" predicate is shared between ingest and search:

```
estado_del_procedimiento = 'Publicado'
AND fecha_de_recepcion_de > '<ISO now, floating timestamp>'
```

`buildOpenTendersWhere` in `shared/src/socrata.ts` is the single source of truth.

---

## Local dev

```bash
npm install
npm run typecheck
npm run lint

# run any worker locally (uses miniflare):
cd workers/api && npx wrangler dev
curl http://127.0.0.1:8787/v1/health
```

To regenerate the committed OpenAPI yaml after editing Zod schemas:

```bash
npm run openapi:generate
npm run openapi:check    # CI gate: fails on drift
```

---

## Smoke tests

`scripts/smoke.ts` hits every endpoint and reports per-endpoint status. Safe by default
(no real alerts created, no digests sent); destructive paths are gated behind explicit
flags.

```bash
API_BASE_URL=https://secop-api.mescude1.workers.dev \
MATCH_URL=https://secop-match.mescude1.workers.dev \
ADMIN_TOKEN=...                                       \
npm run smoke
```

Flags:
- `--tender-id=<id>` — verify `GET /v1/tenders/{id}` returns 200 for a known id
- `--alerts-live --live-email=you@…` — exercise the real magic-link flow (sends email)
- `--match-live` — call `/admin/match` for real (sends digests)

Exit code is non-zero if any endpoint fails. Use this after deploy to verify a release.

---

## Deploy / operations

See [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) for the full playbook. High-level:

1. **Bootstrap** (once) — Turso DB, run migrations, wire secrets per worker
   (`TURSO_URL`, `TURSO_TOKEN`, `ADMIN_TOKEN`, plus `HMAC_SECRET` + `RESEND_API_KEY`
   on api + match, plus Linode S3 keys on ingest).
2. **Deploy** — `cd workers/<name> && npx wrangler deploy`.
3. **Trigger first ingest** — `POST /admin/backfill?since=` with empty value for a full
   open-set pull (~2.2k rows in ~8s).
4. **Trigger enrich** — `POST /admin/enrich?max_batches=20`; repeat until
   `rows_without_embedding` ≈ 0 (initial backfill takes ~3 days at the natural cadence
   under the 8k neuron/day cap, or many manual calls).
5. **Verify** — `npm run smoke` against the deployed URLs; `GET /admin/stats` for the
   quota snapshot.

Cron schedules:

| Worker | Schedule | Action |
|---|---|---|
| `secop-ingest` | `0 */6 * * *` | Socrata pull + Turso upsert |
| `secop-enrich` | `15 */6 * * *` | embed + summarize pending tenders |
| `secop-match` | `30 */6 * * *` | match verified alerts → Resend digest |
| `secop-api` | `0 23 * * *` | daily quota check + webhook |

Rotation, replay, vector-index rebuild, emergency disable-alerts, and Resend re-verify
procedures are all in RUNBOOK §P5.

---

## Quota discipline

| Quota | Limit | Where to check | Headroom mechanism |
|---|---|---|---|
| Workers AI neurons | 10k/day | `/admin/stats` → `ai.neurons_used` | enrich stops at 8k; daily webhook at ≥70 % |
| Resend sends | 100/day | `/admin/stats` → `email.sent_today` | one digest per `(email, day)`; daily webhook |
| Turso row reads | 1B/mo | Turso dashboard | `vector_top_k` capped at 200; alert scan restricted to fresh rows |
| Workers requests | 100k/day | CF dashboard → Analytics | per-IP rate limits via CF Rate Limiting Rules |
| Linode Object Storage | per plan | Linode Cloud Manager | one object per page (~1000 rows), not per row |
| Turso storage | 9 GB | Turso dashboard | open-tender scope keeps row count in low thousands |

---

## Out of scope for v1

Tracked in [`API_PLAN.md §11`](./API_PLAN.md): historical / awarded tenders, bidder
analytics, multi-tenant API keys, Spanish UI generation beyond the JSON summary, push
notifications, user accounts beyond email + magic link.

---

## License

[MIT](./LICENSE).
