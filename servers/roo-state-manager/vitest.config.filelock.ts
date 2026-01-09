/**
 * Configuration Vitest spécifique pour les tests FileLockManager
 *
 * Cette configuration désactive le mock global de fs pour permettre
 * à proper-lockfile d'accéder au vrai système de fichiers.
 *
 * @module vitest.config.filelock
 * @version 1.0.0
 */

import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Utiliser le vrai système de fichiers pour ces tests
    setupFiles: [],
    // Ne pas utiliser le setup global qui mock fs
    globals: true,
    environment: 'node',
    // Timeout plus long pour les tests de concurrence
    testTimeout: 30000,
    // Configuration des alias
    alias: {
      '@': path.resolve(__dirname, './src')
    },
    // Désactiver le mock de fs pour ces tests
    deps: {
      interopDefault: true
    },
    // Configuration de la couverture
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/dist/',
        '**/build/'
      ]
    }
  }
});
