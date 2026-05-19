// libSQL/Turso client factory. Uses the Web build so it works inside Cloudflare Workers
// (raw TCP is not available; the Web build talks HTTP over fetch).

import { createClient, type Client } from '@libsql/client/web';

export type { Client };

export interface TursoEnv {
  TURSO_URL: string;
  TURSO_TOKEN: string;
}

export function turso(env: Partial<TursoEnv>): Client {
  if (!env.TURSO_URL) throw new Error('TURSO_URL is not set');
  if (!env.TURSO_TOKEN) throw new Error('TURSO_TOKEN is not set');
  return createClient({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN });
}
