// API worker entry. OpenAPIHono app with CORS, error envelope handler, and the v1 routes.

import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { stringify as stringifyYaml } from 'yaml';
import { registerAdminRoutes } from './admin.js';
import { registerAlertRoutes } from './alerts.js';
import { isAllowed, parseAllowed } from './cors.js';
import { ApiError } from './errors.js';
import { buildOpenApiDocument, OPENAPI_CONFIG } from './openapi.js';
import { registerRoutes } from './routes.js';
import { runDailyQuotaCheck } from './stats.js';
import type { ApiBindings, ApiVariables } from './types.js';

const app = new OpenAPIHono<{ Bindings: ApiBindings; Variables: ApiVariables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR' as const,
            message: 'request failed schema validation',
            details: { issues: result.error.issues },
          },
        },
        400,
      );
    }
    return undefined;
  },
});

app.use('*', async (c, next) => {
  const allowed = parseAllowed(c.env.ALLOWED_ORIGINS);
  return cors({
    origin: (origin) => (isAllowed(origin, allowed) ? origin : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['content-type', 'authorization'],
    maxAge: 600,
  })(c, next);
});

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      },
      err.status,
    );
  }
  console.error('api:unhandled', err instanceof Error ? err.stack ?? err.message : String(err));
  return c.json(
    { error: { code: 'INTERNAL' as const, message: 'internal error' } },
    500,
  );
});

app.notFound((c) =>
  c.json(
    {
      error: {
        code: 'NOT_FOUND' as const,
        message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`,
      },
    },
    404,
  ),
);

registerRoutes(app);
registerAlertRoutes(app);
registerAdminRoutes(app);

// Machine-readable contract. JSON and YAML variants over the same document.
app.get('/v1/openapi.json', (c) => c.json(buildOpenApiDocument(app)));
app.get('/v1/openapi.yaml', () => {
  const yaml = stringifyYaml(buildOpenApiDocument(app));
  return new Response(yaml, {
    headers: { 'content-type': 'application/yaml; charset=utf-8' },
  });
});

// Mounted JSON doc for tooling that expects the @hono/zod-openapi convention.
app.doc31('/v1/openapi/doc', OPENAPI_CONFIG);

// Daily quota webhook (23:00 UTC). Scheduled handler co-located with the api app since
// it reads the same Turso DB and the OpenAPIHono "app" itself doesn't ship a scheduled
// trigger — we wrap default export to add one.
const handlers = {
  fetch: app.fetch.bind(app),
  async scheduled(
    _controller: ScheduledController,
    env: ApiBindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await runDailyQuotaCheck(env);
          console.log('api:quota-check:complete', JSON.stringify(result));
        } catch (err) {
          console.error(
            'api:quota-check:error',
            err instanceof Error ? err.message : String(err),
          );
        }
      })(),
    );
  },
} satisfies ExportedHandler<ApiBindings>;

export default handlers;
