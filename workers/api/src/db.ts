// libsql row → API shape mappers. Keeps SQL column names in one place and turns
// summary_es (TEXT containing JSON) into a parsed object.

import { Summary, type Tender, type SearchHit } from './schemas.js';

type Row = Record<string, unknown>;

function s(v: unknown): string | null {
  return v == null ? null : String(v);
}

function n(v: unknown): number | null {
  if (v == null) return null;
  const num = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(num) ? num : null;
}

function parseSummary(raw: unknown): Tender['summary'] {
  if (raw == null) return null;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = Summary.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function rowToTender(r: Row): Tender {
  return {
    id: String(r['id']),
    entidad: s(r['entidad']),
    nit_entidad: s(r['nit_entidad']),
    departamento: s(r['departamento']),
    ciudad: s(r['ciudad']),
    objeto: s(r['objeto']),
    nombre: s(r['nombre']),
    unspsc: s(r['unspsc']),
    unspsc_segment: s(r['unspsc_segment']),
    modalidad: s(r['modalidad']),
    tipo_contrato: s(r['tipo_contrato']),
    subtipo_contrato: s(r['subtipo_contrato']),
    precio_base: n(r['precio_base']),
    estado: s(r['estado']),
    fase: s(r['fase']),
    fecha_publicacion: s(r['fecha_publicacion']),
    fecha_ultima: s(r['fecha_ultima']),
    fecha_recepcion: s(r['fecha_recepcion']),
    url: s(r['url']),
    summary: parseSummary(r['summary_es']),
  };
}

export function rowToSearchHit(r: Row): SearchHit {
  const score = n(r['score']);
  return {
    ...rowToTender(r),
    score: score ?? 0,
  };
}

// Column list for SELECTs that hit the Tender mapper. Excludes embedding (large blob)
// and uses an explicit list so adding columns to `tenders` doesn't accidentally widen
// API responses. Pass an alias when joining (e.g. against vector_top_k) to avoid
// `ambiguous column name: id` against `knn.id`.
const TENDER_COLUMN_NAMES = [
  'id', 'entidad', 'nit_entidad', 'departamento', 'ciudad',
  'objeto', 'nombre', 'unspsc', 'unspsc_segment',
  'modalidad', 'tipo_contrato', 'subtipo_contrato',
  'precio_base', 'estado', 'fase',
  'fecha_publicacion', 'fecha_ultima', 'fecha_recepcion',
  'url', 'summary_es',
] as const;

export function tenderColumns(alias?: string): string {
  const prefix = alias ? `${alias}.` : '';
  return TENDER_COLUMN_NAMES.map((c) => `${prefix}${c}`).join(', ');
}

export const TENDER_COLUMNS = tenderColumns();
