/**
 * setup-eval-harness.ts — Real-environment setup for the eval harness.
 *
 * CRITICAL RULES (see Epic #2609 design):
 * 1. NEVER loads jest.setup.js — that file mocks openai + @qdrant/js-client-rest,
 *    which would produce false-green results (#637 false-green regression).
 * 2. Explicitly unmocks openai and @qdrant/js-client-rest (defensive).
 * 3. Loads the SAME .env the production server loads (src/index.ts:41 pattern).
 * 4. HARD precondition: abort entire run if UNIFIED_STORE_DUAL_WRITE !== '1'
 *    or UNIFIED_STORE_PG_URL is not set — these are required for the #637 detection.
 * 5. Resets singletons so they pick up real env vars (not stale test-mode values).
 *
 * @issue Epic #2609 V1
 */

import { vi } from 'vitest';
import * as dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---- 1. Defensive unmock ----
// These unmocks are no-ops if jest.setup.js was NOT loaded (which is correct —
// this config never loads it), but they guard against any accidental auto-mock.
vi.unmock('openai');
vi.unmock('@qdrant/js-client-rest');

// ---- 2. Load .env from package root (mirrors src/index.ts:41) ----
// src/index.ts uses: path.join(__dirname, '..', '.env')
// __dirname in build/ → one level up = package root
// We replicate this: tests/eval-harness/ → up 3 levels = package root
const __filename = fileURLToPath(import.meta.url);
const __dirname_here = dirname(__filename);
const pkgRoot = resolve(__dirname_here, '..', '..'); // tests/eval-harness → roo-state-manager
const envPath = resolve(pkgRoot, '.env');

const result = dotenv.config({ path: envPath, override: true });
if (result.error) {
  // .env missing is allowed (CI without secrets), but we'll catch it below
  console.warn(`[eval-harness] dotenv.config warning: ${result.error.message}`);
}

// ---- 3. HARD precondition: required env vars ----
const REQUIRED_VARS = [
  'QDRANT_URL',
  'QDRANT_API_KEY',
  'QDRANT_COLLECTION_NAME',
  'EMBEDDING_API_KEY',
  'EMBEDDING_API_BASE_URL',
  'EMBEDDING_MODEL',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_PG_URL',
] as const;

const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
if (missing.length > 0) {
  throw new Error(
    `[eval-harness] HARD PRECONDITION FAILED — missing required env vars: ${missing.join(', ')}.\n` +
      `Checked .env at: ${envPath}\n` +
      `Ensure all variables are set before running the eval harness.\n` +
      `These are NOT test stubs — they must point to real services.`
  );
}

// The most critical precondition: dual-write must be ON for the #637 detector to work.
if (process.env.UNIFIED_STORE_DUAL_WRITE !== '1') {
  throw new Error(
    `[eval-harness] HARD PRECONDITION FAILED — UNIFIED_STORE_DUAL_WRITE must be "1" ` +
      `(currently: "${process.env.UNIFIED_STORE_DUAL_WRITE}").\n` +
      `The #637 JOIN-gating detector requires the unified store to be active.\n` +
      `Set UNIFIED_STORE_DUAL_WRITE=1 in .env and ensure UNIFIED_STORE_PG_URL is set.`
  );
}

// ---- 4. Reset singletons so they pick up real env vars ----
// Import after dotenv.config so the modules see the real values.
// Using dynamic import to ensure env is set before module initialization.
import('../../src/services/unified-store/reader-factory.js').then(({ resetReaderInstance }) => {
  resetReaderInstance();
});

import('../../src/services/qdrant.js').then(({ resetQdrantClient }) => {
  resetQdrantClient();
});

console.log(
  `[eval-harness] Setup complete. Qdrant=${process.env.QDRANT_URL} ` +
    `Collection=${process.env.QDRANT_COLLECTION_NAME} ` +
    `Model=${process.env.EMBEDDING_MODEL} ` +
    `DualWrite=${process.env.UNIFIED_STORE_DUAL_WRITE}`
);
