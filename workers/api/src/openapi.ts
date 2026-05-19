// Builds the OpenAPI 3.1 document from registered Hono routes. Used at runtime to serve
// /v1/openapi.{yaml,json} and at build time by scripts/generate-openapi.ts.

import type { OpenAPIHono } from '@hono/zod-openapi';
import type { ApiBindings, ApiVariables } from './types.js';

export const OPENAPI_CONFIG = {
  openapi: '3.1.0' as const,
  info: {
    title: 'SECOP Semantic Search API',
    version: '1.0.0',
    description:
      'Semantic search + email-alert API over SECOP II active tenders (Socrata dataset p6dx-8zbt).',
  },
  servers: [
    { url: 'https://secop-api.<account>.workers.dev', description: 'workers.dev preview' },
  ],
  tags: [
    { name: 'meta', description: 'Health and machine-readable contract' },
    { name: 'catalog', description: 'Sector picker + facet counts' },
    { name: 'search', description: 'Semantic search and per-tender lookup' },
    { name: 'alerts', description: 'Email-alert subscription management' },
  ],
};

export function buildOpenApiDocument(
  app: OpenAPIHono<{ Bindings: ApiBindings; Variables: ApiVariables }>,
): unknown {
  return app.getOpenAPI31Document(OPENAPI_CONFIG);
}
