import { z } from 'zod';
export declare const EMBED_MODEL = "@cf/baai/bge-m3";
export declare const SUMMARY_MODEL = "@cf/meta/llama-3.1-8b-instruct";
export declare const EMBED_DIM = 1024;
export declare const EMBED_TEXT_MAX_CHARS = 2000;
export declare const NEURONS_PER_EMBED_CALL = 1;
export declare const NEURONS_PER_SUMMARY_CALL = 10;
export declare const NEURON_DAILY_HARD_STOP = 8000;
export declare const SummarySchema: z.ZodObject<{
    resumen: z.ZodString;
    requisitos_clave: z.ZodArray<z.ZodString, "many">;
    perfil_proveedor: z.ZodString;
}, "strip", z.ZodTypeAny, {
    resumen: string;
    requisitos_clave: string[];
    perfil_proveedor: string;
}, {
    resumen: string;
    requisitos_clave: string[];
    perfil_proveedor: string;
}>;
export type Summary = z.infer<typeof SummarySchema>;
export interface EmbedTextSource {
    nombre: string | null;
    objeto: string | null;
    tipo_contrato: string | null;
    modalidad: string | null;
}
export declare function buildEmbedText(s: EmbedTextSource): string;
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
export declare function buildSummaryMessages(s: SummaryPromptSource): ChatMessage[];
export declare const JSON_ONLY_REMINDER: ChatMessage;
export declare function parseSummaryJson(raw: string): Summary | null;
export declare function floatVectorToBlob(v: number[] | Float32Array): Uint8Array;
