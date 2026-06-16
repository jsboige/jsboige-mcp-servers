/**
 * vitest.config.eval-harness.ts — Eval harness configuration.
 *
 * CRITICAL RULES:
 * 1. setupFiles MUST NOT include jest.setup.js — that file mocks openai +
 *    @qdrant/js-client-rest, producing false-green results (#637 regression).
 * 2. include ONLY the eval-harness test files (*.eval.test.ts).
 * 3. clearMocks/restoreMocks/mockReset all false — we need real singletons.
 * 4. pool:'forks' + singleFork:true — isolates from unit test workers.
 *
 * Usage: npx vitest run --config vitest.config.eval-harness.ts
 * Or:    npm run eval:harness
 *
 * @issue Epic #2609 V1
 */

import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  test: {
    // Globals for describe/it/expect without imports
    globals: true,

    // Node environment
    environment: 'node',

    // ONLY the eval harness test files
    include: ['tests/eval-harness/**/*.eval.test.ts'],

    // Exclude everything else
    exclude: [
      'node_modules',
      'build',
      'dist',
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**',
    ],

    // CRITICAL: setup-eval-harness.ts ONLY — NEVER jest.setup.js
    // jest.setup.js mocks openai + @qdrant/js-client-rest → false-green (#637)
    setupFiles: ['./tests/eval-harness/setup-eval-harness.ts'],

    // Long timeout for live service calls (2 minutes per test)
    testTimeout: 120000,
    hookTimeout: 60000,

    // forks pool with single fork — isolates from unit test workers
    // ensures singletons are not shared across parallel workers
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },

    // CRITICAL: do NOT mock/restore/reset between tests
    // We need real singletons with real env vars
    clearMocks: false,
    restoreMocks: false,
    mockReset: false,

    // Reporters
    reporters: ['default'],

    // Allow TS extension imports (same as unit config)
    allowImportingTsExtensions: true,
  },

  // Module resolution
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
});
