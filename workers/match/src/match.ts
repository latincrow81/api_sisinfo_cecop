// Match orchestration: for each verified alert, run the canonical vector search
// against tenders that arrived since the last digest. Group hits by email, send one
// Resend digest per email per day, and advance last_sent_at.
//
// min_score in the alerts table is a cosine SIMILARITY threshold (1 - distance), where
// 1.0 is identical and 0.0 is orthogonal. Default 0.55 (per API_PLAN §6).

import {
  escapeHtml,
  sendEmail,
  signToken,
  TOKEN_TTL,
  turso,
  type Client,
  type ResendEnv,
  type TursoEnv,
} from '@secop/shared';

export interface MatchEnv extends TursoEnv, ResendEnv {
  HMAC_SECRET: string;
  API_BASE_URL: string;
}

export interface MatchResult {
  alertsConsidered: number;
  emailsSent: number;
  emailsSkippedTodayDuplicate: number;
  emailsNoMatches: number;
  totalHits: number;
  disabledByFlag: boolean;
  startedAt: string;
  completedAt: string;
}

interface AlertRow {
  id: string;
  email: string;
  query: string;
  query_embedding: Uint8Array;
  unspsc_segments: string | null;
  min_value: number | null;
  max_value: number | null;
  modalidad: string | null;
  departamento: string | null;
  min_score: number;
  last_sent_at: string | null;
}

interface Hit {
  id: string;
  nombre: string | null;
  entidad: string | null;
  ciudad: string | null;
  departamento: string | null;
  precio_base: number | null;
  fecha_recepcion: string | null;
  url: string | null;
  resumen: string | null;
  similarity: number;
}

const KNN_POOL = 200;
const PER_ALERT_HIT_LIMIT = 25;

function toBlob(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new Error(`expected blob, got ${typeof v}`);
}

function parseSummaryResumen(raw: unknown): string | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(String(raw)) as { resumen?: unknown };
    return typeof parsed.resumen === 'string' ? parsed.resumen : null;
  } catch {
    return null;
  }
}

async function isDisabled(db: Client): Promise<boolean> {
  const res = await db.execute({
    sql: "SELECT value FROM kv WHERE key = 'alerts.disabled'",
    args: [],
  });
  return res.rows[0]?.['value'] === '1';
}

async function loadVerifiedAlerts(db: Client): Promise<AlertRow[]> {
  const res = await db.execute({
    sql: `
      SELECT id, email, query, query_embedding,
             unspsc_segments, min_value, max_value, modalidad, departamento,
             min_score, last_sent_at
      FROM alerts
      WHERE verified = 1
    `,
    args: [],
  });
  return res.rows.map((r) => ({
    id: String(r['id']),
    email: String(r['email']),
    query: r['query'] == null ? '' : String(r['query']),
    query_embedding: toBlob(r['query_embedding']),
    unspsc_segments: r['unspsc_segments'] == null ? null : String(r['unspsc_segments']),
    min_value: r['min_value'] == null ? null : Number(r['min_value']),
    max_value: r['max_value'] == null ? null : Number(r['max_value']),
    modalidad: r['modalidad'] == null ? null : String(r['modalidad']),
    departamento: r['departamento'] == null ? null : String(r['departamento']),
    min_score: r['min_score'] == null ? 0.55 : Number(r['min_score']),
    last_sent_at: r['last_sent_at'] == null ? null : String(r['last_sent_at']),
  }));
}

async function matchForAlert(db: Client, alert: AlertRow): Promise<Hit[]> {
  const nowIso = new Date().toISOString();
  const minV = alert.min_value ?? 0;
  const maxV = alert.max_value ?? Number.MAX_SAFE_INTEGER;
  const res = await db.execute({
    sql: `
      SELECT t.id, t.nombre, t.entidad, t.ciudad, t.departamento,
             t.precio_base, t.fecha_recepcion, t.url, t.summary_es,
             (1.0 - vector_distance_cos(t.embedding, :qvec)) AS similarity
      FROM vector_top_k('idx_tenders_vec', :qvec, :k) AS knn
      JOIN tenders t ON t.rowid = knn.id
      WHERE t.estado = 'Publicado'
        AND t.fecha_recepcion > :now
        AND (:since IS NULL OR t.fecha_ultima > :since)
        AND (:segments IS NULL OR t.unspsc_segment IN (SELECT value FROM json_each(:segments)))
        AND t.precio_base BETWEEN :min_v AND :max_v
        AND (:modalidad IS NULL OR t.modalidad = :modalidad)
        AND (:departamento IS NULL OR t.departamento = :departamento)
        AND (1.0 - vector_distance_cos(t.embedding, :qvec)) >= :min_score
      ORDER BY similarity DESC
      LIMIT :lim
    `,
    args: {
      qvec: alert.query_embedding,
      k: KNN_POOL,
      now: nowIso,
      since: alert.last_sent_at,
      segments: alert.unspsc_segments,
      min_v: minV,
      max_v: maxV,
      modalidad: alert.modalidad,
      departamento: alert.departamento,
      min_score: alert.min_score,
      lim: PER_ALERT_HIT_LIMIT,
    },
  });
  return res.rows.map((r) => ({
    id: String(r['id']),
    nombre: r['nombre'] == null ? null : String(r['nombre']),
    entidad: r['entidad'] == null ? null : String(r['entidad']),
    ciudad: r['ciudad'] == null ? null : String(r['ciudad']),
    departamento: r['departamento'] == null ? null : String(r['departamento']),
    precio_base: r['precio_base'] == null ? null : Number(r['precio_base']),
    fecha_recepcion: r['fecha_recepcion'] == null ? null : String(r['fecha_recepcion']),
    url: r['url'] == null ? null : String(r['url']),
    resumen: parseSummaryResumen(r['summary_es']),
    similarity: Number(r['similarity'] ?? 0),
  }));
}

function fmtCop(v: number | null): string {
  if (v == null) return '—';
  return new Intl.NumberFormat('es-CO').format(v) + ' COP';
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

function renderAlertSection(
  apiBase: string,
  unsubToken: string,
  alert: AlertRow,
  hits: Hit[],
): string {
  const unsubUrl = `${apiBase}/v1/alerts/unsubscribe?token=${encodeURIComponent(unsubToken)}`;
  const rows = hits
    .map((h) => {
      const title = escapeHtml(h.nombre ?? h.id);
      const entity = escapeHtml(
        [h.entidad, [h.ciudad, h.departamento].filter(Boolean).join(', ')].filter(Boolean).join(' — '),
      );
      const summary = h.resumen ? `<p>${escapeHtml(h.resumen)}</p>` : '';
      const link = h.url
        ? `<p><a href="${escapeHtml(h.url)}">Ver en SECOP II</a></p>`
        : '';
      return `<li>
  <strong>${title}</strong> · <small>${fmtPct(h.similarity)} similitud</small><br>
  ${entity}<br>
  <small>Hasta ${escapeHtml(h.fecha_recepcion ?? '—')} · ${fmtCop(h.precio_base)}</small>
  ${summary}${link}
</li>`;
    })
    .join('\n');
  return `<section style="margin-bottom:2rem">
  <h3 style="margin:0 0 .5rem">"${escapeHtml(alert.query)}"</h3>
  <ul style="padding-left:1rem">
${rows}
  </ul>
  <p style="font-size:.85rem;color:#6b7280;margin-top:.5rem">
    <a href="${escapeHtml(unsubUrl)}">Cancelar esta alerta</a>
  </p>
</section>`;
}

function buildDigestText(perAlert: { alert: AlertRow; hits: Hit[]; unsubUrl: string }[]): string {
  const blocks = perAlert.map(({ alert, hits, unsubUrl }) => {
    const lines = hits.map(
      (h) =>
        `- ${h.nombre ?? h.id} (${fmtPct(h.similarity)} similitud, hasta ${h.fecha_recepcion ?? '—'}, ${fmtCop(h.precio_base)})${h.url ? `\n  ${h.url}` : ''}`,
    );
    return `Alerta: "${alert.query}"\n${lines.join('\n')}\n\nCancelar: ${unsubUrl}`;
  });
  return blocks.join('\n\n---\n\n');
}

export async function runMatch(env: MatchEnv): Promise<MatchResult> {
  const startedAt = new Date();
  const todayUtc = startedAt.toISOString().slice(0, 10);
  const db = turso(env);

  if (await isDisabled(db)) {
    console.warn('match:disabled-by-kv-flag');
    return {
      alertsConsidered: 0,
      emailsSent: 0,
      emailsSkippedTodayDuplicate: 0,
      emailsNoMatches: 0,
      totalHits: 0,
      disabledByFlag: true,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  const alerts = await loadVerifiedAlerts(db);
  const byEmail = new Map<string, AlertRow[]>();
  for (const a of alerts) {
    const list = byEmail.get(a.email);
    if (list) list.push(a);
    else byEmail.set(a.email, [a]);
  }

  let emailsSent = 0;
  let emailsSkippedTodayDuplicate = 0;
  let emailsNoMatches = 0;
  let totalHits = 0;

  for (const [email, emailAlerts] of byEmail) {
    const alreadySentToday = emailAlerts.some(
      (a) => a.last_sent_at != null && a.last_sent_at.slice(0, 10) === todayUtc,
    );
    if (alreadySentToday) {
      emailsSkippedTodayDuplicate++;
      continue;
    }

    const perAlert: { alert: AlertRow; hits: Hit[]; unsubUrl: string; unsubToken: string }[] = [];
    let emailHitCount = 0;
    for (const alert of emailAlerts) {
      const hits = await matchForAlert(db, alert);
      if (hits.length === 0) continue;
      const unsubToken = await signToken(
        {
          sub: alert.id,
          scope: 'unsubscribe',
          exp: Math.floor(Date.now() / 1000) + TOKEN_TTL.unsubscribe,
        },
        env.HMAC_SECRET,
      );
      const unsubUrl = `${env.API_BASE_URL}/v1/alerts/unsubscribe?token=${encodeURIComponent(unsubToken)}`;
      perAlert.push({ alert, hits, unsubUrl, unsubToken });
      emailHitCount += hits.length;
    }

    if (perAlert.length === 0) {
      emailsNoMatches++;
      continue;
    }

    const sections = perAlert
      .map((p) => renderAlertSection(env.API_BASE_URL, p.unsubToken, p.alert, p.hits))
      .join('\n');
    const html = `<div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;color:#1f2937">
  <h2 style="margin:0 0 1rem">Nuevas oportunidades SECOP</h2>
  ${sections}
  <hr>
  <p style="font-size:.8rem;color:#9ca3af">SECOP Alertas · ${escapeHtml(todayUtc)}</p>
</div>`;
    const text = buildDigestText(
      perAlert.map((p) => ({ alert: p.alert, hits: p.hits, unsubUrl: p.unsubUrl })),
    );

    try {
      await sendEmail(env, {
        to: email,
        subject: `Nuevas oportunidades SECOP — ${emailHitCount}`,
        html,
        text,
      });
      emailsSent++;
      totalHits += emailHitCount;
      const nowIso = new Date().toISOString();
      await db.execute({
        sql: 'UPDATE alerts SET last_sent_at = ? WHERE email = ?',
        args: [nowIso, email],
      });
    } catch (err) {
      console.error(
        `match:send:error email=${email}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    alertsConsidered: alerts.length,
    emailsSent,
    emailsSkippedTodayDuplicate,
    emailsNoMatches,
    totalHits,
    disabledByFlag: false,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
  };
}
