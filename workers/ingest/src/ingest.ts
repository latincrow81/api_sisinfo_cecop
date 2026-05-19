// Single ingest cycle: paged Socrata pull → gzip raw to R2 → upsert into Turso → advance
// watermark. The where-clause is computed ONCE at the start of the run so pagination is
// stable; any rows added during the run will be caught next time.

import {
  buildOpenTendersWhere,
  DATASET_ID,
  DEFAULT_ORDER,
  DEFAULT_PAGE_SIZE,
  fetchPage,
  normalizeTender,
  type Client,
  type NormalizedTender,
  type RawSocrataTender,
} from '@secop/shared';

const MAX_PAGES_PER_RUN = 50; // 50_000-row safety cap. Open set is ~2.2k per API_PLAN §2.

export interface IngestEnv {
  RAW: R2Bucket;
  SOCRATA_APP_TOKEN?: string | undefined;
}

export interface IngestOptions {
  // If undefined: read watermark from DB. If null: ignore watermark (full backfill of
  // currently-open set). If string: use as watermark override.
  since?: string | null | undefined;
  pageSize?: number;
  maxPages?: number;
}

export interface IngestResult {
  runId: string;
  pages: number;
  rowsFetched: number;
  rowsUpserted: number;
  watermarkUsed: string | null;
  newWatermark: string | null;
  startedAt: string;
  completedAt: string;
}

const UPSERT_SQL = `
INSERT INTO tenders (
  id, entidad, nit_entidad, departamento, ciudad,
  objeto, nombre, unspsc,
  modalidad, tipo_contrato, subtipo_contrato,
  precio_base, estado, fase,
  fecha_publicacion, fecha_ultima, fecha_recepcion,
  url, ingested_at
) VALUES (
  :id, :entidad, :nit_entidad, :departamento, :ciudad,
  :objeto, :nombre, :unspsc,
  :modalidad, :tipo_contrato, :subtipo_contrato,
  :precio_base, :estado, :fase,
  :fecha_publicacion, :fecha_ultima, :fecha_recepcion,
  :url, :ingested_at
)
ON CONFLICT(id) DO UPDATE SET
  entidad           = excluded.entidad,
  nit_entidad       = excluded.nit_entidad,
  departamento      = excluded.departamento,
  ciudad            = excluded.ciudad,
  objeto            = excluded.objeto,
  nombre            = excluded.nombre,
  unspsc            = excluded.unspsc,
  modalidad         = excluded.modalidad,
  tipo_contrato     = excluded.tipo_contrato,
  subtipo_contrato  = excluded.subtipo_contrato,
  precio_base       = excluded.precio_base,
  estado            = excluded.estado,
  fase              = excluded.fase,
  fecha_publicacion = excluded.fecha_publicacion,
  fecha_ultima      = excluded.fecha_ultima,
  fecha_recepcion   = excluded.fecha_recepcion,
  url               = excluded.url,
  ingested_at       = excluded.ingested_at,
  -- If the row truly changed (fecha_ultima moved), invalidate AI artifacts so the enrich
  -- worker re-processes it. Unchanged re-pulls (idempotent re-runs) keep the existing
  -- embedding/summary so neuron budget is preserved.
  embedding   = CASE WHEN tenders.fecha_ultima IS excluded.fecha_ultima THEN tenders.embedding   ELSE NULL END,
  summary_es  = CASE WHEN tenders.fecha_ultima IS excluded.fecha_ultima THEN tenders.summary_es  ELSE NULL END,
  embedded_at = CASE WHEN tenders.fecha_ultima IS excluded.fecha_ultima THEN tenders.embedded_at ELSE NULL END
`;

async function readWatermark(turso: Client): Promise<string | null> {
  const res = await turso.execute({
    sql: 'SELECT last_fecha_ultima FROM watermark WHERE dataset = ?',
    args: [DATASET_ID],
  });
  const row = res.rows[0];
  if (!row) return null;
  const v = row['last_fecha_ultima'];
  return v == null ? null : String(v);
}

async function writeWatermark(
  turso: Client,
  value: string | null,
  rows: number,
  runAt: string,
): Promise<void> {
  await turso.execute({
    sql: 'UPDATE watermark SET last_fecha_ultima = COALESCE(?, last_fecha_ultima), last_run_at = ?, last_run_rows = ? WHERE dataset = ?',
    args: [value, runAt, rows, DATASET_ID],
  });
}

async function gzipJson(rows: unknown): Promise<Uint8Array> {
  const payload = new TextEncoder().encode(JSON.stringify(rows));
  const stream = new Blob([payload]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dtPath(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function runId(d: Date): string {
  return `${d.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function ingest(
  turso: Client,
  env: IngestEnv,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const startedAt = new Date();
  const runIdStr = runId(startedAt);
  const dt = dtPath(startedAt);
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? MAX_PAGES_PER_RUN;

  const watermarkUsed = opts.since !== undefined ? opts.since : await readWatermark(turso);

  // Fixed for the whole run so $offset pagination is stable.
  const where = buildOpenTendersWhere({ watermark: watermarkUsed });

  let pages = 0;
  let offset = 0;
  let rowsFetched = 0;
  let rowsUpserted = 0;
  let newWatermark: string | null = watermarkUsed;

  for (; pages < maxPages; pages++) {
    const raw = await fetchPage<RawSocrataTender>(
      { where, order: DEFAULT_ORDER, limit: pageSize, offset },
      { appToken: env.SOCRATA_APP_TOKEN },
    );
    if (raw.length === 0) break;

    // R2 audit lands before any DB mutation so we can always replay a run from raw.
    const gz = await gzipJson(raw);
    await env.RAW.put(
      `raw/dt=${dt}/${runIdStr}-${String(pages).padStart(4, '0')}.json.gz`,
      gz,
      {
        httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
      },
    );

    const ingestedAt = new Date().toISOString();
    const normalized: NormalizedTender[] = [];
    for (const row of raw) {
      const n = normalizeTender(row, ingestedAt);
      if (n) normalized.push(n);
    }

    if (normalized.length > 0) {
      await turso.batch(
        normalized.map((n) => ({
          sql: UPSERT_SQL,
          args: {
            id: n.id,
            entidad: n.entidad,
            nit_entidad: n.nit_entidad,
            departamento: n.departamento,
            ciudad: n.ciudad,
            objeto: n.objeto,
            nombre: n.nombre,
            unspsc: n.unspsc,
            modalidad: n.modalidad,
            tipo_contrato: n.tipo_contrato,
            subtipo_contrato: n.subtipo_contrato,
            precio_base: n.precio_base,
            estado: n.estado,
            fase: n.fase,
            fecha_publicacion: n.fecha_publicacion,
            fecha_ultima: n.fecha_ultima,
            fecha_recepcion: n.fecha_recepcion,
            url: n.url,
            ingested_at: n.ingested_at,
          },
        })),
        'write',
      );
      rowsUpserted += normalized.length;

      for (const n of normalized) {
        if (n.fecha_ultima && (!newWatermark || n.fecha_ultima > newWatermark)) {
          newWatermark = n.fecha_ultima;
        }
      }
    }

    rowsFetched += raw.length;
    if (raw.length < pageSize) break;
    offset += raw.length;
  }

  const completedAt = new Date();
  await writeWatermark(
    turso,
    newWatermark !== watermarkUsed ? newWatermark : null,
    rowsFetched,
    completedAt.toISOString(),
  );

  return {
    runId: runIdStr,
    pages,
    rowsFetched,
    rowsUpserted,
    watermarkUsed,
    newWatermark,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
  };
}
