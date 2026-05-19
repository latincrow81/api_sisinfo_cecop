// Socrata paged client for datos.gov.co dataset p6dx-8zbt.
// Auth is optional (X-App-Token); requests are rate-limited more aggressively without it.

export const DATASET_ID = 'p6dx-8zbt';
export const SOCRATA_BASE = 'https://www.datos.gov.co/resource';

export interface SocrataAuth {
  appToken?: string | undefined;
}

export interface SocrataPageOptions {
  where: string;
  order?: string;
  limit?: number;
  offset?: number;
}

export const DEFAULT_PAGE_SIZE = 1000;
export const DEFAULT_ORDER = 'fecha_de_ultima_publicaci ASC';

export async function fetchPage<T = unknown>(
  opts: SocrataPageOptions,
  auth: SocrataAuth = {},
): Promise<T[]> {
  const params = new URLSearchParams({
    $where: opts.where,
    $order: opts.order ?? DEFAULT_ORDER,
    $limit: String(opts.limit ?? DEFAULT_PAGE_SIZE),
    $offset: String(opts.offset ?? 0),
  });
  const url = `${SOCRATA_BASE}/${DATASET_ID}.json?${params.toString()}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (auth.appToken) headers['X-App-Token'] = auth.appToken;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Socrata ${res.status} ${res.statusText} ${url}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T[];
}

export interface BuildWhereOpts {
  watermark: string | null;
}

// Composes the "open and SME-relevant" predicate (API_PLAN §2). The watermark filter is
// included only when present so first runs scan the full open set without skipping rows
// older than NULL.
export function buildOpenTendersWhere({ watermark }: BuildWhereOpts): string {
  const clauses = [`estado_del_procedimiento='Publicado'`, `fecha_de_recepcion_de > now()`];
  if (watermark) {
    // Watermark comes from our own DB so it is trusted; still strip single quotes defensively.
    const safe = watermark.replace(/'/g, '');
    clauses.unshift(`fecha_de_ultima_publicaci > '${safe}'`);
  }
  return clauses.join(' AND ');
}
