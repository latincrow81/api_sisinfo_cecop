// libSQL/Turso client factory. Uses the Web build so it works inside Cloudflare Workers
// (raw TCP is not available; the Web build talks HTTP over fetch).
import { createClient } from '@libsql/client/web';
export function turso(env) {
    if (!env.TURSO_URL)
        throw new Error('TURSO_URL is not set');
    if (!env.TURSO_TOKEN)
        throw new Error('TURSO_TOKEN is not set');
    return createClient({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN });
}
