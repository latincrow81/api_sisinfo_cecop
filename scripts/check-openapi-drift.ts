#!/usr/bin/env tsx
// Verifies the committed openapi.yaml matches what the Zod schemas would produce.
// Used in CI to fail builds when the contract diverges from the source schemas.

import { OpenAPIHono } from '@hono/zod-openapi';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { buildOpenApiDocument } from '../workers/api/src/openapi.js';
import { registerRoutes } from '../workers/api/src/routes.js';
import type { ApiBindings, ApiVariables } from '../workers/api/src/types.js';

const committedPath = resolve('openapi.yaml');
const committed = readFileSync(committedPath, 'utf8');

const app = new OpenAPIHono<{ Bindings: ApiBindings; Variables: ApiVariables }>();
registerRoutes(app);
const generated = stringify(buildOpenApiDocument(app));

if (committed === generated) {
  console.log(`openapi.yaml is in sync with schemas`);
  process.exit(0);
}

console.error('openapi.yaml is out of sync with schemas in workers/api/src/schemas.ts.');
console.error('Run `npm run openapi:generate` and commit the updated file.');

// Tiny diff hint — show the first few diverging lines without pulling in a diff lib.
const a = committed.split('\n');
const b = generated.split('\n');
const len = Math.max(a.length, b.length);
let shown = 0;
for (let i = 0; i < len && shown < 10; i++) {
  if (a[i] !== b[i]) {
    console.error(`  line ${i + 1}:`);
    console.error(`    committed: ${a[i] ?? '<eof>'}`);
    console.error(`    generated: ${b[i] ?? '<eof>'}`);
    shown++;
  }
}
process.exit(1);
