// Alert routes: passwordless magic-link flow + HMAC-token-gated management.
//
// Tokens carry { sub, scope, exp } and are verified via HMAC_SECRET. Three scopes:
//   manage_alert  — per-alert, 7-day TTL. Magic link uses this; PATCH/DELETE require it.
//   manage_email  — per-email, 7-day TTL. Issued by /verify so the user can list alerts.
//   unsubscribe   — per-alert, 1-year TTL. Embedded in digest emails (single-use via
//                   alert deletion — re-using the token after delete returns 404).

import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  escapeHtml,
  sendEmail,
  signToken,
  TOKEN_TTL,
  turso,
  verifyToken,
  type TokenPayload,
  type TokenScope,
} from '@secop/shared';
import { embedQuery } from './embed.js';
import { ApiError, internal, notFound } from './errors.js';
import {
  Alert,
  AlertCreateRequest,
  AlertCreateResponse,
  AlertDeleteResponse,
  AlertListResponse,
  AlertUpdateRequest,
  AlertVerifyResponse,
  ErrorEnvelope,
} from './schemas.js';
import type { ApiBindings, ApiVariables } from './types.js';

type ApiContext = OpenAPIHono<{ Bindings: ApiBindings; Variables: ApiVariables }>;

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorEnvelope } },
});

async function expectToken(
  rawToken: string | undefined,
  secret: string,
  scope: TokenScope,
): Promise<TokenPayload> {
  if (!rawToken) throw new ApiError('TOKEN_INVALID', 'missing token', 401);
  const result = await verifyToken(rawToken, secret);
  if (!result.ok) {
    const code = result.reason === 'expired' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    throw new ApiError(code, `token ${result.reason}`, 401);
  }
  if (result.payload.scope !== scope) {
    throw new ApiError('TOKEN_INVALID', 'token scope mismatch', 401);
  }
  return result.payload;
}

function rowToAlert(r: Record<string, unknown>): Alert {
  let segments: string[] | null = null;
  if (r['unspsc_segments'] != null) {
    try {
      const parsed: unknown = JSON.parse(String(r['unspsc_segments']));
      if (Array.isArray(parsed)) segments = parsed.map((v) => String(v));
    } catch {
      segments = null;
    }
  }
  return {
    id: String(r['id']),
    email: String(r['email']),
    query: r['query'] == null ? '' : String(r['query']),
    unspsc_segments: segments,
    min_value: r['min_value'] == null ? null : Number(r['min_value']),
    max_value: r['max_value'] == null ? null : Number(r['max_value']),
    modalidad: r['modalidad'] == null ? null : String(r['modalidad']),
    departamento: r['departamento'] == null ? null : String(r['departamento']),
    min_score: r['min_score'] == null ? 0.55 : Number(r['min_score']),
    verified: Number(r['verified'] ?? 0) === 1,
    last_sent_at: r['last_sent_at'] == null ? null : String(r['last_sent_at']),
    created_at: r['created_at'] == null ? '' : String(r['created_at']),
  };
}

function magicLinkBody(verifyUrl: string, query: string): { html: string; text: string } {
  const safeQuery = escapeHtml(query);
  const safeUrl = escapeHtml(verifyUrl);
  return {
    html: `<p>Hola,</p>
<p>Confirma tu alerta para "<strong>${safeQuery}</strong>" haciendo clic en este enlace (válido 24 horas):</p>
<p><a href="${safeUrl}">${safeUrl}</a></p>
<p>Si no solicitaste esto, ignora este correo.</p>`,
    text: `Confirma tu alerta para "${query}" abriendo este enlace (válido 24 horas):\n${verifyUrl}\n\nSi no solicitaste esto, ignora este correo.`,
  };
}

export function registerAlertRoutes(app: ApiContext): void {
  // ─── POST /v1/alerts ──────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/alerts',
      tags: ['alerts'],
      summary: 'Create a draft alert and email a verification magic link',
      request: { body: { content: { 'application/json': { schema: AlertCreateRequest } } } },
      responses: {
        202: {
          description: 'magic link queued for delivery',
          content: { 'application/json': { schema: AlertCreateResponse } },
        },
        400: errorResponse('validation failed'),
      },
    }),
    async (c) => {
      const body = c.req.valid('json');
      const id = crypto.randomUUID();
      const qvec = await embedQuery(c.env.AI, body.query);

      const segments =
        body.unspsc_segments && body.unspsc_segments.length > 0
          ? JSON.stringify(body.unspsc_segments)
          : null;
      const now = new Date().toISOString();

      const db = turso(c.env);
      await db.execute({
        sql: `
          INSERT INTO alerts (
            id, email, query, query_embedding,
            unspsc_segments, min_value, max_value, modalidad, departamento,
            min_score, verified, last_sent_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
        `,
        args: [
          id,
          body.email,
          body.query,
          qvec,
          segments,
          body.min_value ?? null,
          body.max_value ?? null,
          body.modalidad ?? null,
          body.departamento ?? null,
          body.min_score ?? 0.55,
          now,
        ],
      });

      const token = await signToken(
        { sub: id, scope: 'manage_alert', exp: Math.floor(Date.now() / 1000) + TOKEN_TTL.verify },
        c.env.HMAC_SECRET,
      );
      const verifyUrl = `${c.env.API_BASE_URL}/v1/alerts/verify?token=${encodeURIComponent(token)}`;
      const bodyContent = magicLinkBody(verifyUrl, body.query);
      try {
        await sendEmail(c.env, {
          to: body.email,
          subject: 'Confirma tu alerta SECOP',
          html: bodyContent.html,
          text: bodyContent.text,
        });
      } catch (err) {
        // Roll back the draft so a transient Resend failure doesn't leave orphans.
        await db.execute({ sql: 'DELETE FROM alerts WHERE id = ?', args: [id] });
        throw internal(err instanceof Error ? err.message : String(err));
      }

      return c.json({ ok: true as const, message: 'magic link sent' }, 202);
    },
  );

  // ─── GET /v1/alerts/verify?token= ─────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/alerts/verify',
      tags: ['alerts'],
      summary: 'Activate a draft alert via the magic-link token',
      request: {
        query: z.object({ token: z.string().min(1) }),
      },
      responses: {
        200: {
          description: 'alert activated',
          content: { 'application/json': { schema: AlertVerifyResponse } },
        },
        401: errorResponse('token invalid or expired'),
        404: errorResponse('alert not found'),
      },
    }),
    async (c) => {
      const { token } = c.req.valid('query');
      const payload = await expectToken(token, c.env.HMAC_SECRET, 'manage_alert');
      const db = turso(c.env);
      await db.execute({
        sql: 'UPDATE alerts SET verified = 1 WHERE id = ?',
        args: [payload.sub],
      });
      const res = await db.execute({
        sql: 'SELECT id, email, query, unspsc_segments, min_value, max_value, modalidad, departamento, min_score, verified, last_sent_at, created_at FROM alerts WHERE id = ?',
        args: [payload.sub],
      });
      const row = res.rows[0];
      if (!row) throw notFound('alert not found', { id: payload.sub });
      const alert = rowToAlert(row);
      return c.json({ ok: true as const, alert }, 200);
    },
  );

  // ─── GET /v1/alerts/unsubscribe?token= ────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/alerts/unsubscribe',
      tags: ['alerts'],
      summary: 'One-click unsubscribe via the digest-email token',
      request: {
        query: z.object({ token: z.string().min(1) }),
      },
      responses: {
        200: {
          description: 'unsubscribed',
          content: { 'application/json': { schema: AlertDeleteResponse } },
        },
        401: errorResponse('token invalid or expired'),
      },
    }),
    async (c) => {
      const { token } = c.req.valid('query');
      const payload = await expectToken(token, c.env.HMAC_SECRET, 'unsubscribe');
      const db = turso(c.env);
      await db.execute({ sql: 'DELETE FROM alerts WHERE id = ?', args: [payload.sub] });
      return c.json({ ok: true as const }, 200);
    },
  );

  // ─── GET /v1/alerts?email=&token= ─────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/alerts',
      tags: ['alerts'],
      summary: 'List all alerts for a verified email (manage_email token)',
      request: {
        query: z.object({
          email: z.string().email(),
          token: z.string().min(1),
        }),
      },
      responses: {
        200: {
          description: 'list of alerts for that email',
          content: { 'application/json': { schema: AlertListResponse } },
        },
        401: errorResponse('token invalid or scope mismatch'),
      },
    }),
    async (c) => {
      const { email, token } = c.req.valid('query');
      const payload = await expectToken(token, c.env.HMAC_SECRET, 'manage_email');
      if (payload.sub !== email) throw new ApiError('TOKEN_INVALID', 'token does not match email', 401);
      const db = turso(c.env);
      const res = await db.execute({
        sql: 'SELECT id, email, query, unspsc_segments, min_value, max_value, modalidad, departamento, min_score, verified, last_sent_at, created_at FROM alerts WHERE email = ? ORDER BY created_at ASC',
        args: [email],
      });
      return c.json({ alerts: res.rows.map((r) => rowToAlert(r as Record<string, unknown>)) }, 200);
    },
  );

  // ─── PATCH /v1/alerts/{id}?token= ─────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/alerts/{id}',
      tags: ['alerts'],
      summary: 'Update an alert (manage_alert token)',
      request: {
        params: Alert.pick({ id: true }),
        query: z.object({ token: z.string().min(1) }),
        body: { content: { 'application/json': { schema: AlertUpdateRequest } } },
      },
      responses: {
        200: {
          description: 'updated alert',
          content: { 'application/json': { schema: Alert } },
        },
        401: errorResponse('token invalid or scope mismatch'),
        404: errorResponse('alert not found'),
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { token } = c.req.valid('query');
      const body = c.req.valid('json');
      const payload = await expectToken(token, c.env.HMAC_SECRET, 'manage_alert');
      if (payload.sub !== id) throw new ApiError('TOKEN_INVALID', 'token does not match alert', 401);

      const db = turso(c.env);
      const sets: string[] = [];
      const args: (string | number | null | Uint8Array)[] = [];

      if (body.query !== undefined) {
        const qvec = await embedQuery(c.env.AI, body.query);
        sets.push('query = ?', 'query_embedding = ?');
        args.push(body.query, qvec);
      }
      if (body.unspsc_segments !== undefined) {
        sets.push('unspsc_segments = ?');
        args.push(body.unspsc_segments.length > 0 ? JSON.stringify(body.unspsc_segments) : null);
      }
      if (body.min_value !== undefined) { sets.push('min_value = ?'); args.push(body.min_value); }
      if (body.max_value !== undefined) { sets.push('max_value = ?'); args.push(body.max_value); }
      if (body.modalidad !== undefined) { sets.push('modalidad = ?'); args.push(body.modalidad); }
      if (body.departamento !== undefined) { sets.push('departamento = ?'); args.push(body.departamento); }
      if (body.min_score !== undefined) { sets.push('min_score = ?'); args.push(body.min_score); }

      if (sets.length > 0) {
        args.push(id);
        await db.execute({
          sql: `UPDATE alerts SET ${sets.join(', ')} WHERE id = ?`,
          args,
        });
      }

      const res = await db.execute({
        sql: 'SELECT id, email, query, unspsc_segments, min_value, max_value, modalidad, departamento, min_score, verified, last_sent_at, created_at FROM alerts WHERE id = ?',
        args: [id],
      });
      const row = res.rows[0];
      if (!row) throw notFound('alert not found', { id });
      return c.json(rowToAlert(row), 200);
    },
  );

  // ─── DELETE /v1/alerts/{id}?token= ────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/alerts/{id}',
      tags: ['alerts'],
      summary: 'Delete an alert (manage_alert token)',
      request: {
        params: Alert.pick({ id: true }),
        query: z.object({ token: z.string().min(1) }),
      },
      responses: {
        200: {
          description: 'deleted',
          content: { 'application/json': { schema: AlertDeleteResponse } },
        },
        401: errorResponse('token invalid or scope mismatch'),
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const { token } = c.req.valid('query');
      const payload = await expectToken(token, c.env.HMAC_SECRET, 'manage_alert');
      if (payload.sub !== id) throw new ApiError('TOKEN_INVALID', 'token does not match alert', 401);
      const db = turso(c.env);
      await db.execute({ sql: 'DELETE FROM alerts WHERE id = ?', args: [id] });
      return c.json({ ok: true as const }, 200);
    },
  );
}

// Helper for the verify route to issue a follow-up manage_email token. Not used directly
// in the routes above — kept here so the match worker / future routes can mint these too.
export async function mintManageEmailToken(email: string, secret: string): Promise<string> {
  return signToken(
    { sub: email, scope: 'manage_email', exp: Math.floor(Date.now() / 1000) + TOKEN_TTL.manage },
    secret,
  );
}
