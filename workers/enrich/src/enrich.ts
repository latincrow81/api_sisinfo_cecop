// Enrich orchestration: batched bge-m3 embed + sequential Spanish JSON summary.
// Bounded by an 8k-neurons/day budget (CF cap is 10k; 2k headroom).

import {
  buildEmbedText,
  buildSummaryMessages,
  EMBED_DIM,
  EMBED_MODEL,
  floatVectorToBlob,
  NEURON_DAILY_HARD_STOP,
  NEURONS_PER_EMBED_CALL,
  NEURONS_PER_SUMMARY_CALL,
  parseSummaryJson,
  SUMMARY_MODEL,
  type ChatMessage,
  type Client,
  type Summary,
} from '@secop/shared';

export interface EnrichEnv {
  AI: Ai;
}

export interface EnrichOptions {
  batchSize?: number;
  maxBatches?: number;
}

export type StoppedReason =
  | 'no_more_rows'
  | 'budget_exhausted'
  | 'max_batches'
  | 'embed_call_failed';

export interface EnrichResult {
  batches: number;
  rowsProcessed: number;
  summariesOk: number;
  summariesFailed: number;
  neuronsUsedInRun: number;
  neuronsUsedToday: number;
  stoppedReason: StoppedReason;
  startedAt: string;
  completedAt: string;
}

const DEFAULT_BATCH_SIZE = 50; // API_PLAN §9 P2
const DEFAULT_MAX_BATCHES = 10;
const SUMMARY_MAX_TOKENS = 512;

interface CandidateRow {
  id: string;
  nombre: string | null;
  objeto: string | null;
  tipo_contrato: string | null;
  modalidad: string | null;
  entidad: string | null;
  ciudad: string | null;
  departamento: string | null;
  precio_base: number | null;
  fecha_recepcion: string | null;
}

function nullStr(v: unknown): string | null {
  return v == null ? null : String(v);
}

async function loadCandidates(turso: Client, limit: number): Promise<CandidateRow[]> {
  const res = await turso.execute({
    sql: `
      SELECT id, nombre, objeto, tipo_contrato, modalidad,
             entidad, ciudad, departamento, precio_base, fecha_recepcion
      FROM tenders
      WHERE embedding IS NULL
      ORDER BY fecha_ultima ASC
      LIMIT ?
    `,
    args: [limit],
  });
  return res.rows.map((r) => ({
    id: String(r['id']),
    nombre: nullStr(r['nombre']),
    objeto: nullStr(r['objeto']),
    tipo_contrato: nullStr(r['tipo_contrato']),
    modalidad: nullStr(r['modalidad']),
    entidad: nullStr(r['entidad']),
    ciudad: nullStr(r['ciudad']),
    departamento: nullStr(r['departamento']),
    precio_base: r['precio_base'] == null ? null : Number(r['precio_base']),
    fecha_recepcion: nullStr(r['fecha_recepcion']),
  }));
}

async function readNeuronsUsed(turso: Client, day: string): Promise<number> {
  const res = await turso.execute({
    sql: 'SELECT neurons_used FROM ai_usage WHERE day = ?',
    args: [day],
  });
  const row = res.rows[0];
  return row == null ? 0 : Number(row['neurons_used'] ?? 0);
}

async function bumpUsage(
  turso: Client,
  day: string,
  delta: { neurons: number; embeds: number; summaries: number },
): Promise<void> {
  await turso.execute({
    sql: `
      INSERT INTO ai_usage (day, neurons_used, embeds_count, summaries_count, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        neurons_used    = ai_usage.neurons_used    + excluded.neurons_used,
        embeds_count    = ai_usage.embeds_count    + excluded.embeds_count,
        summaries_count = ai_usage.summaries_count + excluded.summaries_count,
        updated_at      = excluded.updated_at
    `,
    args: [day, delta.neurons, delta.embeds, delta.summaries, new Date().toISOString()],
  });
}

async function embedBatch(ai: Ai, texts: string[]): Promise<Float32Array[]> {
  const resp = (await ai.run(EMBED_MODEL as never, { text: texts } as never)) as {
    data?: number[][];
  };
  const data = resp.data;
  if (!data || data.length !== texts.length) {
    throw new Error(`bge-m3 batch size mismatch: got ${data?.length ?? 0}, expected ${texts.length}`);
  }
  return data.map((row, idx) => {
    if (row.length !== EMBED_DIM) {
      throw new Error(`bge-m3 dim mismatch at idx ${idx}: got ${row.length}, expected ${EMBED_DIM}`);
    }
    return Float32Array.from(row);
  });
}

async function generateSummary(
  ai: Ai,
  base: ChatMessage[],
): Promise<{ summary: Summary | null; calls: number }> {
  let calls = 0;
  let text1 = '';
  try {
    const resp1 = (await ai.run(SUMMARY_MODEL as never, {
      messages: base,
      max_tokens: SUMMARY_MAX_TOKENS,
      temperature: 0.1,
    } as never)) as { response?: string };
    calls++;
    text1 = resp1.response ?? '';
  } catch {
    return { summary: null, calls };
  }
  const ok1 = parseSummaryJson(text1);
  if (ok1) return { summary: ok1, calls };

  // Single retry with a JSON-only reminder, per API_PLAN §7.
  const retry: ChatMessage[] = [
    ...base,
    { role: 'assistant', content: text1 },
    {
      role: 'user',
      content:
        'Responde SOLO con el objeto JSON especificado. Sin markdown, sin explicación, sin texto adicional.',
    },
  ];
  try {
    const resp2 = (await ai.run(SUMMARY_MODEL as never, {
      messages: retry,
      max_tokens: SUMMARY_MAX_TOKENS,
      temperature: 0,
    } as never)) as { response?: string };
    calls++;
    return { summary: parseSummaryJson(resp2.response ?? ''), calls };
  } catch {
    return { summary: null, calls };
  }
}

export async function enrich(
  turso: Client,
  ai: Ai,
  opts: EnrichOptions = {},
): Promise<EnrichResult> {
  const startedAt = new Date();
  const day = startedAt.toISOString().slice(0, 10);
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxBatches = Math.max(1, opts.maxBatches ?? DEFAULT_MAX_BATCHES);

  let batches = 0;
  let rowsProcessed = 0;
  let summariesOk = 0;
  let summariesFailed = 0;
  let neuronsUsedInRun = 0;
  let stoppedReason: StoppedReason = 'max_batches';

  while (batches < maxBatches) {
    // Re-read usage every batch so concurrent runs cooperate via the shared row.
    const usedAtStart = await readNeuronsUsed(turso, day);
    const remaining = NEURON_DAILY_HARD_STOP - usedAtStart;
    // Worst case: 1 embed call + 2 summary calls per row (initial + retry).
    const worstCaseBatch =
      NEURONS_PER_EMBED_CALL + batchSize * NEURONS_PER_SUMMARY_CALL * 2;
    if (remaining < worstCaseBatch) {
      stoppedReason = 'budget_exhausted';
      break;
    }

    const candidates = await loadCandidates(turso, batchSize);
    if (candidates.length === 0) {
      stoppedReason = 'no_more_rows';
      break;
    }

    const texts = candidates.map((c) =>
      buildEmbedText({
        nombre: c.nombre,
        objeto: c.objeto,
        tipo_contrato: c.tipo_contrato,
        modalidad: c.modalidad,
      }),
    );

    let vectors: Float32Array[];
    try {
      vectors = await embedBatch(ai, texts);
    } catch (err) {
      console.error('enrich:embed:error', err instanceof Error ? err.message : String(err));
      stoppedReason = 'embed_call_failed';
      break;
    }
    let batchNeurons = NEURONS_PER_EMBED_CALL;
    let batchSummaries = 0;
    neuronsUsedInRun += NEURONS_PER_EMBED_CALL;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const vec = vectors[i];
      if (!c || !vec) continue; // unreachable given the size check in embedBatch

      const messages = buildSummaryMessages({
        entidad: c.entidad,
        ciudad: c.ciudad,
        departamento: c.departamento,
        nombre: c.nombre,
        objeto: c.objeto,
        modalidad: c.modalidad,
        tipo_contrato: c.tipo_contrato,
        precio_base: c.precio_base,
        fecha_recepcion: c.fecha_recepcion,
      });

      const { summary, calls } = await generateSummary(ai, messages);
      const summaryNeurons = NEURONS_PER_SUMMARY_CALL * calls;
      batchNeurons += summaryNeurons;
      neuronsUsedInRun += summaryNeurons;
      batchSummaries++;

      if (summary) summariesOk++;
      else {
        summariesFailed++;
        console.warn(`enrich:summary:null id=${c.id}`);
      }

      await turso.execute({
        sql: 'UPDATE tenders SET embedding = ?, summary_es = ?, embedded_at = ? WHERE id = ?',
        args: [
          floatVectorToBlob(vec),
          summary ? JSON.stringify(summary) : null,
          new Date().toISOString(),
          c.id,
        ],
      });

      rowsProcessed++;
    }

    await bumpUsage(turso, day, {
      neurons: batchNeurons,
      embeds: 1,
      summaries: batchSummaries,
    });
    batches++;

    if (candidates.length < batchSize) {
      stoppedReason = 'no_more_rows';
      break;
    }
  }

  const completedAt = new Date();
  const neuronsUsedToday = await readNeuronsUsed(turso, day);

  return {
    batches,
    rowsProcessed,
    summariesOk,
    summariesFailed,
    neuronsUsedInRun,
    neuronsUsedToday,
    stoppedReason,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
  };
}
