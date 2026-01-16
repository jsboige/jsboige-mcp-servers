/**
 * Configuration Vitest pour les tests E2E sur machines réelles
 *
 * Cette configuration NE DOIT PAS inclure les setups qui contiennent des mocks
 * car nous voulons tester les outils RooSync sur des machines réelles.
 *
 * @module vitest.config.real-machines
 */

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Globals pour avoir describe, it, expect disponibles sans import
    globals: true,

    // Environnement Node.js (comme Jest)
    environment: 'node',

    // Patterns de tests - SEULEMENT les tests sur machines réelles
    include: [
      'tests/e2e/roosync-real-machines.test.ts',
      'tests/e2e/roosync-real-machines.test.js'
    ],

    // Exclusions
    exclude: [
      'node_modules',
      'build',
      'dist',
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**'
    ],

    // Setup files - SEULEMENT setup-real-machines (SANS mocks)
    setupFiles: ['./tests/e2e/setup-real-machines.ts'],

    // Timeout plus long pour les tests sur machines réelles
    testTimeout: 120000, // 2 minutes
    hookTimeout: 30000,

    // Pool configuration - utiliser 'forks' avec un seul worker
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true
      }
    },

    // PAS de mocks pour les tests sur machines réelles
    clearMocks: false,
    restoreMocks: false,
    mockReset: false,

    // Reporters
    reporters: ['default']
  },

  // Résolution des modules
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // Permettre l'import de .js qui résolvent vers .ts (compatibilité ESM)
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json']
  }
});
