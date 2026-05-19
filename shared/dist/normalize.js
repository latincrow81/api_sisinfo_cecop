// Maps a raw Socrata row (dataset p6dx-8zbt) to the `tenders` columns.
// Field names that are gotchas per API_PLAN §2 are authoritative:
//   descripci_n_del_procedimiento, fecha_de_ultima_publicaci, urlproceso (URL object).
// Non-gotcha names below are standard SECOP II conventions; if any prove wrong on the
// first live run, edit the FIELD_MAP comment block only — the rest stays stable.
function str(v) {
    if (v === undefined || v === null)
        return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
}
function num(v) {
    if (v === undefined || v === null || v === '')
        return null;
    const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
}
function flattenUrl(v) {
    if (!v)
        return null;
    if (typeof v === 'string')
        return v.length > 0 ? v : null;
    return v.url && v.url.length > 0 ? v.url : null;
}
export function normalizeTender(row, ingestedAt) {
    const id = str(row.id_del_proceso);
    if (!id)
        return null;
    return {
        id,
        entidad: str(row.entidad),
        nit_entidad: str(row.nit_entidad),
        departamento: str(row.departamento_entidad),
        ciudad: str(row.ciudad_entidad),
        objeto: str(row.descripci_n_del_procedimiento),
        nombre: str(row.nombre_del_procedimiento),
        unspsc: str(row.codigo_principal_de_categoria),
        modalidad: str(row.modalidad_de_contratacion),
        tipo_contrato: str(row.tipo_de_contrato),
        subtipo_contrato: str(row.subtipo_de_contrato),
        precio_base: num(row.precio_base),
        estado: str(row.estado_del_procedimiento),
        fase: str(row.fase),
        fecha_publicacion: str(row.fecha_de_publicacion_del),
        fecha_ultima: str(row.fecha_de_ultima_publicaci),
        fecha_recepcion: str(row.fecha_de_recepcion_de),
        url: flattenUrl(row.urlproceso),
        ingested_at: ingestedAt,
    };
}
