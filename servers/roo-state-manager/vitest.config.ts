import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

// Obtenir le chemin du fichier courant (ESM)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    allowImportingTsExtensions: true,
    exclude: [
      'node_modules',
      'build',
      'dist',
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**',
      // Backups vitest-migration - anciennes sauvegardes à ne pas exécuter
      // Chemin: vitest-migration/backups/tests-DATE/heures/tests/
      // IMPORTANT: Exclure avant que include ne les matche
      '**/backups/**',
      '**/vitest-migration/backups/**',
      'vitest-migration/backups/**',
      // Fichiers causant des boucles infinies ou timeouts (scan massif de 3870+ tâches)
      'tests/unit/parent-child-validation.test.ts',
      'tests/unit/skeleton-cache-reconstruction.test.ts',
      'tests/unit/workspace-filtering-diagnosis.test.ts',
      'tests/integration/hierarchy-real-data.test.ts',
      'tests/integration/integration.test.ts',
      // Issue #307: FileLockManager échoue en mode threads à cause de proper-lockfile
      // Cause: proper-lockfile cache mtime dans Symbol partagé entre threads
      // Exclure tous les tests FileLockManager et PresenceManager sur Windows
      'tests/unit/services/roosync/FileLockManager.test.ts',
      'tests/unit/services/roosync/FileLockManager.simple.test.ts',
      'tests/unit/services/roosync/FileLockManager.diagnostic.test.ts',
      'tests/unit/services/roosync/PresenceManager.integration.test.ts'
    ],
    // Setup files (équivalent à setupFilesAfterEnv)
    setupFiles: ['./tests/setup-env.ts', './tests/setup/jest.setup.js', './tests/setup/filelock.setup.js'],
    // Global setup (création du stockage temporaire)
    globalSetup: './tests/config/globalSetup.ts',
    // Timeout pour environnement de développement (30 secondes comme Jest)
    testTimeout: 15000,
    hookTimeout: 30000,

    // Pool configuration - forks is faster for isolated tests with heavy setup
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4
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

  // Configuration CI (exclut les tests platform-dependants)
  ci: {
    // Sélection automatique si CI=true dans l'environnement
    ...(process.env.CI === 'true' ? {
      // Exclure les tests qui dépendent de l'environnement Windows
      exclude: [
        'tests/unit/services/roosync/FileLockManager.test.ts',
        'tests/unit/services/roosync/PresenceManager.test.ts',
        'tests/integration/file-lock-manager-integration.test.ts'
      ]
    } : {}),

    // Timeout pour CI (plus long pour les tests lents)
    testTimeout: 90000, // 90 seconds
    hookTimeout: 120000, // 120 seconds

    // Setup files (nécessaire pour CI)
    setupFiles: ['./tests/setup-env.ts', './tests/setup/jest.setup.js', './tests/setup/filelock.setup.js'],

    // Global setup (nécessaire pour CI)
    globalSetup: './tests/config/globalSetup.ts',

    // Pool configuration
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4
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
    reporters: ['default'],

    // Optimize dependency pre-bundling for faster collection
    deps: {
      optimizer: {
        ssr: {
          enabled: true
        }
      }
    }
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