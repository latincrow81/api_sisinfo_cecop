// One-shot embed for query strings. Shared by /search and POST /alerts.

import { EMBED_DIM, EMBED_MODEL, floatVectorToBlob } from '@secop/shared';
import { internal } from './errors.js';

export async function embedQuery(ai: Ai, text: string): Promise<Uint8Array> {
  const resp = (await ai.run(EMBED_MODEL as never, { text } as never)) as { data?: number[][] };
  const vec = resp.data?.[0];
  if (!vec || vec.length !== EMBED_DIM) {
    throw internal('embed call returned wrong shape', {
      got: vec?.length ?? 0,
      expected: EMBED_DIM,
    });
  }
  return floatVectorToBlob(vec);
}
