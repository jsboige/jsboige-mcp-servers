/**
 * Minimal Vitest configuration for Roo schedulers (LLM-constrained).
 *
 * CRITICAL FIX #827: Reduces output to prevent context saturation
 * - Default output: 262145 tokens (OVERFLOW)
 * - Minimal output: ~1000-2000 lines (fits in context)
 *
 * Usage: npx vitest run --config vitest.config.minimal.ts
 *
 * Use ONLY for Roo scheduler workflows where output is consumed by LLMs.
 * For normal development, use vitest.config.ts or vitest.config.ci.ts.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(baseConfig, defineConfig({
  test: {
    // Minimal reporter format (Vitest v3+)
    // Replaces deprecated 'basic' reporter
    reporters: [
      ['default', { summary: false }]
    ],

    // Disable coverage (not needed for scheduler validation)
    coverage: {
      enabled: false
    },

    // Reduce parallelism for more predictable output
    poolOptions: {
      forks: {
        maxForks: 1
      }
    },

    // Standard timeout (some tests need >10s)
    testTimeout: 15000,
    hookTimeout: 20000,
  },
}));
