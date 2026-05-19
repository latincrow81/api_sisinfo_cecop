#!/usr/bin/env tsx
// Generates openapi.yaml from the Zod schemas. Run via `npm run openapi:generate`.
//
// Builds a bare OpenAPIHono app, registers the same routes the worker uses, and
// serializes the resulting OpenAPI 3.1 document to YAML.

import { OpenAPIHono } from '@hono/zod-openapi';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stringify } from 'yaml';
import { buildOpenApiDocument } from '../workers/api/src/openapi.js';
import { registerRoutes } from '../workers/api/src/routes.js';
import type { ApiBindings, ApiVariables } from '../workers/api/src/types.js';

const app = new OpenAPIHono<{ Bindings: ApiBindings; Variables: ApiVariables }>();
registerRoutes(app);
const doc = buildOpenApiDocument(app);

const outPath = resolve(process.argv[2] ?? 'openapi.yaml');
writeFileSync(outPath, stringify(doc));
console.log(`wrote ${outPath}`);
