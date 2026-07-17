/**
 * #833 Sprint C3 — SyncDecisionManager branch coverage (po-2026 lane `src/services/roosync/**`)
 *
 * The existing `SyncDecisionManager.test.ts` (38 tests) covers the public API
 * thoroughly — load/get/execute (not-found, success, dryRun, PS failure,
 * exception), generateDecisionsFromReport counting, and the new-format roadmap
 * approve path. It leaves a cluster of genuine parsing branches cold, however:
 *
 * - `approveDecisionInRoadmap` **hybrid case** (L203-205): a block carrying
 *   `**ID:**` but NO `**Statut:**` line — the else-branch that *injects* the
 *   status is never exercised (every nominal fixture has `**Statut:** pending`).
 * - `approveDecisionInRoadmap` **approval metadata** (L209-212): appending
 *   `**Approuvé le:**`/`**Approuvé par:**` when absent — the nominal test only
 *   checks that `approved` appears in the written content, not the metadata
 *   injection contract.
 * - `approveDecisionInRoadmap` **old checkbox format** (L220-234): the entire
 *   legacy `### DECISION ID:` + `- [ ] **Approuver & Fusionner**` regex branch
 *   is never reached (all fixtures use the new `**ID:** backtick` format).
 * - `parseLogsFromOutput` **stderr fallback** (L151): `result.stderr || result.stdout`
 *   — nominal PS-failure fixtures populate stderr but never assert the logs are
 *   sourced from stderr specifically when stdout is empty.
 * - `executeDecision` **non-Error catch** (L171/L174): `error instanceof Error ?
 *   error.message : String(error)` — every nominal exception throws an `Error`
 *   instance; the `String(error)` arm for plain-string/value rejections is cold.
 * - `generateDecisionsFromReport` **warn log** (L289-291): fires when count > 0;
 *   the nominal test checks the count only, never the warning side-effect.
 *
 * A regression in any of these parsing contracts would pass the nominal suite
 * silently. This add-only file pins them, each assertion anchored on a source
 * line of `SyncDecisionManager.ts`. Reuses the established hoisted-mock pattern.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks (vi.hoisted) ───────────────────

const {
  mockAccess, mockReadFile, mockWriteFile,
  mockParseRoadmap, mockFilterByStatus, mockFilterByMachine, mockFindById,
  mockExecuteScript,
  mockLoggerWarn,
  MockPsExecutor,
} = vi.hoisted(() => {
  const mockExecuteScript = vi.fn();
  const MockPsExecutor = vi.fn().mockImplementation(() => ({ executeScript: mockExecuteScript }));
  return {
    mockAccess: vi.fn(),
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockParseRoadmap: vi.fn(),
    mockFilterByStatus: vi.fn(),
    mockFilterByMachine: vi.fn(),
    mockFindById: vi.fn(),
    mockExecuteScript,
    mockLoggerWarn: vi.fn(),
    MockPsExecutor,
  };
});

vi.mock('fs', () => {
  const fsMock = {
    access: (...args: any[]) => mockAccess(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
    writeFile: (...args: any[]) => mockWriteFile(...args),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
  return {
    promises: fsMock,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    default: { promises: fsMock, existsSync: vi.fn().mockReturnValue(true) },
  };
});

vi.mock('../../../utils/roosync-parsers.js', () => ({
  parseRoadmapMarkdown: (...args: any[]) => mockParseRoadmap(...args),
  filterDecisionsByStatus: (...args: any[]) => mockFilterByStatus(...args),
  filterDecisionsByMachine: (...args: any[]) => mockFilterByMachine(...args),
  findDecisionById: (...args: any[]) => mockFindById(...args),
}));

// NOTE (#2642): PowerShellExecutor lives in src/services/ (NOT src/services/roosync/). The SUT
// imports '../PowerShellExecutor.js' from src/services/roosync/ → src/services/PowerShellExecutor.js;
// from src/services/roosync/__tests__/ that absolute module is '../../PowerShellExecutor.js'.
vi.mock('../../PowerShellExecutor.js', () => ({
  PowerShellExecutor: MockPsExecutor,
}));

// Mock logger at the SUT's import depth (src/utils/logger.js) to observe the
// warn side-effect of generateDecisionsFromReport (L290).
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({ warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { SyncDecisionManager } from '../SyncDecisionManager.js';
import type { RooSyncDecision } from '../../../utils/roosync-parsers.js';

// ─────────────────── helpers ───────────────────

const SHARED_PATH = '/shared/roosync';
const MACHINE_ID = 'test-machine';

function makeConfig() {
  return { sharedPath: SHARED_PATH, machineId: MACHINE_ID } as any;
}

function makeDecision(overrides: Partial<RooSyncDecision> = {}): RooSyncDecision {
  return {
    id: 'DEC-001',
    title: 'Test Decision',
    description: 'A test decision',
    type: 'config',
    priority: 'medium',
    status: 'pending',
    targetMachine: MACHINE_ID,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as RooSyncDecision;
}

function makeExecutorResult(overrides: Partial<{ success: boolean; stdout: string; stderr: string; executionTime: number }> = {}) {
  return {
    success: true,
    stdout: 'Apply-Decisions completed',
    stderr: '',
    executionTime: 500,
    ...overrides,
  };
}

/** Capture the last content written to sync-roadmap.md (approbation write). */
function lastRoadmapWrite(): string {
  const calls = mockWriteFile.mock.calls.filter(
    (c: any[]) => c[0]?.toString().includes('sync-roadmap.md')
  );
  return calls.length ? calls[calls.length - 1][1] as string : '';
}

// ─────────────────── setup ───────────────────

let manager: SyncDecisionManager;

beforeEach(() => {
  vi.clearAllMocks();
  MockPsExecutor.mockImplementation(() => ({ executeScript: mockExecuteScript }));
  manager = new SyncDecisionManager(makeConfig(), new (MockPsExecutor as any)());

  mockAccess.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue('# Roadmap content');
  mockWriteFile.mockResolvedValue(undefined);
  mockParseRoadmap.mockResolvedValue([makeDecision()]);
  mockFilterByStatus.mockImplementation((d: any[]) => d);
  mockFilterByMachine.mockImplementation((d: any[]) => d);
  mockFindById.mockReturnValue(makeDecision());
  mockExecuteScript.mockResolvedValue(makeExecutorResult());
});

describe('SyncDecisionManager — branch coverage (#833 C3, source-grounded)', () => {

  // ============================================================
  // approveDecisionInRoadmap — hybrid case: Statut line missing (L203-205)
  // ============================================================
  describe('approveDecisionInRoadmap — hybrid (no Statut line)', () => {
    test('injects the Statut line when the block has ID: but no Statut: (L203-205)', async () => {
      // Block carries **ID:** but NO **Statut:** → else-branch (L203-205) injects it.
      const roadmap = `<!-- DECISION_BLOCK_START -->
**ID:** \`DEC-001\`
<!-- DECISION_BLOCK_END -->`;
      mockReadFile.mockResolvedValue(roadmap);

      await manager.executeDecision('DEC-001');

      const written = lastRoadmapWrite();
      // The injected line is "**Statut:** approved" appended right after the ID line.
      expect(written).toContain('**Statut:** approved');
      // And the original ID is preserved.
      expect(written).toContain('**ID:** `DEC-001`');
    });
  });

  // ============================================================
  // approveDecisionInRoadmap — approval metadata injection (L209-212)
  // ============================================================
  describe('approveDecisionInRoadmap — metadata injection', () => {
    test('appends Approuvé le/Approuvé par metadata when absent (L209-212)', async () => {
      const roadmap = `<!-- DECISION_BLOCK_START -->
**ID:** \`DEC-001\`
**Statut:** pending
<!-- DECISION_BLOCK_END -->`;
      mockReadFile.mockResolvedValue(roadmap);

      await manager.executeDecision('DEC-001');

      const written = lastRoadmapWrite();
      expect(written).toContain('**Approuvé le:**'); // L211
      // Approuvé par uses this.config.machineId (L211).
      expect(written).toContain('**Approuvé par:** test-machine');
    });

    test('does NOT append metadata when Approuvé par already present (L209 guard)', async () => {
      const existingMeta = '**Approuvé par:** prior-machine';
      const roadmap = `<!-- DECISION_BLOCK_START -->
**ID:** \`DEC-001\`
**Statut:** pending
${existingMeta}
<!-- DECISION_BLOCK_END -->`;
      mockReadFile.mockResolvedValue(roadmap);

      await manager.executeDecision('DEC-001');

      const written = lastRoadmapWrite();
      // Existing metadata preserved; not duplicated with the current machineId.
      expect(written).toContain('prior-machine');
      expect(written.match(/Approuvé par:/g) || []).toHaveLength(1);
    });
  });

  // ============================================================
  // approveDecisionInRoadmap — old checkbox format (L220-234)
  // ============================================================
  describe('approveDecisionInRoadmap — old checkbox format', () => {
    test('flips the unchecked checkbox to [x] in the legacy format (L226-233)', async () => {
      // Legacy format: no `**ID:** backtick` (new-format regex L187 won't match) →
      // falls through to oldFormatRegex (L220) matching `### DECISION ID:` + checkbox.
      const roadmap = `<!-- DECISION_BLOCK_START -->
### DECISION ID: DEC-001
Some context line
- [ ] **Approuver & Fusionner**
<!-- DECISION_BLOCK_END -->`;
      mockReadFile.mockResolvedValue(roadmap);

      await manager.executeDecision('DEC-001');

      const written = lastRoadmapWrite();
      // Checkbox flipped: `[ ]` → `[x]` (L228-231).
      expect(written).toContain('- [x] **Approuver & Fusionner**');
      expect(written).not.toContain('- [ ] **Approuver & Fusionner**');
    });
  });

  // ============================================================
  // approveDecisionInRoadmap — DECISION_NOT_FOUND_IN_ROADMAP (L237-240)
  // ============================================================
  describe('approveDecisionInRoadmap — unknown format', () => {
    test('throws DECISION_NOT_FOUND_IN_ROADMAP, surfaced as success=false with the french message (L237-240)', async () => {
      // Neither new-format nor old-format regex matches.
      mockReadFile.mockResolvedValue('# Roadmap vide\n\nAucune décision ici.');

      const result = await manager.executeDecision('DEC-001');

      // The private throw is caught by executeDecision (L168) → success=false.
      expect(result.success).toBe(false);
      // The RooSyncServiceError message propagates into result.error (L174).
      expect(result.error).toContain('Impossible de trouver la décision DEC-001');
    });
  });

  // ============================================================
  // parseLogsFromOutput — stderr fallback (L151)
  // ============================================================
  describe('parseLogsFromOutput — stderr fallback', () => {
    test('sources logs from stderr when stdout is empty on PS failure (L151)', async () => {
      const roadmap = `<!-- DECISION_BLOCK_START -->
**ID:** \`DEC-001\`
**Statut:** pending
<!-- DECISION_BLOCK_END -->`;
      mockReadFile.mockResolvedValue(roadmap);
      mockExecuteScript.mockResolvedValue(makeExecutorResult({
        success: false,
        stderr: 'Error line A\nError line B',
        stdout: '', // empty → fallback to stderr
      }));

      const result = await manager.executeDecision('DEC-001');

      expect(result.success).toBe(false);
      expect(result.logs).toContain('Error line A');
      expect(result.logs).toContain('Error line B');
    });
  });

  // ============================================================
  // executeDecision — non-Error catch (L171/L174)
  // ============================================================
  describe('executeDecision — non-Error rejection', () => {
    test('coerces a non-Error rejection via String() (L171, L174)', async () => {
      const roadmap = `<!-- DECISION_BLOCK_START -->
**ID:** \`DEC-001\`
**Statut:** pending
<!-- DECISION_BLOCK_END -->`;
      mockReadFile.mockResolvedValue(roadmap);
      // Reject with a plain string — not an Error instance → String() arm.
      mockExecuteScript.mockRejectedValue('plain string failure');

      const result = await manager.executeDecision('DEC-001');

      expect(result.success).toBe(false);
      // String('plain string failure') === 'plain string failure' (L174).
      expect(result.error).toBe('plain string failure');
      // Logs wrap via the same String() coercion (L171).
      expect(result.logs).toContain('Execution error: plain string failure');
    });
  });

  // ============================================================
  // generateDecisionsFromReport — warn log (L289-291)
  // ============================================================
  describe('generateDecisionsFromReport — warn side-effect', () => {
    test('emits a warn log when CRITICAL/IMPORTANT diffs are found (L289-291)', async () => {
      const report = {
        sourceMachine: 'a',
        targetMachine: 'b',
        differences: [
          { severity: 'CRITICAL', description: 'c' },
          { severity: 'IMPORTANT', description: 'i' },
        ],
      };

      const count = await manager.generateDecisionsFromReport(report);

      expect(count).toBe(2);
      // count > 0 → logger.warn fires once with the count + #783 note (L290).
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      const warnMsg = mockLoggerWarn.mock.calls[0][0] as string;
      expect(warnMsg).toContain('2');
      expect(warnMsg).toContain('#783');
    });

    test('does NOT warn when no CRITICAL/IMPORTANT diffs (L289 guard)', async () => {
      const report = {
        sourceMachine: 'a',
        targetMachine: 'b',
        differences: [{ severity: 'WARNING', description: 'w' }],
      };

      await manager.generateDecisionsFromReport(report);

      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });
  });
});
