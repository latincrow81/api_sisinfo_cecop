# SECOP Semantic Search API

Semantic search + email-alert API over SECOP II active tenders
(Socrata dataset `p6dx-8zbt`).

The full execution plan lives in [`API_PLAN.md`](./API_PLAN.md). This README is intentionally
short — it covers only what's needed to navigate the repo and run the current phase.

## Status

Phase **P0** — scaffold. Only `/v1/health` is wired.

## Layout

```
shared/                  Zod schemas, Socrata client, Turso client, AI helpers, HMAC util
workers/api/             HTTP API (this is what /health lives in)
workers/ingest/          Cron-driven Socrata pull (Phase P1)
workers/enrich/          Workers AI embed + summarize (Phase P2)
workers/match/           Alert match + Resend digest (Phase P4)
migrations/0001_init.sql Turso schema (run once on the DB)
openapi.yaml             Frozen v1 contract (regenerated in Phase P3)
docs/postman.json        Manual testing collection
docs/RUNBOOK.md          Ops playbook (filled in Phase P5)
```

## Local dev

```bash
npm install
npm run typecheck
npm run lint
cd workers/api && npx wrangler dev
curl http://127.0.0.1:8787/v1/health
```

## Deploy

See [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) for the one-time Turso + secrets bootstrap.
