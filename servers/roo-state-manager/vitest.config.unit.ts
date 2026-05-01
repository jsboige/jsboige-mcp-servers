/**
 * Unit tests configuration.
 *
 * Runs only unit tests (tests/unit/ and src __tests__ dirs).
 * Fast execution, coverage enabled by default.
 *
 * Usage: npx vitest run --config vitest.config.unit.ts
 *        npm run test:unit:config
 */
import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    allowImportingTsExtensions: true,
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.test.js',
      'src/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test.js'
    ],
    exclude: [
      'node_modules',
      'build',
      'dist',
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**',
      '**/backups/**',
      '**/vitest-migration/backups/**',
      'vitest-migration/backups/**',
      'tests/unit/parent-child-validation.test.ts',
      'tests/unit/skeleton-cache-reconstruction.test.ts',
      'tests/unit/workspace-filtering-diagnosis.test.ts',
      'tests/unit/services/roosync/FileLockManager.test.ts',
      'tests/unit/services/roosync/FileLockManager.simple.test.ts',
      'tests/unit/services/roosync/FileLockManager.diagnostic.test.ts',
      'tests/unit/services/roosync/PresenceManager.integration.test.ts'
    ],
    setupFiles: ['./tests/setup-env.ts', './tests/setup/jest.setup.js', './tests/setup/filelock.setup.js'],
    globalSetup: './tests/config/globalSetup.ts',
    testTimeout: 15000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4
      }
    },
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    coverage: {
      reportOnFailure: true,
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
      thresholds: {
        lines: 50,
        functions: 50,
        branches: 50,
        statements: 50
      }
    },
    isolate: true,
    reporters: ['default']
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json']
  }
});
