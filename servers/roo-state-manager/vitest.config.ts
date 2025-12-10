import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Globals pour avoir describe, it, expect disponibles sans import
    globals: true,

    // Environnement Node.js (comme Jest)
    environment: 'node',

    // Patterns de tests (équivalent à testMatch de Jest)
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.js',
      'tests/integration/**/*.test.ts',
      'tests/integration/**/*.test.js',
      'tests/performance/**/*.test.ts',
      'tests/performance/**/*.test.js',
      'tests/e2e/**/*.test.ts',
      'tests/e2e/**/*.test.js',
      'src/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test.js'
    ],

    // Exclusions (équivalent à testPathIgnorePatterns)
    exclude: [
      'node_modules',
      'build',
      'dist',
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**',
      // Fichiers causant des boucles infinies ou timeouts (scan massif de 3870+ tâches)
      'tests/unit/parent-child-validation.test.ts',
      'tests/unit/skeleton-cache-reconstruction.test.ts',
      'tests/unit/workspace-filtering-diagnosis.test.ts',
      'tests/integration/hierarchy-real-data.test.ts',
      'tests/integration/integration.test.ts'
    ],

    // Setup files (équivalent à setupFilesAfterEnv)
    setupFiles: ['./tests/setup-env.ts', './tests/setup/jest.setup.js'],

    // Global setup (création du stockage temporaire)
    // Note: Dans Vitest v3, globalSetup retourne une fonction de teardown
    globalSetup: './tests/config/globalSetup.ts',

    // Timeout (30 secondes comme Jest)
    testTimeout: 15000,
    hookTimeout: 30000,

    // Pool configuration - utiliser 'forks' avec un seul worker
    // (équivalent à maxWorkers: 1 de Jest pour éviter les problèmes de mémoire)
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: Math.max(1, 4)  // Utiliser 4 threads fixes pour éviter le require('os')
      }
    },

    // Mocks
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/',
        'build/',
        'dist/',
        'tests/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData/',
        'coverage/**',
        '**/__tests__/**',
        '**/vitest-migration/**'
      ],
      // Seuils de couverture (optionnel) - syntaxe Vitest v3
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 50,
        statements: 50
      }
    },

    // Isolate pour éviter les fuites entre tests
    isolate: true,

    // Reporters
    reporters: ['default']
  },

  // Résolution des modules (équivalent à moduleNameMapper)
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // Permettre l'import de .js qui résolvent vers .ts (compatibilité ESM)
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json']
  }
});
