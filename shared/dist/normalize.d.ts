export interface RawSocrataTender {
    id_del_proceso?: string;
    entidad?: string;
    nit_entidad?: string;
    departamento_entidad?: string;
    ciudad_entidad?: string;
    descripci_n_del_procedimiento?: string;
    nombre_del_procedimiento?: string;
    codigo_principal_de_categoria?: string;
    modalidad_de_contratacion?: string;
    tipo_de_contrato?: string;
    subtipo_de_contrato?: string;
    precio_base?: string | number;
    estado_del_procedimiento?: string;
    fase?: string;
    fecha_de_publicacion_del?: string;
    fecha_de_ultima_publicaci?: string;
    fecha_de_recepcion_de?: string;
    urlproceso?: {
        url?: string;
    } | string;
    [k: string]: unknown;
}
export interface NormalizedTender {
    id: string;
    entidad: string | null;
    nit_entidad: string | null;
    departamento: string | null;
    ciudad: string | null;
    objeto: string | null;
    nombre: string | null;
    unspsc: string | null;
    modalidad: string | null;
    tipo_contrato: string | null;
    subtipo_contrato: string | null;
    precio_base: number | null;
    estado: string | null;
    fase: string | null;
    fecha_publicacion: string | null;
    fecha_ultima: string | null;
    fecha_recepcion: string | null;
    url: string | null;
    ingested_at: string;
}
export declare function normalizeTender(row: RawSocrataTender, ingestedAt: string): NormalizedTender | null;
