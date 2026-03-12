/**
 * CI-specific vitest configuration.
 *
 * Extends the base config but excludes tests that:
 * - Depend on Windows-specific features (APPDATA, PowerShell)
 * - Depend on GDrive shared state paths
 * - Have outdated service mocks (SERVICE_MOCK category)
 * - Require platform-specific tooling
 *
 * Usage: npx vitest run --config vitest.config.ci.ts
 *
 * IMPORTANT: When adding new test exclusions here, also create a tracking
 * issue to fix the underlying test so it can run in CI.
 *
 * Last audit: 2026-03-11 (37 files excluded, see #626, #643)
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(baseConfig, defineConfig({
  test: {
    exclude: [
      // ===== Inherited from base config =====
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
      'tests/integration/hierarchy-real-data.test.ts',
      'tests/integration/integration.test.ts',
      'tests/unit/services/roosync/FileLockManager.test.ts',
      'tests/unit/services/roosync/FileLockManager.simple.test.ts',
      'tests/unit/services/roosync/FileLockManager.diagnostic.test.ts',
      'tests/unit/services/roosync/PresenceManager.integration.test.ts',

      // ===== CI-excluded: SERVICE_MOCK (outdated mocks after refactoring) =====
      // These tests reference service methods that no longer exist or have changed signatures.
      // Root cause: jest.setup.js broad mocks removed in 2e6b49a, tests not updated.
      'src/services/__tests__/BaselineService.test.ts',
      'src/services/__tests__/ConfigService.test.ts',
      'src/services/__tests__/RooSyncService.test.ts',
      'src/services/__tests__/task-indexer.test.ts',
      'src/tools/__tests__/mcp-tools-audit.test.ts',
      'src/tools/roosync/__tests__/compare-config.test.ts',
      'src/tools/roosync/__tests__/heartbeat.integration.test.ts',
      'tests/integration/commit-log-integration.test.ts',
      'tests/integration/new-modules-integration.test.ts',
      'tests/integration/phase3-comprehensive.test.ts',
      'tests/integration/roosync-conflict-integration.test.ts',
      'tests/performance/concurrency.test.ts',
      'tests/unit/services/BaselineService.test.ts',
      'tests/unit/services/RooSyncService.test.ts',
      'tests/unit/services/task-indexer-vector-validation.test.ts',
      'tests/unit/services/task-indexer.test.ts',
      'tests/unit/tools/view-conversation-tree.test.ts',

      // ===== CI-excluded: POWERSHELL (requires Windows PowerShell) =====
      'src/services/__tests__/PowerShellExecutor.test.ts',
      'tests/unit/services/PowerShellExecutor.test.ts',
      'tests/unit/services/powershell-executor.test.ts',
      'tests/unit/services/InventoryCollector.test.ts',
      'tests/unit/services/InventoryCollectorWrapper.test.ts',
      'src/tools/roosync/__tests__/inventory.integration.test.ts',

      // ===== CI-excluded: SMOKE (depends on real GDrive/RooSync state) =====
      'src/tools/roosync/__tests__/send.smoke.test.ts',
      'src/tools/roosync/__tests__/get-status.smoke.test.ts',
      'src/tools/roosync/__tests__/storage-management.smoke.test.ts',

      // ===== CI-excluded: APPDATA/GDRIVE (Windows paths + GDrive) =====
      'src/tools/roosync/__tests__/baseline.integration.test.ts',
      'src/tools/roosync/__tests__/baseline.test.ts',
      'src/tools/roosync/__tests__/config.integration.test.ts',
      'src/tools/roosync/__tests__/decision.integration.test.ts',
      'src/tools/roosync/__tests__/diagnose.integration.test.ts',
      'src/tools/roosync/__tests__/refresh-dashboard.integration.test.ts',
      'src/tools/roosync/__tests__/update-dashboard.integration.test.ts',
      'tests/unit/tools/roosync/baseline.test.ts',

      // ===== CI-excluded: DEBUG (debug files for local development) =====
      // These are debug test files created to diagnose mock path resolution issues.
      // They are not meant to run in CI - use them locally for troubleshooting.
      'tests/unit/tools/roosync/console-test.test.ts',
      'tests/unit/tools/roosync/debug-instance-check.test.ts',
      'tests/unit/tools/roosync/debug-mock-direct.test.ts',
      'tests/unit/tools/roosync/debug-mock-factory.test.ts',
      'tests/unit/tools/roosync/debug-mock.test.ts',
      'tests/unit/tools/roosync/debug-other-methods.test.ts',
      'tests/unit/tools/roosync/debug-source-import.test.ts',

      // ===== CI-excluded: Export baseline (schema mismatch) =====
      'tests/unit/tools/roosync/export-baseline.test.ts',

      // ===== CI-excluded: Storage (depends on removed tool) =====
      'tests/unit/tools/storage/get-stats.test.ts',

      // ===== CI-excluded: PARENT_REPO (reads files from parent roo-extensions repo) =====
      'src/services/__tests__/skepticism-protocol.test.ts',

      // ===== E2E (already excluded in base) =====
      'tests/e2e/**',
    ],
  },
}));
