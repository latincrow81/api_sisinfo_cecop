// Match worker. Cron-driven digest sender. Manual POST /admin/match for testing.

import { runMatch, type MatchEnv } from './match.js';

interface Env extends MatchEnv {
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/admin/match' && request.method === 'POST') {
      if (!authed(request, env.ADMIN_TOKEN)) {
        return json(
          { error: { code: 'TOKEN_INVALID', message: 'invalid bearer token' } },
          { status: 401 },
        );
      }
      ctx.waitUntil(
        (async () => {
          try {
            const result = await runMatch(env);
            console.log('match:complete', JSON.stringify(result));
          } catch (err) {
            console.error(
              'match:admin:error',
              err instanceof Error ? err.message : String(err),
            );
          }
        })(),
      );
      return json(
        { ok: true, message: 'match started in background; tail worker logs for results' },
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
          const result = await runMatch(env);
          console.log('match:complete', JSON.stringify(result));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('match:scheduled:error', message);
          throw err;
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
