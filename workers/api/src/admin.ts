// Admin (Bearer ADMIN_TOKEN) endpoints. Not part of the public OpenAPI surface.

import type { OpenAPIHono } from '@hono/zod-openapi';
import { turso } from '@secop/shared';
import { buildStats } from './stats.js';
import type { ApiBindings, ApiVariables } from './types.js';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authed(req: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const h = req.headers.get('authorization');
  if (!h || !h.startsWith('Bearer ')) return false;
  return timingSafeEqual(h.slice(7), expected);
}

export function registerAdminRoutes(
  app: OpenAPIHono<{ Bindings: ApiBindings & { ADMIN_TOKEN?: string }; Variables: ApiVariables }>,
): void {
  app.get('/admin/stats', async (c) => {
    if (!authed(c.req.raw, c.env.ADMIN_TOKEN)) {
      return c.json(
        { error: { code: 'TOKEN_INVALID', message: 'invalid bearer token' } },
        401,
      );
    }
    const stats = await buildStats(turso(c.env));
    return c.json(stats);
  });
}
