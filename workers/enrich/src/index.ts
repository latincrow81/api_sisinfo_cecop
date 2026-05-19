// Enrich worker. Cron (after ingest) embeds + summarizes new tenders. Manual
// POST /admin/enrich runs the same logic in the background (ctx.waitUntil) so the
// 30s fetch wallclock doesn't bound it.

import { turso, type TursoEnv } from '@secop/shared';
import { enrich, type EnrichEnv, type EnrichOptions } from './enrich.js';

interface Env extends TursoEnv, EnrichEnv {
  ADMIN_TOKEN: string;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authed(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const h = request.headers.get('authorization');
  if (!h || !h.startsWith('Bearer ')) return false;
  return timingSafeEqual(h.slice(7), expected);
}

function parsePositiveInt(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/admin/enrich' && request.method === 'POST') {
      if (!authed(request, env.ADMIN_TOKEN)) {
        return json(
          { error: { code: 'TOKEN_INVALID', message: 'invalid bearer token' } },
          { status: 401 },
        );
      }
      const opts: EnrichOptions = {};
      const batchSize = parsePositiveInt(url.searchParams.get('batch_size'));
      const maxBatches = parsePositiveInt(url.searchParams.get('max_batches'));
      if (batchSize !== undefined) opts.batchSize = batchSize;
      if (maxBatches !== undefined) opts.maxBatches = maxBatches;

      // Run in background so a deep batch doesn't blow the 30s fetch wallclock.
      ctx.waitUntil(
        (async () => {
          try {
            const result = await enrich(turso(env), env.AI, opts);
            console.log('enrich:complete', JSON.stringify(result));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('enrich:admin:error', message);
          }
        })(),
      );

      return json(
        {
          ok: true,
          message: 'enrich started in background; tail worker logs for results',
          opts,
        },
        { status: 202 },
      );
    }

    return json(
      { error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${url.pathname}` } },
      { status: 404 },
    );
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await enrich(turso(env), env.AI, {});
          console.log('enrich:complete', JSON.stringify(result));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('enrich:scheduled:error', message);
          throw err;
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
