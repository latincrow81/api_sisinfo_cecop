// Zod schemas for the v1 API. Each schema is registered with @hono/zod-openapi so the
// same source produces the OpenAPI document served at /v1/openapi.yaml.

import { z } from '@hono/zod-openapi';

export const ErrorCode = z
  .enum(['VALIDATION_ERROR', 'NOT_FOUND', 'RATE_LIMITED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'INTERNAL'])
  .openapi('ErrorCode');

export const ErrorEnvelope = z
  .object({
    error: z.object({
      code: ErrorCode,
      message: z.string(),
      details: z.record(z.unknown()).optional(),
    }),
  })
  .openapi('Error');
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export const Summary = z
  .object({
    resumen: z.string(),
    requisitos_clave: z.array(z.string()),
    perfil_proveedor: z.string(),
  })
  .openapi('Summary');
export type Summary = z.infer<typeof Summary>;

export const Tender = z
  .object({
    id: z.string(),
    entidad: z.string().nullable(),
    nit_entidad: z.string().nullable(),
    departamento: z.string().nullable(),
    ciudad: z.string().nullable(),
    objeto: z.string().nullable(),
    nombre: z.string().nullable(),
    unspsc: z.string().nullable(),
    unspsc_segment: z.string().nullable(),
    modalidad: z.string().nullable(),
    tipo_contrato: z.string().nullable(),
    subtipo_contrato: z.string().nullable(),
    precio_base: z.number().nullable(),
    estado: z.string().nullable(),
    fase: z.string().nullable(),
    fecha_publicacion: z.string().nullable(),
    fecha_ultima: z.string().nullable(),
    fecha_recepcion: z.string().nullable(),
    url: z.string().nullable(),
    summary: Summary.nullable(),
  })
  .openapi('Tender');
export type Tender = z.infer<typeof Tender>;

export const SearchHit = Tender.extend({ score: z.number() }).openapi('SearchHit');
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchRequest = z
  .object({
    query: z.string().min(1).max(2000),
    unspsc_segments: z.array(z.string().regex(/^\d{2}$/)).max(20).optional(),
    min_value: z.number().nonnegative().optional(),
    max_value: z.number().nonnegative().optional(),
    modalidad: z.string().optional(),
    top_k: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
  })
  .openapi('SearchRequest');
export type SearchRequest = z.infer<typeof SearchRequest>;

export const SearchResponse = z
  .object({
    items: z.array(SearchHit),
    next_cursor: z.string().nullable(),
  })
  .openapi('SearchResponse');
export type SearchResponse = z.infer<typeof SearchResponse>;

export const Sector = z
  .object({
    segment: z.string(),
    tender_count: z.number().int().nonnegative(),
  })
  .openapi('Sector');
export type Sector = z.infer<typeof Sector>;

export const SectorsResponse = z
  .object({
    sectors: z.array(Sector),
  })
  .openapi('SectorsResponse');
export type SectorsResponse = z.infer<typeof SectorsResponse>;

export const FacetEntry = z
  .object({
    value: z.string(),
    count: z.number().int().nonnegative(),
  })
  .openapi('FacetEntry');

export const FacetsResponse = z
  .object({
    modalidad: z.array(FacetEntry),
    estado: z.array(FacetEntry),
    departamento: z.array(FacetEntry),
  })
  .openapi('FacetsResponse');
export type FacetsResponse = z.infer<typeof FacetsResponse>;

// ─── Alerts ───────────────────────────────────────────────────────────────────────────

export const AlertFilters = z
  .object({
    unspsc_segments: z.array(z.string().regex(/^\d{2}$/)).max(20).optional(),
    min_value: z.number().nonnegative().optional(),
    max_value: z.number().nonnegative().optional(),
    modalidad: z.string().optional(),
    departamento: z.string().optional(),
    min_score: z.number().min(0).max(1).optional(),
  })
  .openapi('AlertFilters');

export const AlertCreateRequest = AlertFilters.extend({
  email: z.string().email(),
  query: z.string().min(1).max(2000),
}).openapi('AlertCreateRequest');
export type AlertCreateRequest = z.infer<typeof AlertCreateRequest>;

export const AlertUpdateRequest = AlertFilters.extend({
  query: z.string().min(1).max(2000).optional(),
}).openapi('AlertUpdateRequest');
export type AlertUpdateRequest = z.infer<typeof AlertUpdateRequest>;

export const Alert = z
  .object({
    id: z.string(),
    email: z.string().email(),
    query: z.string(),
    unspsc_segments: z.array(z.string()).nullable(),
    min_value: z.number().nullable(),
    max_value: z.number().nullable(),
    modalidad: z.string().nullable(),
    departamento: z.string().nullable(),
    min_score: z.number(),
    verified: z.boolean(),
    last_sent_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi('Alert');
export type Alert = z.infer<typeof Alert>;

export const AlertCreateResponse = z
  .object({
    ok: z.literal(true),
    message: z.string(),
  })
  .openapi('AlertCreateResponse');

export const AlertVerifyResponse = z
  .object({
    ok: z.literal(true),
    alert: Alert,
  })
  .openapi('AlertVerifyResponse');

export const AlertListResponse = z
  .object({
    alerts: z.array(Alert),
  })
  .openapi('AlertListResponse');

export const AlertDeleteResponse = z
  .object({
    ok: z.literal(true),
  })
  .openapi('AlertDeleteResponse');

// ─── Health ───────────────────────────────────────────────────────────────────────────

export const Probe = z
  .object({
    status: z.enum(['ok', 'fail', 'timeout']),
    latency_ms: z.number().nullable(),
    checked_at: z.string(),
    detail: z.string().optional(),
  })
  .openapi('Probe');

export const HealthResponse = z
  .object({
    status: z.enum(['ok', 'degraded']),
    phase: z.string(),
    started_at: z.string(),
    checks: z.object({
      turso: Probe,
      workers_ai: Probe,
      last_ingest_age_s: z.number().nullable(),
      last_enrich_age_s: z.number().nullable(),
    }),
  })
  .openapi('HealthResponse');
export type HealthResponse = z.infer<typeof HealthResponse>;
