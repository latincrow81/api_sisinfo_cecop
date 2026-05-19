export declare const DATASET_ID = "p6dx-8zbt";
export declare const SOCRATA_BASE = "https://www.datos.gov.co/resource";
export interface SocrataAuth {
    appToken?: string | undefined;
}
export interface SocrataPageOptions {
    where: string;
    order?: string;
    limit?: number;
    offset?: number;
}
export declare const DEFAULT_PAGE_SIZE = 1000;
export declare const DEFAULT_ORDER = "fecha_de_ultima_publicaci ASC";
export declare function fetchPage<T = unknown>(opts: SocrataPageOptions, auth?: SocrataAuth): Promise<T[]>;
export interface BuildWhereOpts {
    watermark: string | null;
}
export declare function buildOpenTendersWhere({ watermark }: BuildWhereOpts): string;
