# SECOP Semantic Search API — UI Builder's Guide

A complete reference for building a web UI on top of this API. Every public endpoint, every request/response field, every token flow, and the gotchas you'll hit.

The API is also self-describing: `GET /v1/openapi.yaml` (or `/v1/openapi.json`) returns a live OpenAPI 3.1 contract you can feed to a codegen tool. This document is meant to be read by a human (or an agent building one) — it covers UX-level details OpenAPI doesn't.

---

## 1. Quick orientation

- **What it does:** semantic (vector) search over Colombia's SECOP II "active" tenders, plus an email-alert subscription system. The Spanish-language source data is summarized by an LLM and embedded for similarity search.
- **Base URL:** `https://secop-api.<your-cloudflare-account>.workers.dev`. There's no custom domain yet; the workers.dev URL is the production endpoint.
- **Wire format:** JSON for everything. Send `content-type: application/json` on every body-bearing request.
- **Authentication:** there is **no API key for end users**. Two endpoint families exist:
  - **Public endpoints** (health, catalog, search, tender detail, alert creation) — no auth, gated only by CORS + rate limits.
  - **Alert management** (`GET /v1/alerts`, `PATCH/DELETE /v1/alerts/{id}`, `GET /v1/alerts/verify`, `GET /v1/alerts/unsubscribe`) — gated by **HMAC tokens delivered by email** ("magic links"). The UI never holds a long-lived secret; it parses tokens from URLs the user clicks.
- **Admin endpoints** (`/admin/*`) are out of scope for a public UI — they require a bearer `ADMIN_TOKEN` and exist for ops. Do not surface them.
- **Language:** field names and copy are Spanish (the source data is Spanish). Keep UI labels in Spanish to match.

---

## 2. Conventions

### 2.1 Error envelope

Every error response has the same shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "request failed schema validation",
    "details": { "issues": [/* zod-shaped validation issues */] }
  }
}
```

`details` is optional and free-form. `code` is one of:

| Code | HTTP | When it happens | What the UI should do |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query/params failed schema validation. `details.issues` is a Zod issues array — each item has `path`, `message`, `code`. | Map each `issues[].path` back to a form field and show its `message` inline. |
| `NOT_FOUND` | 404 | Tender or alert not found, or no route matched. | Show "no encontrado" state. For a search result that 404s on detail click, treat it as stale and refresh the list. |
| `TOKEN_INVALID` | 401 | HMAC token missing / malformed / scope mismatch / subject mismatch. | Tell the user the link is invalid and offer to send a new magic link. |
| `TOKEN_EXPIRED` | 401 | HMAC token's `exp` has passed. | Same as above, but with copy "este enlace expiró". |
| `RATE_LIMITED` | 429 | Cloudflare zone-level rate limit hit (configured in the CF dashboard, not in code). May not be active yet — reserved code. | Show a "intenta de nuevo en un momento" toast, exponential-backoff retry. |
| `INTERNAL` | 500 | Anything unhandled. The worker logs the stack server-side. | Show a generic error, retry once after ~1s, then give up. |

Always check `response.ok`; never trust HTTP status alone — the body is the source of truth.

### 2.2 CORS

`ALLOWED_ORIGINS` (a `[vars]` setting on the worker) is a comma-separated list. The default is `http://localhost:3000,*.vercel.app` — meaning local Next dev and any Vercel preview origin work out of the box. To add a production custom domain, the operator edits `workers/api/wrangler.toml` and redeploys.

Allowed methods: `GET, POST, PATCH, DELETE, OPTIONS`. Allowed headers: `content-type, authorization`. Credentials are not used — don't send cookies, the API doesn't read them.

### 2.3 Rate limits

Plan §5 / §9 calls for `60 req/min/IP` on `/v1/search` and `600 req/min/IP` everywhere else. Enforcement is via Cloudflare dashboard rate-limit rules, so it may or may not be enabled in a given deploy. Code your client to handle `RATE_LIMITED` gracefully but don't assume it's always active.

### 2.4 Date and money types

- All timestamps are **ISO 8601 strings** in UTC (`2026-05-19T13:42:00.000Z` or `2026-05-19T13:42:00.000` — Socrata sometimes omits the Z). Parse with `new Date(s)`.
- All monetary values (`precio_base`, `min_value`, `max_value`) are **numbers in COP** (Colombian pesos, no decimals in practice). Display with `Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 })`.
- `unspsc` is a 6-or-8-digit code; `unspsc_segment` is its first 2 digits (the high-level category). Use `unspsc_segment` for sector filters, `unspsc` for display only.

### 2.5 Nullability

Almost every business field on `Tender` is nullable (`entidad`, `objeto`, `precio_base`, etc.) because the upstream SECOP II dataset is patchy. Always guard in the UI — never assume `tender.precio_base` is a number.

`summary` is `null` until the enrich worker has processed the tender. New rows show up unsummarized; expect a non-trivial fraction of search results to have `summary === null`. Render a "Resumen no disponible aún" fallback.

---

## 3. Endpoints

### 3.1 Meta

#### `GET /v1/health`

Liveness probe. Returns 200 always; `status: "ok"` only if downstream probes pass.

```json
{
  "status": "ok",                    // "ok" | "degraded"
  "phase": "P5",
  "started_at": "2026-05-19T12:00:00.000Z",
  "checks": {
    "turso":      { "status": "ok", "latency_ms": 12, "checked_at": "...", "detail": "..." },
    "workers_ai": { "status": "ok", "latency_ms": 48, "checked_at": "...", "detail": "..." },
    "last_ingest_age_s": 4321,
    "last_enrich_age_s": 1280
  }
}
```

`Probe.status` is `"ok" | "fail" | "timeout"`. `last_ingest_age_s` is the seconds since the last successful ingest run; the dataset refreshes every 6h, so > 14400 (≈4h) is normal, > 28800 (≈8h) is suspicious. Use this for a footer "data freshness" indicator.

#### `GET /v1/openapi.yaml` and `GET /v1/openapi.json`

Live machine-readable contract. Both serve the same OpenAPI 3.1 document — only the encoding differs.

### 3.2 Catalog

These power filter UI (sector picker, modality dropdown, etc.). They reflect the **current open set** — tenders with `estado = 'Publicado'` and `fecha_recepcion > now()`.

#### `GET /v1/sectors`

UNSPSC top-level segments and how many open tenders sit in each.

```json
{
  "sectors": [
    { "segment": "43", "tender_count": 412 },
    { "segment": "72", "tender_count": 318 },
    ...
  ]
}
```

Sorted by `tender_count DESC`. Use for a homepage sector grid or a `<select>` of segments with counts beside each label.

The `segment` strings are the 2-digit codes only; map them to human names client-side using the standard UNSPSC segment table (e.g. `43 → Hardware y servicios de tecnologías de información`). The API does **not** ship those names.

#### `GET /v1/facets`

Counts grouped by three dimensions, over the same open set.

```json
{
  "modalidad":    [{ "value": "Licitación Pública", "count": 120 }, ...],
  "estado":       [{ "value": "Publicado", "count": 2200 }, ...],
  "departamento": [{ "value": "Bogotá D.C.", "count": 540 }, ...]
}
```

Use to populate dropdowns / checkbox lists in the search filter sidebar. Each list is already sorted by count descending. Estado will essentially always be `"Publicado"` (it's the filter we use), so the `estado` array is mostly for completeness.

### 3.3 Search

#### `POST /v1/search`

Semantic search. Embeds the query, kNN-searches over tender embeddings, then post-filters and ranks.

**Request:**

```json
{
  "query": "mantenimiento de equipos de cómputo",  // required, 1–2000 chars
  "unspsc_segments": ["43", "72"],                  // optional, max 20 items, each /^\d{2}$/
  "min_value": 10000000,                            // optional, ≥0, COP
  "max_value": 200000000,                           // optional, ≥0, COP
  "modalidad": "Licitación Pública",                // optional, exact match
  "top_k": 20,                                      // optional, 1..100, default 20
  "cursor": "..."                                   // accepted but ignored — v1 has no pagination
}
```

All filters are AND'd. `top_k` controls page size; there's no second page in v1 (`next_cursor` always returns `null`). If the user needs more results, raise `top_k`.

**Response:**

```json
{
  "items": [
    {
      "id": "CO1.BDOS.123456",
      "score": 0.18,                  // cosine *distance* — LOWER IS MORE RELEVANT
      "entidad": "Alcaldía de ...",
      "nit_entidad": "...",
      "departamento": "Antioquia",
      "ciudad": "Medellín",
      "objeto": "Mantenimiento preventivo y correctivo...",
      "nombre": "MP-2025-001",
      "unspsc": "43211500",
      "unspsc_segment": "43",
      "modalidad": "Licitación Pública",
      "tipo_contrato": "Prestación de servicios",
      "subtipo_contrato": null,
      "precio_base": 45000000,
      "estado": "Publicado",
      "fase": "Presentación de ofertas",
      "fecha_publicacion": "2026-05-10T...",
      "fecha_ultima": "2026-05-18T...",
      "fecha_recepcion": "2026-06-01T...",
      "url": "https://community.secop.gov.co/...",
      "summary": {                          // may be null for new/unenriched tenders
        "resumen": "...",                   // 2–4 sentence Spanish summary
        "requisitos_clave": ["...", "..."], // bullet-style key requirements
        "perfil_proveedor": "..."           // who should bid
      }
    }
  ],
  "next_cursor": null
}
```

**Important: `score` is a cosine distance, not a similarity.** `0.0` means identical, `1.0` means orthogonal. The match worker treats `1 - score` as similarity when comparing against `min_score` thresholds; do the same in the UI if you want to show "85% match" — display `(1 - score) * 100` rounded.

#### `GET /v1/tenders/{id}`

Full tender by id. Returns the same `Tender` shape as a `SearchHit` minus the `score` field. 404 with `NOT_FOUND` if missing.

The `id` is the SECOP II tender id, e.g. `CO1.BDOS.123456`. Use the value from `items[].id` in a search response — never construct one client-side.

### 3.4 Alerts

The alert system is **email-verified** with **HMAC magic-link tokens** — there's no password, no session. Token scopes:

| Scope | Subject | TTL | Issued by | Validates on |
|---|---|---|---|---|
| `manage_alert` | alert id | 7d | `POST /v1/alerts` (magic-link email) | `GET /v1/alerts/verify`, `PATCH /v1/alerts/{id}`, `DELETE /v1/alerts/{id}` |
| `manage_email` | email address | 7d | (server-side helper, used by future "manage all my alerts" emails) | `GET /v1/alerts` |
| `unsubscribe` | alert id | 1y | each digest email | `GET /v1/alerts/unsubscribe` |

A token mismatch on subject ("token doesn't match this alert id") returns `TOKEN_INVALID` (401). A token whose `exp` has passed returns `TOKEN_EXPIRED` (401).

---

#### `POST /v1/alerts` — create draft + send magic link

**Request:**

```json
{
  "email": "user@example.com",                            // required, RFC-valid
  "query": "mantenimiento de equipos de cómputo",         // required, 1–2000 chars
  "unspsc_segments": ["43"],                              // optional
  "min_value": 10000000,                                  // optional, COP
  "max_value": 200000000,                                 // optional, COP
  "modalidad": "Licitación Pública",                      // optional
  "departamento": "Antioquia",                            // optional
  "min_score": 0.55                                       // optional, 0..1, default 0.55
}
```

`min_score` is the similarity floor (so a hit needs `1 - distance ≥ min_score`). 0.55 is conservative; surface it as a slider labeled "Sensibilidad" or "Umbral de coincidencia" with values like `0.40 = más resultados`, `0.70 = solo muy similares`.

**Response (202 Accepted):**

```json
{ "ok": true, "message": "magic link sent" }
```

The alert exists in the DB as **unverified**. The user has to click the link in their email within 7 days. If email delivery fails (Resend down, bounce), the draft is rolled back and the request returns `INTERNAL`.

**UI flow:** show a "revisa tu email" screen after a 202. Don't try to "log the user in" or save anything client-side — there's no session.

---

#### `GET /v1/alerts/verify?token=...`

The destination of the magic link. The frontend should mount a route at e.g. `/alertas/verificar` that reads `?token=` from the URL, calls this endpoint, and renders the result.

**Response (200):**

```json
{
  "ok": true,
  "alert": { /* full Alert object, verified: true */ }
}
```

After verifying, the server has flipped `verified = 1`. The same token (scope `manage_alert`) remains valid for 7 days and can be re-used to PATCH/DELETE this alert. **Stash the token in localStorage keyed by alert id** so the user can manage it without another email round-trip:

```js
localStorage.setItem(`alert-token:${alert.id}`, tokenFromUrl);
```

Errors: 401 (`TOKEN_INVALID` / `TOKEN_EXPIRED`), 404 (`NOT_FOUND` — alert was deleted before verification).

---

#### `GET /v1/alerts/unsubscribe?token=...`

The destination of the unsubscribe link in every digest email. Deletes the alert.

**Response (200):**

```json
{ "ok": true }
```

The token (scope `unsubscribe`, 1-year TTL) is single-use in practice — after deletion the alert id no longer exists, so re-clicking the link returns 401/404. UI: render a "te desuscribimos" confirmation and an "agregar otra alerta" CTA.

---

#### `GET /v1/alerts?email=...&token=...`

List every alert tied to a verified email. Requires a `manage_email`-scoped token (not the `manage_alert` one from the magic link). v1 doesn't expose an endpoint that mints `manage_email` tokens to clients — they currently come from future "manage all my alerts" emails the match worker will send. Treat this endpoint as **mostly for the digest-email "ver todas mis alertas" link**, not for an in-app dashboard.

**Response:**

```json
{ "alerts": [/* Alert[] */] }
```

If you do build an in-app dashboard, the practical pattern is: keep one alert's `manage_alert` token in localStorage and manage that single alert. Multi-alert management currently requires email round-trips.

---

#### `PATCH /v1/alerts/{id}?token=...`

Edit an alert. Token must be `manage_alert` and its `sub` must equal `{id}`.

**Request:** any subset of:

```json
{
  "query": "...",            // 1–2000 chars; triggers a re-embed
  "unspsc_segments": [...],
  "min_value": 0,
  "max_value": 0,
  "modalidad": "...",
  "departamento": "...",
  "min_score": 0.55
}
```

Send `[]` for `unspsc_segments` to clear the filter; the server stores `null`. Omitted fields stay unchanged. Changing `query` re-embeds it via Workers AI — slightly slower (~100–300ms).

**Response (200):** the full updated `Alert`.

---

#### `DELETE /v1/alerts/{id}?token=...`

Delete an alert. Same token rules as PATCH.

**Response (200):** `{ "ok": true }`.

---

## 4. Data model (TypeScript)

For codegen, prefer `GET /v1/openapi.yaml`. Hand-rolled equivalents:

```ts
type Probe = {
  status: 'ok' | 'fail' | 'timeout';
  latency_ms: number | null;
  checked_at: string;
  detail?: string;
};

type HealthResponse = {
  status: 'ok' | 'degraded';
  phase: string;
  started_at: string;
  checks: {
    turso: Probe;
    workers_ai: Probe;
    last_ingest_age_s: number | null;
    last_enrich_age_s: number | null;
  };
};

type Summary = {
  resumen: string;
  requisitos_clave: string[];
  perfil_proveedor: string;
};

type Tender = {
  id: string;
  entidad: string | null;
  nit_entidad: string | null;
  departamento: string | null;
  ciudad: string | null;
  objeto: string | null;
  nombre: string | null;
  unspsc: string | null;
  unspsc_segment: string | null;
  modalidad: string | null;
  tipo_contrato: string | null;
  subtipo_contrato: string | null;
  precio_base: number | null;
  estado: string | null;
  fase: string | null;
  fecha_publicacion: string | null;
  fecha_ultima: string | null;
  fecha_recepcion: string | null;
  url: string | null;
  summary: Summary | null;
};

type SearchHit = Tender & { score: number };

type SearchRequest = {
  query: string;
  unspsc_segments?: string[];   // each /^\d{2}$/, max 20
  min_value?: number;           // ≥0
  max_value?: number;           // ≥0
  modalidad?: string;
  top_k?: number;               // 1..100, default 20
  cursor?: string;              // accepted but ignored
};

type SearchResponse = {
  items: SearchHit[];
  next_cursor: string | null;   // always null in v1
};

type Alert = {
  id: string;
  email: string;
  query: string;
  unspsc_segments: string[] | null;
  min_value: number | null;
  max_value: number | null;
  modalidad: string | null;
  departamento: string | null;
  min_score: number;
  verified: boolean;
  last_sent_at: string | null;
  created_at: string;
};

type AlertCreateRequest = {
  email: string;
  query: string;
  unspsc_segments?: string[];
  min_value?: number;
  max_value?: number;
  modalidad?: string;
  departamento?: string;
  min_score?: number;           // 0..1
};

type ErrorEnvelope = {
  error: {
    code:
      | 'VALIDATION_ERROR'
      | 'NOT_FOUND'
      | 'RATE_LIMITED'
      | 'TOKEN_INVALID'
      | 'TOKEN_EXPIRED'
      | 'INTERNAL';
    message: string;
    details?: Record<string, unknown>;
  };
};
```

---

## 5. Suggested UI surfaces

A working v1 frontend probably needs four screens. Sketched as the minimum viable surface:

### 5.1 Search

- **Search bar** (large, single text input) — submits `POST /v1/search` with `{ query }`.
- **Filter sidebar:** sector multiselect (`/v1/sectors` for options), modality dropdown (`/v1/facets` for options), value range (two number inputs, COP). Re-submits on change with debounce ≥ 300ms.
- **Result list:** card per `SearchHit`. Show `entidad`, `objeto` (truncate to 200 chars), `precio_base` formatted, `departamento`/`ciudad`, `modalidad`, `fecha_recepcion` as relative ("vence en 12 días"). Display `(1 - score) * 100`%-formatted as a match-strength badge.
- **Per-card actions:** "Ver detalle" → tender detail page; "Crear alerta con esta búsqueda" → opens an alert-create modal pre-filled with the current query/filters.
- **Empty state:** when zero items, suggest broadening filters and link to `/v1/sectors`-driven sector picker.
- **Data freshness footer:** small text using `/v1/health` → `checks.last_ingest_age_s`, formatted as "datos actualizados hace 2 h".

### 5.2 Tender detail

- `GET /v1/tenders/{id}` — show every non-null field, prominent `precio_base`, `fecha_recepcion` countdown, and the full `summary` block (if present) at the top.
- "Abrir en SECOP" → `tender.url` in a new tab.
- "Crear alerta" CTA → pre-fill with the tender's `unspsc_segment` and `modalidad`.

### 5.3 Create alert

- Modal or page. Fields: email, query (default to last search), sector multiselect, modality dropdown, departamento dropdown, value range, `min_score` slider (default 0.55).
- On submit: `POST /v1/alerts`. On 202, replace UI with "revisa tu inbox — el enlace expira en 24 horas". Don't pretend a session exists.
- On 400 (`VALIDATION_ERROR`), map `details.issues[].path` to inline field errors. Most likely cause: malformed email or `min_value > max_value`.

### 5.4 Verify alert (deep link)

- Route: `/alertas/verificar?token=...` (or whatever your router uses). Read the `token` query param, call `GET /v1/alerts/verify?token=...`.
- On 200: persist the token to `localStorage` keyed by `alert.id`, then redirect to a per-alert management page that shows the alert and offers Edit/Delete (both call PATCH/DELETE with the stashed token).
- On 401: "este enlace ya no es válido — ¿quieres pedirlo de nuevo?" with a button that re-opens the create-alert form pre-filled from the URL's query params.
- On 404: "no encontramos esta alerta — quizá ya fue eliminada".

### 5.5 Unsubscribe (deep link)

- Route: `/alertas/desuscribir?token=...`. Call `GET /v1/alerts/unsubscribe?token=...`, show "te desuscribimos" on 200, "el enlace ya no es válido" on 401/404.

---

## 6. Things that will trip you up

- **Score is distance, not similarity.** A `score` of `0.18` is a *good* match. If you sort by score you want ascending. The server already orders results that way; just don't re-sort by score descending.
- **`summary === null` is common**, not an error. New tenders show up before the enrich worker reaches them (up to ~6h).
- **`next_cursor` is always `null`.** v1 has no pagination; the only way to get more results is to raise `top_k` (max 100).
- **Magic links live 7 days, not forever.** If the user opens an old email, the verify endpoint returns `TOKEN_EXPIRED`. Offer to re-send.
- **There is no "log in" concept.** You cannot list all of a user's alerts without a `manage_email` token, and the only current source of those is server-issued emails. If you need a multi-alert dashboard, store the per-alert `manage_alert` tokens in `localStorage` as users verify.
- **Money is COP without decimals.** Use `Intl.NumberFormat('es-CO', ...)` and don't divide by 100.
- **All copy is Spanish.** UNSPSC segment names, modality names, departamento names — they all come from SECOP II in Spanish. Don't translate.
- **CORS is per-origin.** If your prod URL isn't `*.vercel.app` or already listed in `ALLOWED_ORIGINS`, ask the operator to edit `workers/api/wrangler.toml`.
- **Rate limits may or may not be active.** Build in `RATE_LIMITED` handling but don't expect to hit it during dev.
- **`/v1/alerts/verify` flips state — don't pre-fetch it.** Browsers and link-preview crawlers will trigger it. If you mount it at a route, also gate the actual server call behind a click ("Confirmar mi alerta") so an unfurled email preview doesn't auto-verify.

---

## 7. Local development

Frontend pointed at the deployed worker: just set `NEXT_PUBLIC_API_BASE` (or your equivalent) to `https://secop-api.<account>.workers.dev` and go. CORS is already open to `http://localhost:3000` and any `*.vercel.app`.

Frontend pointed at a local worker: in `workers/api`, run `npx wrangler dev`. It binds Workers AI and Turso to the same secrets/vars as production, so search and alerts work. Point your frontend at `http://localhost:8787`.

The OpenAPI doc is live at `GET /v1/openapi.yaml` on whichever worker you're hitting — generate clients from there if you want type safety.