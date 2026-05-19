// Quota snapshot for the /admin/stats endpoint and the daily webhook cron.
// Numbers we can read cheaply from Turso. R2 storage and Turso row-reads are NOT here —
// those live in the Cloudflare / Turso dashboards (see RUNBOOK §P5).

import { NEURON_DAILY_HARD_STOP, turso, type Client } from '@secop/shared';

const RESEND_DAILY_CAP = 100; // Resend free tier (API_PLAN §3)
const QUOTA_ALERT_PCT = 0.7;

export interface Stats {
  date: string;
  ai: {
    neurons_used: number;
    embeds_count: number;
    summaries_count: number;
    daily_cap: number;
    pct_used: number;
  };
  ingest: {
    last_run_at: string | null;
    last_run_rows: number;
    age_seconds: number | null;
  };
  enrich: {
    rows_with_embedding: number;
    rows_without_embedding: number;
    rows_with_summary: number;
    last_embedded_at: string | null;
    age_seconds: number | null;
  };
  alerts: {
    total: number;
    verified: number;
    digests_sent_today: number;
  };
  email: {
    sent_today: number;
    daily_cap: number;
    pct_used: number;
  };
}

function ageSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

export async function buildStats(db: Client): Promise<Stats> {
  const today = new Date().toISOString().slice(0, 10);

  const aiRes = await db.execute({
    sql: 'SELECT neurons_used, embeds_count, summaries_count FROM ai_usage WHERE day = ?',
    args: [today],
  });
  const ai = aiRes.rows[0];
  const neurons = ai ? Number(ai['neurons_used'] ?? 0) : 0;
  const embeds = ai ? Number(ai['embeds_count'] ?? 0) : 0;
  const summaries = ai ? Number(ai['summaries_count'] ?? 0) : 0;

  const watermarkRes = await db.execute({
    sql: 'SELECT last_run_at, last_run_rows FROM watermark WHERE dataset = ?',
    args: ['p6dx-8zbt'],
  });
  const wm = watermarkRes.rows[0];

  const tenderCountRes = await db.execute({
    sql: `
      SELECT
        SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS with_embed,
        SUM(CASE WHEN embedding IS NULL THEN 1 ELSE 0 END)     AS without_embed,
        SUM(CASE WHEN summary_es IS NOT NULL THEN 1 ELSE 0 END) AS with_summary,
        MAX(embedded_at)                                       AS last_embedded_at
      FROM tenders
    `,
    args: [],
  });
  const tc: Record<string, unknown> = tenderCountRes.rows[0] ?? {};
  const withEmbed = Number(tc['with_embed'] ?? 0);
  const withoutEmbed = Number(tc['without_embed'] ?? 0);
  const withSummary = Number(tc['with_summary'] ?? 0);
  const lastEmbeddedAt = tc['last_embedded_at'] == null ? null : String(tc['last_embedded_at']);

  const alertCountsRes = await db.execute({
    sql: `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified,
        SUM(CASE WHEN substr(last_sent_at, 1, 10) = ? THEN 1 ELSE 0 END) AS digests_today
      FROM alerts
    `,
    args: [today],
  });
  const ac: Record<string, unknown> = alertCountsRes.rows[0] ?? {};
  const alertsTotal = Number(ac['total'] ?? 0);
  const alertsVerified = Number(ac['verified'] ?? 0);
  const digestsToday = Number(ac['digests_today'] ?? 0);

  const lastRunAt = wm?.['last_run_at'] == null ? null : String(wm['last_run_at']);

  return {
    date: today,
    ai: {
      neurons_used: neurons,
      embeds_count: embeds,
      summaries_count: summaries,
      daily_cap: NEURON_DAILY_HARD_STOP,
      pct_used: neurons / NEURON_DAILY_HARD_STOP,
    },
    ingest: {
      last_run_at: lastRunAt,
      last_run_rows: wm ? Number(wm['last_run_rows'] ?? 0) : 0,
      age_seconds: ageSeconds(lastRunAt),
    },
    enrich: {
      rows_with_embedding: withEmbed,
      rows_without_embedding: withoutEmbed,
      rows_with_summary: withSummary,
      last_embedded_at: lastEmbeddedAt,
      age_seconds: ageSeconds(lastEmbeddedAt),
    },
    alerts: {
      total: alertsTotal,
      verified: alertsVerified,
      digests_sent_today: digestsToday,
    },
    email: {
      sent_today: digestsToday,
      daily_cap: RESEND_DAILY_CAP,
      pct_used: digestsToday / RESEND_DAILY_CAP,
    },
  };
}

export interface QuotaWarning {
  metric: 'ai_neurons' | 'email';
  pct_used: number;
  used: number;
  cap: number;
}

export function warningsFromStats(s: Stats): QuotaWarning[] {
  const out: QuotaWarning[] = [];
  if (s.ai.pct_used >= QUOTA_ALERT_PCT) {
    out.push({
      metric: 'ai_neurons',
      pct_used: s.ai.pct_used,
      used: s.ai.neurons_used,
      cap: s.ai.daily_cap,
    });
  }
  if (s.email.pct_used >= QUOTA_ALERT_PCT) {
    out.push({
      metric: 'email',
      pct_used: s.email.pct_used,
      used: s.email.sent_today,
      cap: s.email.daily_cap,
    });
  }
  return out;
}

export async function postQuotaWebhook(
  url: string,
  stats: Stats,
  warnings: QuotaWarning[],
): Promise<void> {
  const lines = warnings.map(
    (w) =>
      `*${w.metric}* at ${(w.pct_used * 100).toFixed(0)}% — ${w.used} / ${w.cap} (UTC ${stats.date})`,
  );
  const message = [`:warning: SECOP quota warning`, ...lines].join('\n');
  // Posts both Slack-style "text" and Discord-style "content"; the receiver uses one.
  const body = JSON.stringify({ text: message, content: message });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`webhook ${res.status}: ${text.slice(0, 500)}`);
  }
}

export async function runDailyQuotaCheck(env: {
  TURSO_URL: string;
  TURSO_TOKEN: string;
  QUOTA_WEBHOOK_URL?: string;
}): Promise<{ posted: boolean; warnings: QuotaWarning[]; stats: Stats }> {
  const db = turso(env);
  const stats = await buildStats(db);
  const warnings = warningsFromStats(stats);
  if (warnings.length === 0 || !env.QUOTA_WEBHOOK_URL) {
    return { posted: false, warnings, stats };
  }
  await postQuotaWebhook(env.QUOTA_WEBHOOK_URL, stats, warnings);
  return { posted: true, warnings, stats };
}
