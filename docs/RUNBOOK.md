# RUNBOOK

Operational playbook. Most sections are filled in during Phase P5; the bootstrap section
below is needed to satisfy the Phase P0 deliverable (Turso DB + migration applied, secrets
in place, `/health` deployed).

---

## One-time bootstrap (Phase P0)

### 1. Create the Turso database

```bash
# install once: brew install tursodatabase/tap/turso
turso auth login
turso db create secop --location <closest-region>          # e.g. iad, ord, lhr
turso db show secop                                        # note the libsql:// URL
turso db tokens create secop --expiration none > .turso-token
```

### 2. Apply the schema

```bash
turso db shell secop < migrations/0001_init.sql
turso db shell secop "SELECT name FROM sqlite_master WHERE type='table';"
# expect: tenders, alerts, watermark
```

### 3. Wire secrets per worker

For each worker directory (`workers/api`, `workers/ingest`, `workers/enrich`, `workers/match`):

```bash
cd workers/<name>
echo "<libsql URL from step 1>"        | npx wrangler secret put TURSO_URL
cat ../../.turso-token                 | npx wrangler secret put TURSO_TOKEN
# api + match only:
echo "<resend API key>"                | npx wrangler secret put RESEND_API_KEY
# api + match only (any random 32+ bytes, base64 or hex):
openssl rand -base64 48                | npx wrangler secret put HMAC_SECRET
# api + ingest + enrich (admin endpoints):
openssl rand -base64 32                | npx wrangler secret put ADMIN_TOKEN
```

The names live in [`.env.example`](../.env.example).

### 4. Deploy the api worker

```bash
cd workers/api
npx wrangler deploy
# verify:
curl https://secop-api.<your-account>.workers.dev/v1/health
```

Expected response:

```json
{ "status": "ok", "phase": "P0", "started_at": "...", "checks": { ... } }
```

The other three workers are stubs until later phases — leave them undeployed for now,
or deploy them and they'll return `501`.

---

---

## Phase P1 — Ingest worker

### 1. Create the R2 bucket (one-time)

```bash
cd workers/ingest
npx wrangler r2 bucket create secop-raw
```

### 2. Set ingest secrets

`TURSO_URL`, `TURSO_TOKEN`, `ADMIN_TOKEN` are required. `SOCRATA_APP_TOKEN` is optional
but recommended.

```bash
cd workers/ingest
cat ../../.turso-token | npx wrangler secret put TURSO_TOKEN
echo "<libsql URL>"    | npx wrangler secret put TURSO_URL
openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN
# optional:
echo "<socrata token>" | npx wrangler secret put SOCRATA_APP_TOKEN
```

### 3. Deploy and verify

```bash
cd workers/ingest
npx wrangler deploy

# Trigger a first backfill (no watermark filter):
ADMIN_TOKEN=...
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://secop-ingest.<account>.workers.dev/admin/backfill?since="

# Subsequent runs use the stored watermark (omit ?since):
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://secop-ingest.<account>.workers.dev/admin/backfill"
```

Expected response:

```json
{
  "ok": true,
  "result": {
    "runId": "...",
    "pages": 3,
    "rowsFetched": 2221,
    "rowsUpserted": 2221,
    "watermarkUsed": null,
    "newWatermark": "2026-05-19T13:42:00.000",
    "startedAt": "...",
    "completedAt": "..."
  }
}
```

### 4. Sanity checks

```bash
# R2 has gzipped batches:
npx wrangler r2 object list secop-raw --prefix "raw/dt=$(date -u +%F)"

# Turso has rows and no embeddings yet:
turso db shell secop "SELECT COUNT(*) AS n, SUM(embedding IS NULL) AS no_embed FROM tenders;"

# Watermark advanced:
turso db shell secop "SELECT * FROM watermark;"

# Idempotency: re-run should report rowsUpserted > 0 but Turso row count stays put.
# The embedding-invalidation CASE only nulls AI artifacts when fecha_ultima actually changed,
# so the enrich worker won't re-process unchanged rows.
```

### 5. Cron schedule

`crons = ["0 */6 * * *"]` is in `workers/ingest/wrangler.toml`. Cloudflare attaches it on
deploy. Verify in the dashboard or with:

```bash
cd workers/ingest
npx wrangler triggers list
```

### Replay / disaster recovery

- **Re-pull the whole open set:** `POST /admin/backfill?since=` (empty value)
- **Re-pull from a known point:** `POST /admin/backfill?since=2026-05-01T00:00:00`
- **Wipe and rebuild from R2:** drop `tenders`, re-apply `0001_init.sql`, replay the latest
  R2 objects through the normalizer (script TBD in P5).

---

## Phase P2 — Enrich worker

### 1. Apply migration 0002

```bash
turso db shell secop < migrations/0002_ai_usage.sql
turso db shell secop "SELECT name FROM sqlite_master WHERE type='table' AND name='ai_usage';"
```

### 2. Set enrich secrets

```bash
cd workers/enrich
echo "<libsql URL>"     | npx wrangler secret put TURSO_URL
cat ../../.turso-token  | npx wrangler secret put TURSO_TOKEN
openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN
```

The `AI` binding is wired in `wrangler.toml`; no secret needed (your Cloudflare account
provides it automatically once the worker is deployed).

### 3. Deploy and run

```bash
cd workers/enrich
npx wrangler deploy

# Process one cron-cycle's worth of rows synchronously in the background.
ADMIN_TOKEN=...
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://secop-enrich.<account>.workers.dev/admin/enrich"

# Tail logs to see batch counts, neuron usage, stopped_reason.
npx wrangler tail --format pretty
```

### 4. Sanity checks

```bash
# How many tenders are still missing embeddings?
turso db shell secop \
  "SELECT SUM(embedding IS NULL) AS pending, SUM(embedding IS NOT NULL) AS done FROM tenders;"

# How many summaries failed (embedding set but summary_es null)?
turso db shell secop \
  "SELECT COUNT(*) FROM tenders WHERE embedding IS NOT NULL AND summary_es IS NULL;"

# Today's neuron usage:
turso db shell secop \
  "SELECT * FROM ai_usage WHERE day = strftime('%Y-%m-%d', 'now');"

# Spot-check a summary JSON:
turso db shell secop \
  "SELECT id, summary_es FROM tenders WHERE summary_es IS NOT NULL LIMIT 1;"
```

### 5. Backfilling the initial open set

The open set is ~2.2k rows. With the 8k-neurons/day cap and ~11 neurons/row, the worker
processes up to ~720 rows/day. Initial backfill therefore takes ~3 days at the natural
6h cadence. To go faster, hit the admin endpoint multiple times — it re-reads the budget
every batch and exits early when exhausted.

```bash
# Run the next batch (defaults: batch_size=50, max_batches=10):
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://secop-enrich.<account>.workers.dev/admin/enrich?max_batches=20"
```

### Tuning

If real neuron usage diverges from the conservative estimates in
`shared/src/ai.ts` (`NEURONS_PER_EMBED_CALL`, `NEURONS_PER_SUMMARY_CALL`), update those
constants and redeploy. The CF Workers AI dashboard shows actual daily neuron consumption.

---

## Phase P3 — Public read API

### 1. Wire api worker secrets and deploy

```bash
cd workers/api
echo "<libsql URL>"     | npx wrangler secret put TURSO_URL
cat ../../.turso-token  | npx wrangler secret put TURSO_TOKEN
npx wrangler deploy
```

`ALLOWED_ORIGINS` is a `[vars]` entry in `workers/api/wrangler.toml` — edit and redeploy
to change it. Default: `http://localhost:3000,*.vercel.app`. The `*.vercel.app` token
matches any subdomain of vercel.app for preview deploys; everything else must be a literal
origin.

The `AI` binding is wired automatically by the Cloudflare account on deploy — no secret.

### 2. Smoke checks

```bash
BASE=https://secop-api.<account>.workers.dev
curl -s $BASE/v1/health | jq
curl -s $BASE/v1/sectors | jq '.sectors | length'
curl -s $BASE/v1/facets  | jq '{ modalidad: .modalidad | length, estado: .estado | length }'
curl -s $BASE/v1/openapi.yaml | head -20

# Semantic search:
curl -s -X POST $BASE/v1/search \
  -H 'content-type: application/json' \
  -d '{"query":"mantenimiento de equipos de cómputo","unspsc_segments":["43"],"top_k":5}' \
  | jq '.items[] | { id, score, nombre }'

# Single tender:
curl -s $BASE/v1/tenders/<id-from-search> | jq
```

### 3. Cloudflare rate limiting (manual, dashboard)

Plan §5 / §9 P3 calls for `60 req/min/IP` on `/search` and `600 req/min/IP` elsewhere.
This is configured at the Cloudflare zone / Workers dashboard, not in code:

1. Cloudflare dashboard → Workers & Pages → `secop-api` → Settings → Rate Limiting Rules.
2. Add rule: match `request.uri.path eq "/v1/search"`, limit 60/min, action: block.
3. Add rule: match `request.uri.path matches "^/v1/"` (everything else), limit 600/min.

The `RATE_LIMITED` envelope code is reserved in `schemas.ts` for when the dashboard rule
later fronts these endpoints. Until then, the binding-based fallback can be added if
needed.

### 4. Hand off to frontend

Send the Vercel engineer:

- **Base URL:** `https://secop-api.<account>.workers.dev`
- **OpenAPI:** `GET /v1/openapi.yaml` (live) or the committed copy at `openapi.yaml`
- **Postman:** `docs/postman.json`
- **CORS:** ensure their production + preview origins are in `ALLOWED_ORIGINS`.

### 5. Regenerating openapi.yaml

`openapi.yaml` is generated from the Zod schemas in `workers/api/src/schemas.ts`. CI runs
`npm run openapi:check` and fails on drift. After changing a schema:

```bash
npm run openapi:generate    # rewrites openapi.yaml
git add openapi.yaml
```

---

## Phase P4 — Alerts (end-to-end)

### 1. Resend domain (start early — DNS propagation)

1. Resend dashboard → Domains → Add domain.
2. Add the SPF / DKIM / DMARC records Resend lists at your DNS provider.
3. Wait for "Verified". This can take minutes to hours.
4. Pick a from-address on that domain (e.g. `alertas@yourdomain.co`).

### 2. Update `[vars]` in both api + match wranglers

Edit `workers/api/wrangler.toml` and `workers/match/wrangler.toml`:

```toml
API_BASE_URL     = "https://secop-api.<your-account>.workers.dev"
ALERT_EMAIL_FROM = "SECOP Alertas <alertas@yourdomain.co>"
```

These MUST match between api and match — unsubscribe links go to `API_BASE_URL` and the
match worker's tokens are validated by the api worker using the same `HMAC_SECRET`.

### 3. Set secrets on api + match

```bash
# api worker:
cd workers/api
echo "<libsql URL>"      | npx wrangler secret put TURSO_URL
cat ../../.turso-token   | npx wrangler secret put TURSO_TOKEN
openssl rand -base64 48  | npx wrangler secret put HMAC_SECRET     # save this output!
echo "<resend api key>"  | npx wrangler secret put RESEND_API_KEY
npx wrangler deploy

# match worker (HMAC_SECRET MUST be the same value):
cd ../match
echo "<libsql URL>"      | npx wrangler secret put TURSO_URL
cat ../../.turso-token   | npx wrangler secret put TURSO_TOKEN
echo "<resend api key>"  | npx wrangler secret put RESEND_API_KEY
echo "<same HMAC_SECRET as api>" | npx wrangler secret put HMAC_SECRET
openssl rand -base64 32  | npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

### 4. End-to-end test

```bash
API=https://secop-api.<account>.workers.dev
MATCH_URL=https://secop-match.<account>.workers.dev
ADMIN_TOKEN=...  # match worker's admin token

# Create a draft + send magic link:
curl -s -X POST $API/v1/alerts \
  -H 'content-type: application/json' \
  -d '{
    "email": "you@example.com",
    "query": "mantenimiento de equipos de cómputo",
    "unspsc_segments": ["43"],
    "min_value": 10000000,
    "max_value": 200000000,
    "min_score": 0.5
  }'
# → 202 { ok: true, message: "magic link sent" }
# Check your inbox; click the magic link, which calls GET /v1/alerts/verify?token=...

# Inspect the alert in Turso:
turso db shell secop "SELECT id, email, verified, last_sent_at FROM alerts;"

# Force a match cycle now (don't wait for the next 30 */6 cron):
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $MATCH_URL/admin/match
# Tail logs to see counts:
cd workers/match && npx wrangler tail --format pretty
# Check your inbox for the digest; click an unsubscribe link.
```

### 5. Per-email per-day dedup

The match worker sends at most one digest per email per UTC day. The guard checks
`max(alert.last_sent_at)` across all alerts for that email. If any one shows today's
date, the entire email is skipped. After a send, `last_sent_at` is updated on **every**
alert for that email (whether it contributed hits or not) so the day-flag is sticky.

To force a re-send on the same day during testing, manually clear `last_sent_at`:

```bash
turso db shell secop "UPDATE alerts SET last_sent_at = NULL WHERE email = 'you@example.com';"
```

### 6. Token scopes

| Scope | Subject | TTL | Issued by | Validates against |
|---|---|---|---|---|
| `manage_alert` | alert id | 7d | POST /alerts (magic link) | GET /alerts/verify, PATCH/DELETE /alerts/{id} |
| `manage_email` | email | 7d | (future digest "manage all" link) | GET /alerts |
| `unsubscribe` | alert id | 1y | every digest send | GET /alerts/unsubscribe |

Rotating `HMAC_SECRET` invalidates ALL outstanding tokens (verify magic links, unsub
links in already-sent emails). Plan migration windows accordingly.

### 7. Resend free-tier ceiling

100 emails/day, 3k/mo. The match worker sends at most one email per (email, day) so a
user base of < 100 verified emails is safely within the daily cap. The plan tracks this
in §10; the P5 quota dashboard will surface usage proactively.

---

## Phase P5 — Observability + ops

### 1. Apply migration 0003

```bash
turso db shell secop < migrations/0003_kv.sql
```

### 2. Wire api worker observability secrets

```bash
cd workers/api
openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN
# Optional but recommended — Slack incoming webhook or Discord webhook URL.
# Leave unset to disable proactive quota alerts (the /admin/stats endpoint still works).
echo "<webhook url>" | npx wrangler secret put QUOTA_WEBHOOK_URL
npx wrangler deploy
```

### 3. Observability tile per worker

Cloudflare dashboard → Workers & Pages → each worker → Analytics tab. Defaults are
useful out of the box (requests, errors, p50/p95 CPU). Pin each worker to the
dashboard home for a one-glance overview.

For more granular logs:

```bash
cd workers/<name>
npx wrangler tail --format pretty
```

### 4. Stats endpoint

```bash
API=https://secop-api.<account>.workers.dev
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" $API/admin/stats | jq
```

Returns daily neuron usage (vs the 8k hard stop), ingest freshness, enrich progress,
verified-alerts count, and today's digest sends (vs the 100/day Resend cap).

### 5. Daily quota webhook

The api worker has `crons = ["0 23 * * *"]`. Each night at 23:00 UTC it reads the same
snapshot as `/admin/stats` and posts to `QUOTA_WEBHOOK_URL` if any metric is ≥ 70%.
The webhook body is sent as both Slack-style `{ text }` and Discord-style `{ content }`
so the same URL works with either.

To force a webhook test:

```bash
# Trigger the scheduled handler manually:
cd workers/api
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled"
```

### 6. Extended /health

`GET /v1/health` now performs live probes:

- **Turso:** `SELECT 1` (no cache).
- **Workers AI:** one bge-m3 embed of the literal "probe" (cached 30 min via the
  Cache API, so cost is ~48 neurons/day).
- **last_ingest_age_s:** `now - watermark.last_run_at` for dataset `p6dx-8zbt`.
- **last_enrich_age_s:** `now - max(ai_usage.updated_at)`.

`status: "ok"` only if both probes pass; otherwise `"degraded"`.

### 7. Emergency disable-alerts flag

Stop the match worker from sending any digests:

```bash
turso db shell secop \
  "INSERT INTO kv (key, value, updated_at) VALUES ('alerts.disabled', '1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at;"
```

Re-enable:

```bash
turso db shell secop \
  "UPDATE kv SET value = '0', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = 'alerts.disabled';"
```

When set, the match worker logs `match:disabled-by-kv-flag` and returns
`{ disabledByFlag: true, ... }` from its run result.

### 8. Rotate secrets

#### Turso token

```bash
turso db tokens create secop --expiration none > .turso-token.new
# Re-deploy each worker with the new token, in order:
for w in workers/api workers/ingest workers/enrich workers/match; do
  (cd $w && cat ../../.turso-token.new | npx wrangler secret put TURSO_TOKEN && npx wrangler deploy)
done
turso db tokens invalidate secop --token "<old-token-from-.turso-token>"
mv .turso-token.new .turso-token
```

#### Resend API key

```bash
# Generate a new key in Resend dashboard, then:
echo "<new key>" | (cd workers/api  && npx wrangler secret put RESEND_API_KEY && npx wrangler deploy)
echo "<new key>" | (cd workers/match && npx wrangler secret put RESEND_API_KEY && npx wrangler deploy)
# Revoke the old key in the Resend dashboard.
```

#### HMAC_SECRET

Rotating HMAC_SECRET invalidates ALL outstanding magic links and unsubscribe links in
already-delivered emails. Coordinate carefully.

```bash
NEW=$(openssl rand -base64 48)
echo "$NEW" | (cd workers/api   && npx wrangler secret put HMAC_SECRET && npx wrangler deploy)
echo "$NEW" | (cd workers/match && npx wrangler secret put HMAC_SECRET && npx wrangler deploy)
```

### 9. Replay backfill

#### From cleared watermark

```bash
turso db shell secop "UPDATE watermark SET last_fecha_ultima = NULL WHERE dataset = 'p6dx-8zbt';"
INGEST_URL=https://secop-ingest.<account>.workers.dev
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$INGEST_URL/admin/backfill?since="
```

#### From dropped tenders table

```bash
# Disable alerts during the rebuild so users don't get a flood of "new" notifications.
turso db shell secop "INSERT INTO kv VALUES ('alerts.disabled','1',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                      ON CONFLICT(key) DO UPDATE SET value='1';"
turso db shell secop "DROP TABLE tenders;"
turso db shell secop < migrations/0001_init.sql       # recreates with indexes
turso db shell secop "UPDATE watermark SET last_fecha_ultima = NULL WHERE dataset = 'p6dx-8zbt';"
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$INGEST_URL/admin/backfill?since="
# After enrich catches up:
turso db shell secop "UPDATE kv SET value='0' WHERE key='alerts.disabled';"
```

### 10. Drop & rebuild vector index

If the libsql vector index becomes corrupted or the embedding dimension changes:

```bash
turso db shell secop "DROP INDEX IF EXISTS idx_tenders_vec;"
turso db shell secop "CREATE INDEX idx_tenders_vec ON tenders(libsql_vector_idx(embedding));"
# Index population is automatic; verify by running a sample /v1/search query.
```

If you actually need to change the embedding dimension, run:

```bash
turso db shell secop "UPDATE tenders SET embedding = NULL, summary_es = NULL, embedded_at = NULL;"
# Then update EMBED_DIM in shared/src/ai.ts + the F32_BLOB() column type in
# migrations/0001_init.sql, drop-and-recreate the column (no SQLite ALTER for type), and
# let the enrich worker re-populate.
```

### 11. Resend DNS re-verify

If you change DNS providers, rotate the domain, or the SPF/DKIM record drifts:

1. Resend dashboard → Domains → your domain → re-add the missing records.
2. Wait for "Verified" again.
3. No worker action needed — the `ALERT_EMAIL_FROM` var stays the same. If the from-
   domain actually changes, edit `ALERT_EMAIL_FROM` in both wranglers and redeploy.

### 12. Quotas to watch (and where)

| Quota | Where to check | Surfaced in |
|---|---|---|
| Workers AI neurons | `/admin/stats` → `ai.neurons_used` | Daily webhook at 70%+ |
| Resend sends/day | `/admin/stats` → `email.sent_today` | Daily webhook at 70%+ |
| Turso storage / row reads | Turso dashboard → DB → Usage | Manual |
| R2 storage / Class A ops | Cloudflare dashboard → R2 → secop-raw → Metrics | Manual |
| Workers requests | Cloudflare dashboard → Workers → secop-api → Analytics | Manual |

- Rotate Resend / Turso / HMAC secrets
- Replay backfill (cleared watermark, dropped table, etc.)
- Drop & rebuild vector index
- Resend domain re-verify if DNS changes
- Emergency disable-alerts flag (Turso `kv` row read at start of match worker)
- Quota dashboard (`/admin/stats`) + daily cron alerting via Slack/Discord webhook
