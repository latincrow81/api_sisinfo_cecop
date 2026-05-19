// All v1 routes. Defined together so request/response Zod schemas, OpenAPI route specs,
// and handlers live next to each other.

import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { EMBED_DIM, EMBED_MODEL, floatVectorToBlob, turso } from '@secop/shared';
import { rowToSearchHit, rowToTender, TENDER_COLUMNS } from './db.js';
import { internal, notFound } from './errors.js';
import { probeAi, probeTurso, readEnrichAge, readIngestAge } from './probes.js';
import {
  ErrorEnvelope,
  FacetsResponse,
  HealthResponse,
  SearchRequest,
  SearchResponse,
  SectorsResponse,
  Tender,
} from './schemas.js';
import type { ApiBindings, ApiVariables } from './types.js';

const STARTED_AT = new Date().toISOString();

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorEnvelope } },
});

export function registerRoutes(app: OpenAPIHono<{ Bindings: ApiBindings; Variables: ApiVariables }>): void {
  // ─── GET /v1/health ───────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/health',
      tags: ['meta'],
      summary: 'Liveness + downstream checks',
      responses: {
        200: {
          description: 'service is reachable',
          content: { 'application/json': { schema: HealthResponse } },
        },
      },
    }),
    async (c) => {
      const db = turso(c.env);
      const [turstoProbe, aiProbe, ingestAge, enrichAge] = await Promise.all([
        probeTurso(db),
        probeAi(c.env.AI),
        readIngestAge(db),
        readEnrichAge(db),
      ]);
      const status: 'ok' | 'degraded' =
        turstoProbe.status === 'ok' && aiProbe.status === 'ok' ? 'ok' : 'degraded';
      return c.json(
        {
          status,
          phase: 'P5',
          started_at: STARTED_AT,
          checks: {
            turso: turstoProbe,
            workers_ai: aiProbe,
            last_ingest_age_s: ingestAge.age_seconds,
            last_enrich_age_s: enrichAge.age_seconds,
          },
        },
        200,
      );
    },
  );

  // ─── GET /v1/sectors ──────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/sectors',
      tags: ['catalog'],
      summary: 'UNSPSC segments with tender counts',
      responses: {
        200: {
          description: 'list of segments currently represented in active tenders',
          content: { 'application/json': { schema: SectorsResponse } },
        },
      },
    }),
    async (c) => {
      const db = turso(c.env);
      const res = await db.execute({
        sql: `
          SELECT unspsc_segment AS segment, COUNT(*) AS tender_count
          FROM tenders
          WHERE estado = 'Publicado' AND fecha_recepcion > ?
            AND unspsc_segment IS NOT NULL AND unspsc_segment <> ''
          GROUP BY unspsc_segment
          ORDER BY tender_count DESC, unspsc_segment ASC
        `,
        args: [new Date().toISOString()],
      });
      return c.json(
        {
          sectors: res.rows.map((r) => ({
            segment: String(r['segment']),
            tender_count: Number(r['tender_count']),
          })),
        },
        200,
      );
    },
  );

  // ─── GET /v1/facets ───────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/facets',
      tags: ['catalog'],
      summary: 'Counts grouped by modalidad / estado / departamento',
      responses: {
        200: {
          description: 'facet counts over active tenders',
          content: { 'application/json': { schema: FacetsResponse } },
        },
      },
    }),
    async (c) => {
      const db = turso(c.env);
      const now = new Date().toISOString();
      const facet = async (col: 'modalidad' | 'estado' | 'departamento'): Promise<{ value: string; count: number }[]> => {
        const res = await db.execute({
          sql: `
            SELECT ${col} AS value, COUNT(*) AS n
            FROM tenders
            WHERE estado = 'Publicado' AND fecha_recepcion > ?
              AND ${col} IS NOT NULL AND ${col} <> ''
            GROUP BY ${col}
            ORDER BY n DESC, value ASC
          `,
          args: [now],
        });
        return res.rows.map((r) => ({ value: String(r['value']), count: Number(r['n']) }));
      };
      const [modalidad, estado, departamento] = await Promise.all([
        facet('modalidad'),
        facet('estado'),
        facet('departamento'),
      ]);
      return c.json({ modalidad, estado, departamento }, 200);
    },
  );

  // ─── GET /v1/tenders/{id} ─────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/tenders/{id}',
      tags: ['search'],
      summary: 'Full normalized tender + AI summary',
      request: {
        params: Tender.pick({ id: true }),
      },
      responses: {
        200: {
          description: 'tender found',
          content: { 'application/json': { schema: Tender } },
        },
        404: errorResponse('tender not found'),
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const db = turso(c.env);
      const res = await db.execute({
        sql: `SELECT ${TENDER_COLUMNS} FROM tenders WHERE id = ? LIMIT 1`,
        args: [id],
      });
      const row = res.rows[0];
      if (!row) throw notFound(`tender ${id} not found`, { id });
      return c.json(rowToTender(row), 200);
    },
  );

  // ─── POST /v1/search ──────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/search',
      tags: ['search'],
      summary: 'Semantic search over active tenders',
      request: {
        body: { content: { 'application/json': { schema: SearchRequest } } },
      },
      responses: {
        200: {
          description: 'ranked tenders',
          content: { 'application/json': { schema: SearchResponse } },
        },
        400: errorResponse('validation failed'),
      },
    }),
    async (c) => {
      const body = c.req.valid('json');
      const ai = c.env.AI;

      const embedResp = (await ai.run(EMBED_MODEL as never, { text: body.query } as never)) as {
        data?: number[][];
      };
      const vec = embedResp.data?.[0];
      if (!vec || vec.length !== EMBED_DIM) {
        throw internal('embed call returned wrong shape', {
          got: vec?.length ?? 0,
          expected: EMBED_DIM,
        });
      }
      const qvec = floatVectorToBlob(vec);

      const topK = body.top_k ?? 20;
      const knnK = Math.max(200, topK * 10); // pull a wider candidate set than we return
      const minV = body.min_value ?? 0;
      const maxV = body.max_value ?? Number.MAX_SAFE_INTEGER;
      const segmentsJson =
        body.unspsc_segments && body.unspsc_segments.length > 0
          ? JSON.stringify(body.unspsc_segments)
          : null;
      const modalidad = body.modalidad ?? null;
      const now = new Date().toISOString();

      const db = turso(c.env);
      const res = await db.execute({
        sql: `
          SELECT ${TENDER_COLUMNS},
                 vector_distance_cos(t.embedding, :qvec) AS score
          FROM vector_top_k('idx_tenders_vec', :qvec, :knn_k) AS knn
          JOIN tenders t ON t.rowid = knn.id
          WHERE t.estado = 'Publicado'
            AND t.fecha_recepcion > :now
            AND (:segments IS NULL OR t.unspsc_segment IN (SELECT value FROM json_each(:segments)))
            AND t.precio_base BETWEEN :min_v AND :max_v
            AND (:modalidad IS NULL OR t.modalidad = :modalidad)
          ORDER BY score ASC
          LIMIT :top_k
        `,
        args: {
          qvec,
          knn_k: knnK,
          now,
          segments: segmentsJson,
          min_v: minV,
          max_v: maxV,
          modalidad,
          top_k: topK,
        },
      });

      return c.json(
        {
          items: res.rows.map((r) => rowToSearchHit(r as unknown as Record<string, unknown>)),
          // Cursor pagination is a v2 item; top_k is the page size for v1.
          next_cursor: null,
        },
        200,
      );
    },
  );
}
