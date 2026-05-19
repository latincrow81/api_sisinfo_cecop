import { type Client } from '@libsql/client/web';
export type { Client };
export interface TursoEnv {
    TURSO_URL: string;
    TURSO_TOKEN: string;
}
export declare function turso(env: Partial<TursoEnv>): Client;
