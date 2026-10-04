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
 * issue to fix the underlying test so it can run in CI, and re-run
 * scripts/count-ci-exclusions.mjs to refresh the census counts below.
 *
 * Exclusion census: 23 test-file entries + 4 tests-directory globs
 * (canonical measure, script-extracted — per-entry reasons and effective
 * delta vs local run: docs/CI-EXCLUSIONS-CENSUS.md).
 *
 * Last audit: 2026-10-04 (#2639) — drift-guard: tests/unit/ci-exclusion-drift-guard.test.ts
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
      'tests/unit/services/roosync/FileLockManager.simple.test.ts',
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
      // 2026-10-04 (#2639): send.smoke.test.ts RE-ENABLED in CI. The test was
      //   already fully isolated (tmpdir `.test-messages` under os.tmpdir(),
      //   dir lifecycle owned by beforeEach/afterEach, MessageManager routed to
      //   ROOSYNC_SHARED_PATH via mock) — the blanket smoke exclusion from its
      //   introduction (e514937d) predated the isolation and was stale. Plus an
      //   isolation-contract test pinning the tmpdir guarantee. Verified
      //   firsthand: 4/4 pass under the CI config with the exclusion lifted.
      // 'src/tools/roosync/__tests__/send.smoke.test.ts',
      // 2026-10-03 (#2639): get-status.smoke.test.ts RE-ENABLED in CI. The #2639
      //   rewrite runs every scenario against a tmpdir ROOSYNC_SHARED_PATH created
      //   by the test itself (env set in beforeEach, restored in afterEach) — no
      //   real GDrive/RooSync state involved. Verified firsthand: 11/11 pass under
      //   the CI config with the exclusion lifted, full suite green.
      // 'src/tools/roosync/__tests__/get-status.smoke.test.ts',
      // 2026-10-04 (#2639): storage-management.smoke.test.ts RE-ENABLED in CI,
      //   MOCK-BASED isolation (deviation from the tmpdir method, documented):
      //   the tool delegates to RooStorageDetector/ZooStorageDetector which scan
      //   real machine paths through a 5-minute global cache and expose no env
      //   routing — a tmpdir ROOSYNC_SHARED_PATH never reaches them. Detectors
      //   and handleMaintenance are mocked (established CI pattern, baseline
      //   .test.ts #2967); the #564 freshness pattern is preserved on mock state
      //   changes. Verified firsthand: 4/4 pass under the CI config with the
      //   exclusion lifted.
      // 'src/tools/roosync/__tests__/storage-management.smoke.test.ts',
      // 2026-10-03 (#2639): machines.smoke.test.ts RE-ENABLED in CI. Same
      //   method as get-status.smoke: the test points ROOSYNC_SHARED_PATH at a
      //   tmpdir it creates in beforeEach and removes in afterEach (portable
      //   os.tmpdir() replacing the POSIX-only hardcoded /tmp path), plus an
      //   isolation-contract test asserting the heartbeat store lives under
      //   that tmpdir. Verified firsthand: 4/4 pass under the CI config with
      //   the exclusion lifted.
      // 'src/tools/roosync/__tests__/machines.smoke.test.ts',
      // 2026-10-04 (#2639): src/tools/roosync/__tests__/list-diffs.smoke.test.ts
      //   RE-ENABLED in CI. Isolation was already in place (tmpdir
      //   `.shared-state-test-listdiffs` under os.tmpdir(), baseline +
      //   inventories written there, ROOSYNC_SHARED_PATH routed to it,
      //   SHARED_STATE_PATH deleted in beforeEach, ENOTEMPTY-retried cleanup
      //   in afterEach) — the blanket smoke exclusion was stale. An
      //   isolation-contract test pins the tmpdir guarantee; the leftover
      //   permanent debug-file write was removed. Verified firsthand: 4/4
      //   pass under the CI config with the exclusion lifted.
      // 'src/tools/roosync/__tests__/list-diffs.smoke.test.ts',

      // ===== CI-excluded: platform (PowerShell) / state-dependent / stale-schema =====
      // 2026-07-26 (#2967): src/tools/roosync/__tests__/baseline.test.ts RE-ENABLED in CI.
      //   All tests use vi.mock() for child_process, RooSyncService, ConfigService,
      //   shared-state-path, BaselineService, InventoryCollector, DiffDetector. No real
      //   GDrive/APPDATA/PowerShell dependency. Verified: 79/79 pass under CI config,
      //   full suite 12635/12635 pass with file re-enabled.
      // 2026-10-04 (#2639, tranche 6 — measured by lifting each exclusion and running
      //   the file under THIS config, which is the authoritative one):
      //   RE-ENABLED (2): baseline.integration, diagnose.integration.
      //   They already routed ROOSYNC_SHARED_PATH to an os.tmpdir() fixture in
      //   beforeEach and carry no APPDATA / GDrive / Windows-path reference of their own
      //   (grep APPDATA|process.platform|win32|C:\|G:\|RooStorageDetector|globalStorage
      //   → 0 hit on both files, and on 11 of the 12 *.integration.test.ts of
      //   src/tools/roosync/__tests__/ ; the 12th, mcp-management, is the only one that
      //   touches process.env.APPDATA and it is NOT excluded); both create their own
      //   fixture dirs (mkdirSync recursive), which are gitignored — safe on a fresh CI
      //   checkout.
      //   The 2026-07-26 blanket exclusion was stale — same class as the SMOKEs.
      //   baseline.integration additionally pins SHARED_STATE_PATH to a temp dir
      //   (BaselineService prioritises it over ROOSYNC_SHARED_PATH).
      //   Verified: 12/12 + 23/23 pass under this config.
      // 'src/tools/roosync/__tests__/baseline.integration.test.ts',
      // 'src/tools/roosync/__tests__/diagnose.integration.test.ts',
      // STAYS EXCLUDED — measured 2026-10-04 (#2639): 28/28 GREEN, but the file leaves a
      //   stray 0-byte `D` in the CWD. Bisected to 'should handle complete workflow:
      //   approve → apply → rollback'; making `D` a directory turns it into a hard
      //   failure (EISDIR → rollbackResult.success === false), so the rollback path
      //   really writes to it. Write site not identified (createBackup/restoreBackup
      //   never ran — the backups dir stays empty; no `split(':')` on the shared path).
      //   An unidentified write in a path that also runs in production does not get
      //   switched on silently in CI — needs its own investigation.
      'src/tools/roosync/__tests__/decision.integration.test.ts',
      // STAYS EXCLUDED — measured 2026-10-04 (#2639): 13/13 fail. The tool shells out
      //   to `pwsh -NoProfile -ExecutionPolicy Bypass -c "& ...generate-mcp-dashboard.ps1"`
      //   (refresh-dashboard.ts l.161) — a hard PowerShell/Windows dependency, and the
      //   one entry here whose "platform-dependent" label was accurate.
      'src/tools/roosync/__tests__/refresh-dashboard.integration.test.ts',
      // STAYS EXCLUDED — measured 2026-10-04 (#2639): 1/41 fails. The apply_profile
      //   'should throw when profile not found' case asserts on /profil.*non trouvé/
      //   but receives 'model-configs.json non trouvé localement': the tmpdir holds no
      //   model-configs.json fixture, so the tool fails one branch earlier. Fix = add
      //   the fixture to the test, not a CI-config change.
      'src/tools/roosync/__tests__/config.integration.test.ts',
      // STAYS EXCLUDED — measured 2026-10-04 (#2639): 3/39 fail, and NOT for a
      //   GDrive reason. The #495 env-var block filters on the loose substring
      //   'manquante', which also matches checkRosterPartitionDrift()'s wording
      //   ('manquantes du roster' / 'Manquantes du roster', compare-config.ts
      //   l.2010 and l.2031). That drift is derived from service.loadDashboard()
      //   — real shared state — so the expected count is machine/state-dependent
      //   and the file is not tmpdir-isolable as written. Fix = tighten the test
      //   filter (path.startsWith('env.') + severity).
      'src/tools/roosync/__tests__/compare-config.integration.test.ts',
      // update-dashboard.integration.test.ts removed with its module (#3549) —
      // update est v3-native, couvert en CI par dashboard-update-v3.test.ts
      // Live LLM endpoint, opt-in via LLM_LIVE_INTEGRATION=1 — 502 repro (#1578)
      'src/tools/roosync/__tests__/dashboard-llm-live.integration.test.ts',
      // STAYS EXCLUDED — measured 2026-10-04 (#2639): 2/20 fail. Pure schema/
      //   interface tests — no APPDATA/GDrive dependency whatsoever (entry was
      //   miscategorised). The two 'action: restore' acceptance cases no longer
      //   match the live BaselineArgsSchema: this needs the TEST updated, not a
      //   CI-config change.
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
