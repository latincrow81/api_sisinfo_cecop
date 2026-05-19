// Downstream probes for /v1/health. The Turso probe is cheap (SELECT 1); the Workers AI
// probe spends ~1 neuron per call so we cache the result for 30 minutes via the Cache API.

import { EMBED_MODEL, type Client } from '@secop/shared';

const AI_PROBE_TTL_S = 30 * 60;
const AI_PROBE_CACHE_KEY = 'https://probe.internal/ai/v1';
const PROBE_TIMEOUT_MS = 1500;

export interface ProbeResult {
  status: 'ok' | 'fail' | 'timeout';
  latency_ms: number | null;
  checked_at: string;
  detail?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function probeTurso(db: Client): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    await withTimeout(db.execute({ sql: 'SELECT 1', args: [] }), PROBE_TIMEOUT_MS);
    return { status: 'ok', latency_ms: Date.now() - t0, checked_at: new Date().toISOString() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: msg.startsWith('timeout') ? 'timeout' : 'fail',
      latency_ms: Date.now() - t0,
      checked_at: new Date().toISOString(),
      detail: msg.slice(0, 200),
    };
  }
}

export async function probeAi(ai: Ai): Promise<ProbeResult> {
  const cacheKey = new Request(AI_PROBE_CACHE_KEY);
  const cached = await caches.default.match(cacheKey);
  if (cached) {
    return (await cached.json()) as ProbeResult;
  }
  const t0 = Date.now();
  let result: ProbeResult;
  try {
    await withTimeout(
      ai.run(EMBED_MODEL as never, { text: 'probe' } as never) as Promise<unknown>,
      PROBE_TIMEOUT_MS,
    );
    result = { status: 'ok', latency_ms: Date.now() - t0, checked_at: new Date().toISOString() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      status: msg.startsWith('timeout') ? 'timeout' : 'fail',
      latency_ms: Date.now() - t0,
      checked_at: new Date().toISOString(),
      detail: msg.slice(0, 200),
    };
  }
  await caches.default.put(
    cacheKey,
    new Response(JSON.stringify(result), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `max-age=${AI_PROBE_TTL_S}`,
      },
    }),
  );
  return result;
}

export async function readIngestAge(db: Client): Promise<{
  last_run_at: string | null;
  age_seconds: number | null;
}> {
  const res = await db.execute({
    sql: 'SELECT last_run_at FROM watermark WHERE dataset = ?',
    args: ['p6dx-8zbt'],
  });
  const row = res.rows[0];
  const iso = row?.['last_run_at'] == null ? null : String(row['last_run_at']);
  if (!iso) return { last_run_at: null, age_seconds: null };
  return {
    last_run_at: iso,
    age_seconds: Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)),
  };
}

export async function readEnrichAge(db: Client): Promise<{
  last_updated_at: string | null;
  age_seconds: number | null;
}> {
  const res = await db.execute({
    sql: 'SELECT MAX(updated_at) AS last_updated_at FROM ai_usage',
    args: [],
  });
  const row = res.rows[0];
  const iso = row?.['last_updated_at'] == null ? null : String(row['last_updated_at']);
  if (!iso) return { last_updated_at: null, age_seconds: null };
  return {
    last_updated_at: iso,
    age_seconds: Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)),
  };
}
