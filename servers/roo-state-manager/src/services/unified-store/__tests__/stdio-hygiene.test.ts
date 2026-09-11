/**
 * Static guard — UnifiedStore modules must never write to stdout.
 *
 * `roo-state-manager` is served over the MCP **stdio** transport, where stdout
 * is reserved exclusively for JSON-RPC frames. `console.info` / `console.log` /
 * `console.debug` all write to stdout in Node.js (only `console.warn` and
 * `console.error` go to stderr), so a single informational line emitted from a
 * module that is loaded at MCP startup corrupts the stream for a strict client
 * — even when the tool call itself already answered correctly.
 *
 * Observed live: the Zoo Code host reported a non-JSON stdout line
 * `[UnifiedStore] Dual-write ...` right after `conversation_browser` had
 * returned `isError=false` (#2426 follow-up). The runtime fix routed the seven
 * UnifiedStore informational logs to stderr; this test keeps them there.
 *
 * A source scan rather than a behavioural test: the offending calls sit on
 * init/teardown paths that require a live Postgres pool, while the property
 * under test is purely lexical.
 */

import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Recursively collect .ts sources, skipping the __tests__ subtree. */
function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      found.push(...collectSourceFiles(join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

describe('unified-store — stdout hygiene (MCP stdio transport)', () => {
  test('no source module writes to stdout', () => {
    const offenders: string[] = [];

    for (const file of collectSourceFiles(SOURCE_DIR)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/\bconsole\.(log|info|debug)\s*\(/.test(line)) {
            offenders.push(`${file}:${index + 1}`);
          }
        });
    }

    expect(offenders).toEqual([]);
  });

  test('source scan actually sees the modules it guards (not a vacuous pass)', () => {
    const files = collectSourceFiles(SOURCE_DIR);
    expect(files.length).toBeGreaterThan(5);
    expect(files.some(file => file.endsWith('writer-factory.ts'))).toBe(true);
    expect(files.some(file => file.endsWith('PgUnifiedStoreReader.ts'))).toBe(true);
  });
});
