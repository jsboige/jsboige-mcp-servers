/**
 * Coverage tests for src/validate-architecture.ts (#833)
 *
 * The validation script is a top-level executable: it imports, prints banners,
 * then validates 4 architectural principles + scans a workspace + checks isolation.
 *
 * Strategy: per-branch coverage — L17 (top-level execution) + L18-L127 function body
 * + L130-L132 outer catch. Cold branches in this file:
 *
 *   - L63-66  early-return when storageLocations.length === 0
 *   - L82-114 workspace isolation check (multiple branches)
 *   - L88     workspaceMap.has(workspace) — first/second occurrence
 *   - L99-108 for-loop over withParents
 *   - L103    parentSkeleton && cross-workspace
 *   - L110    violations === 0
 *   - L116-118 try/catch (error path)
 *   - L121-126 résumé logs (always-executed)
 *   - L130-132 outer .catch() on validateArchitecture().catch
 *
 * Add-only coverage test, 0 source touched (#1936).
 * Pattern: vi.resetModules() + dynamic import between tests to isolate module state.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Each test sets up its own mocks via vi.resetModules() + vi.doMock() then dynamically
// imports the SUT. We track console.log calls to assert output structure.

describe('validate-architecture.ts branch coverage', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      // Don't throw — just record. We assert against processExitSpy.toHaveBeenCalledWith(1) instead.
      return undefined as never;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../utils/task-instruction-index.js');
    vi.doUnmock('../utils/roo-storage-detector.js');
  });

  // ─── Helpers ────────────────────────────────────────────────────────────────

  async function importSutWithMocks(opts: {
    findPotentialParentReturn?: unknown;
    findAllPotentialParentsReturn?: unknown[];
    addInstructionSideEffect?: () => void;
    getStatsReturn?: { totalInstructions: number; totalNodes: number };
    detectStorageLocationsReturn?: unknown[];
    buildHierarchicalSkeletonsReturn?: unknown[];
    detectStorageReject?: boolean;
    buildHierarchicalSkeletonsReject?: boolean;
  }) {
    vi.doMock('../utils/task-instruction-index.js', () => ({
      globalTaskInstructionIndex: {
        findPotentialParent: vi.fn().mockReturnValue(opts.findPotentialParentReturn),
        findAllPotentialParents: vi.fn().mockReturnValue(opts.findAllPotentialParentsReturn ?? []),
        addInstruction: vi.fn(opts.addInstructionSideEffect ?? (() => {})),
        getStats: vi.fn().mockReturnValue(
          opts.getStatsReturn ?? { totalInstructions: 1, totalNodes: 1 }
        ),
      },
    }));
    vi.doMock('../utils/roo-storage-detector.js', () => ({
      RooStorageDetector: {
        detectStorageLocations: opts.detectStorageReject
          ? vi.fn().mockRejectedValue(new Error('storage detection failed'))
          : vi.fn().mockResolvedValue(
              opts.detectStorageLocationsReturn ?? [{ path: '/mock/path', type: 'mock' }]
            ),
        buildHierarchicalSkeletons: opts.buildHierarchicalSkeletonsReject
          ? vi.fn().mockRejectedValue(new Error('skeleton build failed'))
          : vi.fn().mockResolvedValue(
              opts.buildHierarchicalSkeletonsReturn ?? []
            ),
      },
    }));
    await import('../validate-architecture.js');
    // Wait for top-level execution to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // ─── L14-16 banner ──────────────────────────────────────────────────────────

  test('L14-L16: prints 3-line banner on top-level execution', async () => {
    await importSutWithMocks({});
    const calls = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((s) => s === '====================================')).toHaveLength(2);
    expect(calls.some((s) => s.includes('VALIDATION DE'))).toBe(true);
    expect(calls.some((s) => s.includes('🔍'))).toBe(true);
  });

  // ─── L18-127 function body — happy paths (already covered by existing test)
  //    We re-pin to ensure our new mocks still hit the branches.

  test('L19-23: prints 4 architectural principles with checkmarks', async () => {
    await importSutWithMocks({});
    const calls = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('PRINCIPE ARCHITECTURAL CORRECT'))).toBe(true);
    expect(calls.some((s) => s.includes('Les parents déclarent leurs enfants'))).toBe(true);
    expect(calls.some((s) => s.includes('radix tree'))).toBe(true);
    expect(calls.some((s) => s.includes('parentId vient UNIQUEMENT'))).toBe(true);
    expect(calls.some((s) => s.includes('AUCUNE inférence inverse'))).toBe(true);
  });

  test('L31-L35: findPotentialParent returns undefined → ✅ message (already covered, re-pin)', async () => {
    await importSutWithMocks({ findPotentialParentReturn: undefined });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('findPotentialParent correctement désactivée'))).toBe(true);
  });

  // ─── L63-66 early return — first cold branch
  test('L63-L66: storageLocations empty → early return with warning, workspace scan SKIPPED', async () => {
    await importSutWithMocks({ detectStorageLocationsReturn: [] });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('Aucun emplacement de stockage'))).toBe(true);
    // The RÉSUMÉ section is NOT printed because we returned early (function exits at L66)
    expect(logs.some((s) => s.includes('RÉSUMÉ DE LA VALIDATION'))).toBe(false);
    // buildHierarchicalSkeletons is NEVER called (early return before L71)
  });

  // ─── L70-114 workspace scan — cold branches
  test('L70-L79: skeletons.length === 0 → orphans=0/withParents=0 reported', async () => {
    await importSutWithMocks({
      detectStorageLocationsReturn: [{ path: '/mock/path', type: 'mock' }],
      buildHierarchicalSkeletonsReturn: [],
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('1 emplacements de stockage trouvés'))).toBe(true);
    expect(logs.some((s) => s.includes('Analyse de 0 conversations'))).toBe(true);
    expect(logs.some((s) => s.includes('0 tâches orphelines'))).toBe(true);
    expect(logs.some((s) => s.includes('0 tâches avec parent défini'))).toBe(true);
  });

  test('L82-L94: workspaceMap builds correctly — 2 distinct workspaces detected', async () => {
    await importSutWithMocks({
      detectStorageLocationsReturn: [{ path: '/mock/path', type: 'mock' }],
      buildHierarchicalSkeletonsReturn: [
        {
          taskId: 'task-A',
          parentTaskId: undefined,
          metadata: { workspace: 'ws-1' },
        },
        {
          taskId: 'task-B',
          parentTaskId: 'task-A',
          metadata: { workspace: 'ws-2' },
        },
      ],
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('2 workspace(s) détecté(s)'))).toBe(true);
  });

  test('L87: workspaceMap.has() → first occurrence creates entry (else branch)', async () => {
    // 3 tasks in 1 workspace → first task adds, others hit the "has" branch
    await importSutWithMocks({
      detectStorageLocationsReturn: [{ path: '/mock/path', type: 'mock' }],
      buildHierarchicalSkeletonsReturn: [
        { taskId: 't1', metadata: { workspace: 'ws-x' } },
        { taskId: 't2', metadata: { workspace: 'ws-x' } },
        { taskId: 't3', metadata: { workspace: 'ws-x' } },
      ],
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('1 workspace(s) détecté(s)'))).toBe(true);
  });

  test('L87: workspaceMap.has() → workspace fallback to "undefined" when missing', async () => {
    await importSutWithMocks({
      detectStorageLocationsReturn: [{ path: '/mock/path', type: 'mock' }],
      buildHierarchicalSkeletonsReturn: [
        { taskId: 't1', metadata: {} }, // no workspace key
      ],
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('1 workspace(s) détecté(s)'))).toBe(true);
  });

  // ─── L99-114 isolation check — most branches cold
  test('L99-L108: NO violations when all children share parent workspace', async () => {
    await importSutWithMocks({
      detectStorageLocationsReturn: [{ path: '/mock/path', type: 'mock' }],
      buildHierarchicalSkeletonsReturn: [
        { taskId: 'parent-1', parentTaskId: undefined, metadata: { workspace: 'ws-good' } },
        { taskId: 'child-1', parentTaskId: 'parent-1', metadata: { workspace: 'ws-good' } },
        { taskId: 'child-2', parentTaskId: 'parent-1', metadata: { workspace: 'ws-good' } },
      ],
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('ISOLATION CORRECTE'))).toBe(true);
  });

  test('L99-L108 + L113: VIOLATIONS detected when child workspace ≠ parent workspace', async () => {
    await importSutWithMocks({
      detectStorageLocationsReturn: [{ path: '/mock/path', type: 'mock' }],
      buildHierarchicalSkeletonsReturn: [
        { taskId: 'parent-AAAA', parentTaskId: undefined, metadata: { workspace: 'ws-A' } },
        { taskId: 'child-BBBB', parentTaskId: 'parent-AAAA', metadata: { workspace: 'ws-B' } },
      ],
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('VIOLATION'))).toBe(true);
    expect(logs.some((s) => s.includes('1 violation(s) d\'isolation détectée(s)'))).toBe(true);
  });

  test('L101: parentSkeleton NOT found (orphan parent) → no violation reported', async () => {
    await importSutWithMocks({
      detectStorageLocationsReturn: [{ path: '/mock/path', type: 'mock' }],
      buildHierarchicalSkeletonsReturn: [
        { taskId: 'orphan-child', parentTaskId: 'ghost-parent-NOT-IN-LIST', metadata: { workspace: 'ws-x' } },
      ],
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    // Skeleton has parentTaskId → it's in withParents; but parentSkeleton lookup fails → no VIOLATION message
    expect(logs.some((s) => s.includes('VIOLATION'))).toBe(false);
    expect(logs.some((s) => s.includes('ISOLATION CORRECTE'))).toBe(true);
  });

  test('L113 else branch + L114 log message', async () => {
    await importSutWithMocks({
      detectStorageLocationsReturn: [{ path: '/mock/path', type: 'mock' }],
      buildHierarchicalSkeletonsReturn: [
        { taskId: 'p-AAA', parentTaskId: undefined, metadata: { workspace: 'ws-p' } },
        { taskId: 'c-BBB', parentTaskId: 'p-AAA', metadata: { workspace: 'ws-other' } },
        { taskId: 'c-CCC', parentTaskId: 'p-AAA', metadata: { workspace: 'ws-third' } },
      ],
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    // Should print "2 violation(s)" (2 children in different workspaces)
    expect(logs.some((s) => s.match(/2 violation\(s\)/))).toBe(true);
  });

  // ─── L116-118 try/catch around storage scan
  test('L116-L118: try-catch — detectStorageLocations rejects → error logged, no crash', async () => {
    await importSutWithMocks({
      detectStorageReject: true,
    });
    const errors = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
    expect(errors.some((s) => s.includes('Erreur lors de l\'analyse'))).toBe(true);
    // process.exit NOT called (catch only logs)
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  test('L116-L118: try-catch — buildHierarchicalSkeletons rejects → error logged', async () => {
    await importSutWithMocks({
      detectStorageLocationsReturn: [{ path: '/mock/path', type: 'mock' }],
      buildHierarchicalSkeletonsReject: true,
    });
    const errors = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
    expect(errors.some((s) => s.includes('Erreur lors de l\'analyse'))).toBe(true);
  });

  // ─── L121-126 résumé section — always-executed but cold
  test('L121-L126: RÉSUMÉ DE LA VALIDATION printed when function reaches the end', async () => {
    await importSutWithMocks({
      detectStorageLocationsReturn: [{ path: '/mock/path', type: 'mock' }],
      buildHierarchicalSkeletonsReturn: [],
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('RÉSUMÉ DE LA VALIDATION'))).toBe(true);
    expect(logs.some((s) => s.includes('Méthodes d\'inférence inverse désactivées'))).toBe(true);
    expect(logs.some((s) => s.includes('Radix tree toujours fonctionnel'))).toBe(true);
    expect(logs.some((s) => s.includes('ParentIds proviennent uniquement'))).toBe(true);
    expect(logs.some((s) => s.includes('Architecture conforme au principe descendant'))).toBe(true);
  });

  // ─── L130-132 outer .catch on validateArchitecture().catch(...)
  test('L130-L132: outer .catch — when validateArchitecture itself rejects → console.error + process.exit(1)', async () => {
    // Force validateArchitecture to throw by making globalTaskInstructionIndex throw
    // when findPotentialParent is called (first thing inside validateArchitecture).
    // The top-level call is `validateArchitecture().catch(error => { console.error("Erreur fatale :", error); process.exit(1); })`
    vi.doMock('../utils/task-instruction-index.js', () => ({
      globalTaskInstructionIndex: {
        findPotentialParent: vi.fn().mockImplementation(() => {
          throw new Error('simulated initialization failure');
        }),
        findAllPotentialParents: vi.fn().mockReturnValue([]),
        addInstruction: vi.fn(),
        getStats: vi.fn().mockReturnValue({ totalInstructions: 1, totalNodes: 1 }),
      },
    }));
    vi.doMock('../utils/roo-storage-detector.js', () => ({
      RooStorageDetector: {
        detectStorageLocations: vi.fn().mockResolvedValue([]),
        buildHierarchicalSkeletons: vi.fn().mockResolvedValue([]),
      },
    }));
    // Import the module — top-level promise chain runs in background
    await import('../validate-architecture.js');
    // Wait for top-level execution to settle (the throw → outer catch)
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The outer catch logs "Erreur fatale :" + the error, then calls process.exit(1)
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorMessages = consoleErrorSpy.mock.calls
      .map((c) => String(c[0] ?? c))
      .join('\n');
    expect(errorMessages).toContain('Erreur fatale');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  // ─── L50-L55 radix tree count paths
  test('L50: stats.totalInstructions > 0 → ✅ message', async () => {
    await importSutWithMocks({
      getStatsReturn: { totalInstructions: 42, totalNodes: 7 },
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('Le radix tree peut toujours être alimenté'))).toBe(true);
    expect(logs.some((s) => s.includes('42 instructions'))).toBe(true);
    expect(logs.some((s) => s.includes('7 noeuds'))).toBe(true);
  });

  test('L53-L55: stats.totalInstructions === 0 → ⚠️ warning (fallback branch)', async () => {
    await importSutWithMocks({
      getStatsReturn: { totalInstructions: 0, totalNodes: 0 },
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('Le radix tree semble vide'))).toBe(true);
  });

  // ─── L33-L35 else branch — findPotentialParent returns NON-undefined (corruption detection)
  test('L33-L35: findPotentialParent returns a value → ❌ ERREUR message (corruption detected)', async () => {
    await importSutWithMocks({
      findPotentialParentReturn: { id: 'inferred-parent' },
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('ERREUR : findPotentialParent retourne encore une valeur'))).toBe(true);
  });

  // ─── L42-L44 else branch — findAllPotentialParents returns non-empty
  test('L42-L44: findAllPotentialParents returns non-empty → ❌ ERREUR (corruption detected)', async () => {
    await importSutWithMocks({
      findAllPotentialParentsReturn: [{ id: 'inferred-1' }, { id: 'inferred-2' }],
    });
    const logs = consoleLogSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((s) => s.includes('ERREUR : findAllPotentialParents retourne encore'))).toBe(true);
  });
});