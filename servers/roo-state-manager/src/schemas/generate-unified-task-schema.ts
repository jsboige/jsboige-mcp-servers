/**
 * Generate JSON Schema from Zod UnifiedTaskSchema — #1391
 *
 * Run: npx tsx src/schemas/generate-unified-task-schema.ts
 * Outputs: src/schemas/unified-task.json
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { UnifiedTaskSchema } from '../types/unified-task.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- zod-to-json-schema deep type instantiation
const jsonSchema = zodToJsonSchema(UnifiedTaskSchema as any, {
  name: 'UnifiedTask',
  $refStrategy: 'root',
} as any);

// Enrich with metadata
const enriched = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://roo-extensions.myia.io/schemas/unified-task.json',
  title: 'UnifiedTask',
  description:
    'Unified schema for Roo Code and Claude Code tasks — #1391',
  ...jsonSchema,
};

const outPath = join(__dirname, 'unified-task.json');
writeFileSync(outPath, JSON.stringify(enriched, null, 2) + '\n', 'utf-8');
console.log(`Written: ${outPath}`);
