/**
 * Integration tests configuration.
 *
 * Runs integration + performance tests only (tests/integration/ + tests/performance/).
 * Longer timeouts, no coverage thresholds.
 *
 * Usage: npx vitest run --config vitest.config.integration.ts
 *        npm run test:integration:config
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
      'tests/integration/**/*.test.ts',
      'tests/integration/**/*.test.js',
      'tests/performance/**/*.test.ts',
      'tests/performance/**/*.test.js'
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
      'tests/integration/hierarchy-real-data.test.ts',
      'tests/integration/integration.test.ts'
    ],
    setupFiles: ['./tests/setup-env.ts', './tests/setup/jest.setup.js', './tests/setup/filelock.setup.js'],
    globalSetup: './tests/config/globalSetup.ts',
    testTimeout: 60000,
    hookTimeout: 120000,
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 2
      }
    },
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
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
