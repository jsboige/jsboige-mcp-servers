/**
 * CI-specific vitest configuration.
 *
 * Extends the unit config but excludes tests that:
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
 * Last audit: 2026-03-14 (29 files excluded - removed 8 stale entries, see #699)
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import unitConfig from './vitest.config.unit.js';

export default mergeConfig(unitConfig, defineConfig({
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

      // ===== SERVICE_MOCK: Exclusions removed 2026-05-14 (#1143 audit) =====
      // Root cause (jest.setup.js broad mocks removed in 2e6b49a) is no longer valid.
      // All surviving tests have self-contained vi.mock() and pass in CI.
      // Archived (low-value/thin): new-modules-integration, phase3-comprehensive,
      //   concurrency, BaselineService unit (superseded by src/services/__tests__ version).
      // Ghost entry removed: heartbeat.integration.test.ts (file deleted).
      'tests/integration/_archives/**',
      'tests/performance/_archives/**',
      'tests/unit/services/_archives/BaselineService.ci-excluded.test.ts',

      // ===== CI-excluded: PRE-ADR 008 HeartbeatService tests (stale API) =====
      // Tests use getOfflineMachines/getWarningMachines/file-based heartbeats removed by ADR 008.
      // Track: #1143 follow-up — these tests need rewrite for in-memory HeartbeatService.
      // RE-AUDIT 2026-07-02 (po-2025): test file was rewritten for the in-memory
      // HeartbeatService — it now asserts getUnknownMachines/getIdleMachines (ADR 008
      // replacements), not the removed file-based API. Verified firsthand: 20/20 pass
      // in BOTH unit and CI config. Exclusion is STALE → re-enabled.
      // 'tests/unit/services/RooSyncService.test.ts',
      // #1244 Couche 2.5/2.6/2.7 — Re-enabled in CI after repair: legacy test was
      // fixed to accommodate the new hard-cap and smart_truncation default, and the
      // file now contains regression guards for the pipeline repair (#1244).
      // 'tests/unit/tools/view-conversation-tree.test.ts',

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
      'src/tools/roosync/__tests__/machines.smoke.test.ts',
      'src/tools/roosync/__tests__/list-diffs.smoke.test.ts',

      // ===== CI-excluded: APPDATA/GDRIVE (Windows paths + GDrive) =====
      'src/tools/roosync/__tests__/baseline.integration.test.ts',
      'src/tools/roosync/__tests__/baseline.test.ts',
      'src/tools/roosync/__tests__/compare-config.integration.test.ts',
      'src/tools/roosync/__tests__/config.integration.test.ts',
      'src/tools/roosync/__tests__/decision.integration.test.ts',
      'src/tools/roosync/__tests__/diagnose.integration.test.ts',
      'src/tools/roosync/__tests__/refresh-dashboard.integration.test.ts',
      'src/tools/roosync/__tests__/update-dashboard.integration.test.ts',
      // Live LLM endpoint, opt-in via LLM_LIVE_INTEGRATION=1 — 502 repro (#1578)
      'src/tools/roosync/__tests__/dashboard-llm-live.integration.test.ts',
      'tests/unit/tools/roosync/baseline.test.ts',

      // ===== CI-excluded: Export baseline (schema mismatch) =====
      // RE-AUDIT 2026-07-02 (po-2025): file `tests/unit/tools/roosync/export-baseline.test.ts`
      // no longer exists (ghost entry, file deleted). Exclusion was a no-op → removed.
      // 'tests/unit/tools/roosync/export-baseline.test.ts',

      // ===== NOTE: Stale entries removed (2026-03-14, #699 audit) =====
      // The following files no longer exist and were removed from exclusion list:
      // - tests/unit/tools/roosync/console-test.test.ts (deleted)
      // - tests/unit/tools/roosync/debug-instance-check.test.ts (deleted)
      // - tests/unit/tools/roosync/debug-mock-direct.test.ts (deleted)
      // - tests/unit/tools/roosync/debug-mock-factory.test.ts (deleted)
      // - tests/unit/tools/roosync/debug-mock.test.ts (deleted)
      // - tests/unit/tools/roosync/debug-other-methods.test.ts (deleted)
      // - tests/unit/tools/roosync/debug-source-import.test.ts (deleted)
      // - tests/unit/tools/storage/get-stats.test.ts (removed tool)

      // ===== CI-excluded: PARENT_REPO (reads files from parent roo-extensions repo) =====
      'src/services/__tests__/skepticism-protocol.test.ts',

      // ===== CI-excluded: LIVE SERVICES (require Qdrant + Embedding service) =====
      'src/tools/search/__tests__/search-live.integration.test.ts',

      // ===== CI-excluded: STRESS (hardware-dependent timing thresholds) =====
      // These tests have timing thresholds that fail on slower machines (16GB RAM, --maxWorkers=1)
      'src/tools/roosync/__tests__/stress-large-inbox.test.ts',

      // ===== EVAL HARNESS (live services — excluded from CI) =====
      'tests/eval-harness/**',

      // ===== E2E (already excluded in base) =====
      'tests/e2e/**',
    ],
  },
}));
