#!/usr/bin/env node

/**
 * Patch pathe@2.0.3 normalizeWindowsPath to handle non-string inputs.
 *
 * Issue: TypeError: input.replace is not a function
 *   at normalizeWindowsPath in pathe/dist/shared/pathe.M-eThtNZ.mjs:17:16
 *
 * Root cause: pathe's normalizeWindowsPath uses `if (!input)` as guard,
 * which passes for truthy non-string values (URL objects, Buffers, etc.).
 * When Node.js V8 coverage or vitest internals pass non-string values,
 * input.replace() fails because replace is a string method.
 *
 * This patch adds a typeof check before the existing guard.
 * Safe to re-run (idempotent). Applied as postinstall hook.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
// npm workspaces hoist dependencies to the workspace root (#4886): the server
// no longer owns a node_modules/ of its own. Look next to the package first
// (standalone install), then at the hoisted root (workspace install).
const nodeModulesRoots = [
  join(root, 'node_modules'),
  join(root, '..', '..', 'node_modules'),
];

const targets = [
  'pathe/dist/shared/pathe.M-eThtNZ.mjs',
  'pathe/dist/shared/pathe.BSlhyZSM.cjs',
  '@vitest/coverage-v8/dist/provider.js',
].map((relative) => {
  const candidates = nodeModulesRoots.map((base) => join(base, relative));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
});

const oldPattern = 'function normalizeWindowsPath(input = "") {\n  if (!input) {';
const newPattern = 'function normalizeWindowsPath(input = "") {\n  if (typeof input !== "string") { input = String(input == null ? "" : input); }\n  if (!input) {';

let patched = 0;
let skipped = 0;

for (const filePath of targets) {
  try {
    let content = readFileSync(filePath, 'utf8');
    if (content.includes('typeof input !== "string"')) {
      console.log(`[pathe-patch] Already patched: ${filePath}`);
      skipped++;
      continue;
    }
    if (!content.includes(oldPattern)) {
      console.log(`[pathe-patch] Pattern not found (version changed?): ${filePath}`);
      skipped++;
      continue;
    }
    content = content.replace(oldPattern, newPattern);
    writeFileSync(filePath, content, 'utf8');
    console.log(`[pathe-patch] Patched: ${filePath}`);
    patched++;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`[pathe-patch] File not found (skipping): ${filePath}`);
      skipped++;
    } else {
      console.error(`[pathe-patch] Error patching ${filePath}:`, err.message);
      process.exitCode = 1;
    }
  }
}

console.log(`[pathe-patch] Done: ${patched} patched, ${skipped} skipped`);
