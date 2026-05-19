// Workers AI helpers: text builders + Zod-validated summary schema + parsing.
// The actual `ai.run()` calls live in workers/enrich; this file is pure / testable.

import { z } from 'zod';

export const EMBED_MODEL = '@cf/baai/bge-m3';
export const SUMMARY_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const EMBED_DIM = 1024;
export const EMBED_TEXT_MAX_CHARS = 2000;

// Cloudflare does not return billed neurons in the response, so we plan conservatively
// per call. Tune once the Workers AI dashboard shows real averages.
export const NEURONS_PER_EMBED_CALL = 1; // one call regardless of batch size
export const NEURONS_PER_SUMMARY_CALL = 10;
export const NEURON_DAILY_HARD_STOP = 8000; // 10k CF cap minus 2k headroom (API_PLAN §10)

export const SummarySchema = z.object({
  resumen: z.string().min(1).max(280),
  requisitos_clave: z.array(z.string().min(1)).max(5),
  perfil_proveedor: z.string().min(1),
});
export type Summary = z.infer<typeof SummarySchema>;

export interface EmbedTextSource {
  nombre: string | null;
  objeto: string | null;
  tipo_contrato: string | null;
  modalidad: string | null;
}

// API_PLAN §7: nombre + "\n" + objeto + "\n" + tipo_contrato + " " + modalidad.
// Whitespace collapse + 2k-char truncation to save neurons; bge-m3 handles longer context.
export function buildEmbedText(s: EmbedTextSource): string {
  const tail = [s.tipo_contrato ?? '', s.modalidad ?? ''].map((p) => p.trim()).filter(Boolean).join(' ');
  const parts = [(s.nombre ?? '').trim(), (s.objeto ?? '').trim(), tail].filter((p) => p.length > 0);
  const joined = parts.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return joined.length > EMBED_TEXT_MAX_CHARS ? joined.slice(0, EMBED_TEXT_MAX_CHARS) : joined;
}

export interface SummaryPromptSource {
  entidad: string | null;
  ciudad: string | null;
  departamento: string | null;
  nombre: string | null;
  objeto: string | null;
  modalidad: string | null;
  tipo_contrato: string | null;
  precio_base: number | null;
  fecha_recepcion: string | null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function buildSummaryMessages(s: SummaryPromptSource): ChatMessage[] {
  const system =
    'Eres un analista de contratación pública en Colombia. Devuelve SOLO JSON válido, sin texto fuera del objeto y sin envoltura en bloques de código.';

  const precio = s.precio_base == null ? '?' : `${s.precio_base.toLocaleString('es-CO')} COP`;

  const user = [
    'Resume este proceso de contratación SECOP II para una PYME. Devuelve exactamente este objeto JSON:',
    '{',
    '  "resumen": string (máx 280 caracteres, qué se contrata y para quién),',
    '  "requisitos_clave": string[] (máx 5),',
    '  "perfil_proveedor": string (1 frase: qué tipo de PYME debería ofertar)',
    '}',
    '',
    'Datos:',
    `- Entidad: ${s.entidad ?? '?'} (${s.ciudad ?? '?'}, ${s.departamento ?? '?'})`,
    `- Nombre: ${s.nombre ?? '?'}`,
    `- Objeto: ${s.objeto ?? '?'}`,
    `- Modalidad: ${s.modalidad ?? '?'}`,
    `- Tipo: ${s.tipo_contrato ?? '?'}`,
    `- Precio base: ${precio}`,
    `- Recepción de ofertas hasta: ${s.fecha_recepcion ?? '?'}`,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export const JSON_ONLY_REMINDER: ChatMessage = {
  role: 'user',
  content: 'Responde SOLO con el objeto JSON especificado. Sin markdown, sin explicación, sin texto adicional.',
};

// Tolerates markdown fences and leading/trailing prose. Returns null on parse/validation
// failure so the caller can retry or store null.
export function parseSummaryJson(raw: string): Summary | null {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = SummarySchema.safeParse(parsed);
  return result.success ? result.data : null;
}

// F32 → little-endian Uint8Array view of the underlying buffer (no copy).
// libSQL accepts Uint8Array as BLOB; the F32_BLOB(1024) column rejects wrong-size blobs.
export function floatVectorToBlob(v: number[] | Float32Array): Uint8Array {
  const f32 = v instanceof Float32Array ? v : Float32Array.from(v);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}
