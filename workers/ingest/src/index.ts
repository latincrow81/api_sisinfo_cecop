// Ingest worker. Cron-driven Socrata pull + manual POST /admin/backfill for re-runs.

import { turso, type TursoEnv } from '@secop/shared';
import { ingest, type IngestEnv } from './ingest.js';

interface Env extends TursoEnv, IngestEnv {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/admin/backfill' && request.method === 'POST') {
      if (!authed(request, env.ADMIN_TOKEN)) {
        return json(
          { error: { code: 'TOKEN_INVALID', message: 'invalid bearer token' } },
          { status: 401 },
        );
      }
      // ?since=<ISO>  override watermark with this value
      // ?since=       empty value ⇒ ignore watermark (full open-set backfill)
      // (absent)      use stored watermark
      let since: string | null | undefined = undefined;
      if (url.searchParams.has('since')) {
        const s = url.searchParams.get('since');
        since = s && s.length > 0 ? s : null;
      }
      try {
        const result = await ingest(turso(env), env, { since });
        return json({ ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('ingest:error', message);
        return json({ error: { code: 'INTERNAL', message } }, { status: 500 });
      }
    }

    return json(
      { error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${url.pathname}` } },
      { status: 404 },
    );
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await ingest(turso(env), env, {});
          console.log('ingest:complete', JSON.stringify(result));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('ingest:scheduled:error', message);
          throw err;
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
