/**
 * Tests unitaires pour SyncDecisionManager
 *
 * Couvre :
 * - loadDecisions : succès / fichier introuvable
 * - loadPendingDecisions : filtre par status + machineId
 * - getDecision : trouvée / non trouvée
 * - executeDecision : non trouvée / succès / dryRun / PS failure / exception
 * - generateDecisionsFromReport : compte CRITICAL + IMPORTANT
 *
 * @module services/roosync/__tests__/SyncDecisionManager.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks (vi.hoisted) ───────────────────

const {
  mockAccess, mockReadFile, mockWriteFile,
  mockParseRoadmap, mockFilterByStatus, mockFilterByMachine, mockFindById,
  mockExecuteScript,
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

vi.mock('../PowerShellExecutor.js', () => ({
  PowerShellExecutor: MockPsExecutor,
}));

import { SyncDecisionManager } from '../SyncDecisionManager.js';
import { RooSyncServiceError } from '../../RooSyncService.js';
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
  mockFilterByStatus.mockImplementation((decisions: any[]) => decisions);
  mockFilterByMachine.mockImplementation((decisions: any[]) => decisions);
  mockFindById.mockReturnValue(makeDecision());
  mockExecuteScript.mockResolvedValue(makeExecutorResult());
});

// ─────────────────── tests ───────────────────

describe('SyncDecisionManager', () => {

  // ============================================================
  // loadDecisions
  // ============================================================

  describe('loadDecisions', () => {
    test('retourne les décisions parsées du roadmap', async () => {
      const decisions = [makeDecision(), makeDecision({ id: 'DEC-002' })];
      mockParseRoadmap.mockResolvedValue(decisions);

      const result = await manager.loadDecisions();
      expect(result).toHaveLength(2);
    });

    test('appelle checkFileExists avec sync-roadmap.md', async () => {
      await manager.loadDecisions();
      expect(mockAccess).toHaveBeenCalledWith(
        expect.stringContaining('sync-roadmap.md')
      );
    });

    test('appelle parseRoadmapMarkdown avec le chemin complet', async () => {
      await manager.loadDecisions();
      expect(mockParseRoadmap).toHaveBeenCalledWith(
        expect.stringContaining('sync-roadmap.md')
      );
    });

    test('lève RooSyncServiceError si sync-roadmap.md introuvable', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      await expect(manager.loadDecisions()).rejects.toMatchObject({
        code: 'FILE_NOT_FOUND',
        name: 'RooSyncServiceError',
      });
    });

    test('code FILE_NOT_FOUND si fichier absent', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      try {
        await manager.loadDecisions();
        expect.fail('Should throw');
      } catch (err: any) {
        expect(err.code).toBe('FILE_NOT_FOUND');
      }
    });
  });

  // ============================================================
  // loadPendingDecisions
  // ============================================================

  describe('loadPendingDecisions', () => {
    test('filtre par status pending puis par machineId', async () => {
      const all = [makeDecision(), makeDecision({ id: 'DEC-002', status: 'approved' })];
      const pending = [all[0]];
      mockParseRoadmap.mockResolvedValue(all);
      mockFilterByStatus.mockReturnValue(pending);
      mockFilterByMachine.mockReturnValue(pending);

      const result = await manager.loadPendingDecisions();

      expect(mockFilterByStatus).toHaveBeenCalledWith(all, 'pending');
      expect(mockFilterByMachine).toHaveBeenCalledWith(pending, MACHINE_ID);
      expect(result).toEqual(pending);
    });

    test('retourne tableau vide si aucune décision pending', async () => {
      mockFilterByStatus.mockReturnValue([]);
      mockFilterByMachine.mockReturnValue([]);

      const result = await manager.loadPendingDecisions();
      expect(result).toEqual([]);
    });
  });

  // ============================================================
  // getDecision
  // ============================================================

  describe('getDecision', () => {
    test('retourne la décision trouvée par ID', async () => {
      const dec = makeDecision({ id: 'DEC-XYZ' });
      mockFindById.mockReturnValue(dec);

      const result = await manager.getDecision('DEC-XYZ');
      expect(result).toEqual(dec);
    });

    test('retourne null si décision introuvable', async () => {
      mockFindById.mockReturnValue(undefined);
      const result = await manager.getDecision('UNKNOWN');
      expect(result).toBeNull();
    });

    test('appelle findDecisionById avec l\'ID donné', async () => {
      await manager.getDecision('DEC-001');
      expect(mockFindById).toHaveBeenCalledWith(expect.any(Array), 'DEC-001');
    });
  });

  // ============================================================
  // executeDecision - décision non trouvée
  // ============================================================

  describe('executeDecision - décision non trouvée', () => {
    test('retourne success=false si décision introuvable', async () => {
      mockFindById.mockReturnValue(undefined);
      const result = await manager.executeDecision('UNKNOWN');
      expect(result.success).toBe(false);
    });

    test('retourne un message dans logs si décision introuvable', async () => {
      mockFindById.mockReturnValue(undefined);
      const result = await manager.executeDecision('UNKNOWN');
      expect(result.logs.some(l => l.includes('UNKNOWN'))).toBe(true);
    });

    test('executionTime = 0 si décision introuvable', async () => {
      mockFindById.mockReturnValue(undefined);
      const result = await manager.executeDecision('UNKNOWN');
      expect(result.executionTime).toBe(0);
    });
  });

  // ============================================================
  // executeDecision - succès (nouveau format roadmap)
  // ============================================================

  describe('executeDecision - succès', () => {
    beforeEach(() => {
      // Roadmap avec format nouveau (DECISION_BLOCK)
      const roadmap = `<!-- DECISION_BLOCK_START -->
**ID:** \`DEC-001\`
**Statut:** pending
<!-- DECISION_BLOCK_END -->`;
      mockReadFile.mockResolvedValue(roadmap);
    });

    test('retourne success=true après exécution réussie', async () => {
      const result = await manager.executeDecision('DEC-001');
      expect(result.success).toBe(true);
    });

    test('retourne executionTime du résultat PS', async () => {
      mockExecuteScript.mockResolvedValue(makeExecutorResult({ executionTime: 1234 }));
      const result = await manager.executeDecision('DEC-001');
      expect(result.executionTime).toBe(1234);
    });

    test('retourne les logs parsés depuis stdout', async () => {
      mockExecuteScript.mockResolvedValue(makeExecutorResult({
        stdout: 'Line 1\nLine 2\n\nLine 3'
      }));
      const result = await manager.executeDecision('DEC-001');
      expect(result.logs).toContain('Line 1');
      expect(result.logs).toContain('Line 3');
      // Lignes vides filtrées
      expect(result.logs).not.toContain('');
    });

    test('détecte les fichiers modifiés depuis stdout', async () => {
      mockExecuteScript.mockResolvedValue(makeExecutorResult({
        stdout: 'Configuration de référence mise à jour avec succès'
      }));
      const result = await manager.executeDecision('DEC-001');
      expect(result.changes.filesModified).toContain('sync-config.ref.json');
    });

    test('changes vides si stdout ne contient pas le message de succès', async () => {
      mockExecuteScript.mockResolvedValue(makeExecutorResult({ stdout: 'Generic output' }));
      const result = await manager.executeDecision('DEC-001');
      expect(result.changes.filesModified).toHaveLength(0);
    });
  });

  // ============================================================
  // executeDecision - dryRun
  // ============================================================

  describe('executeDecision - dryRun', () => {
    const roadmap = `<!-- DECISION_BLOCK_START -->
**ID:** \`DEC-001\`
**Statut:** pending
<!-- DECISION_BLOCK_END -->`;

    test('lit le roadmap avant exécution si dryRun=true', async () => {
      mockReadFile.mockResolvedValue(roadmap);
      await manager.executeDecision('DEC-001', { dryRun: true });
      // readFile appelé pour (1) backup roadmap + (2) approveDecisionInRoadmap
      expect(mockReadFile).toHaveBeenCalled();
    });

    test('restaure le roadmap après exécution si dryRun=true', async () => {
      mockReadFile.mockResolvedValue(roadmap);
      await manager.executeDecision('DEC-001', { dryRun: true });
      // writeFile appelé pour (1) approuver + (2) restaurer
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('sync-roadmap.md'),
        roadmap,
        'utf-8'
      );
    });

    test('ne lit pas le roadmap si dryRun=false', async () => {
      mockReadFile.mockResolvedValue(roadmap);
      await manager.executeDecision('DEC-001', { dryRun: false });
      // readFile appelé seulement dans approveDecisionInRoadmap (une fois)
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // executeDecision - PS failure
  // ============================================================

  describe('executeDecision - PS failure', () => {
    const roadmap = `<!-- DECISION_BLOCK_START -->
**ID:** \`DEC-001\`
**Statut:** pending
<!-- DECISION_BLOCK_END -->`;

    test('retourne success=false si PS échoue', async () => {
      mockReadFile.mockResolvedValue(roadmap);
      mockExecuteScript.mockResolvedValue(makeExecutorResult({
        success: false, stderr: 'Script error'
      }));
      const result = await manager.executeDecision('DEC-001');
      expect(result.success).toBe(false);
    });

    test('retourne l\'erreur PS dans le message d\'erreur', async () => {
      mockReadFile.mockResolvedValue(roadmap);
      mockExecuteScript.mockResolvedValue(makeExecutorResult({
        success: false, stderr: 'Critical script failure'
      }));
      const result = await manager.executeDecision('DEC-001');
      expect(result.error).toContain('Critical script failure');
    });
  });

  // ============================================================
  // executeDecision - exception
  // ============================================================

  describe('executeDecision - exception', () => {
    beforeEach(() => {
      const roadmap = `<!-- DECISION_BLOCK_START -->
**ID:** \`DEC-001\`
**Statut:** pending
<!-- DECISION_BLOCK_END -->`;
      mockReadFile.mockResolvedValue(roadmap);
    });

    test('retourne success=false si une exception est levée', async () => {
      mockExecuteScript.mockRejectedValue(new Error('Unexpected error'));
      const result = await manager.executeDecision('DEC-001');
      expect(result.success).toBe(false);
    });

    test('retourne le message d\'erreur dans error', async () => {
      mockExecuteScript.mockRejectedValue(new Error('Network timeout'));
      const result = await manager.executeDecision('DEC-001');
      expect(result.error).toContain('Network timeout');
    });
  });

  // ============================================================
  // generateDecisionsFromReport
  // ============================================================

  describe('generateDecisionsFromReport', () => {
    test('compte les décisions CRITICAL et IMPORTANT', async () => {
      const report = {
        sourceMachine: 'machine-a',
        targetMachine: 'machine-b',
        differences: [
          { severity: 'CRITICAL', description: 'Critical diff' },
          { severity: 'IMPORTANT', description: 'Important diff' },
          { severity: 'WARNING', description: 'Warning diff' },
          { severity: 'INFO', description: 'Info diff' },
        ]
      };

      const count = await manager.generateDecisionsFromReport(report);
      expect(count).toBe(2); // CRITICAL + IMPORTANT uniquement
    });

    test('retourne 0 si aucune différence CRITICAL/IMPORTANT', async () => {
      const report = {
        sourceMachine: 'a', targetMachine: 'b',
        differences: [
          { severity: 'WARNING', description: 'W' },
          { severity: 'INFO', description: 'I' },
        ]
      };
      const count = await manager.generateDecisionsFromReport(report);
      expect(count).toBe(0);
    });

    test('retourne 0 si differences est vide', async () => {
      const report = { sourceMachine: 'a', targetMachine: 'b', differences: [] };
      const count = await manager.generateDecisionsFromReport(report);
      expect(count).toBe(0);
    });
  });

  // ============================================================
  // approveDecisionInRoadmap - via executeDecision (indirect)
  // ============================================================

  describe('approveDecisionInRoadmap (via executeDecision)', () => {
    test('met à jour le statut pending → approved dans nouveau format', async () => {
      const roadmap = `<!-- DECISION_BLOCK_START -->
**ID:** \`DEC-001\`
**Statut:** pending
<!-- DECISION_BLOCK_END -->`;
      mockReadFile.mockResolvedValue(roadmap);

      await manager.executeDecision('DEC-001');

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('sync-roadmap.md'),
        expect.stringContaining('approved'),
        'utf-8'
      );
    });

    test('ne modifie pas si déjà approved', async () => {
      const roadmap = `<!-- DECISION_BLOCK_START -->
**ID:** \`DEC-001\`
**Statut:** approved
<!-- DECISION_BLOCK_END -->`;
      mockReadFile.mockResolvedValue(roadmap);

      await manager.executeDecision('DEC-001');

      // writeFile appelé UNIQUEMENT si des modifications sont faites
      // (pas d'écriture si déjà approved)
      const writeCallsToRoadmap = mockWriteFile.mock.calls.filter(
        (call: any[]) => call[0]?.toString().includes('sync-roadmap.md')
      );
      expect(writeCallsToRoadmap.length).toBe(0);
    });

    test('lève RooSyncServiceError si décision introuvable dans roadmap', async () => {
      // Roadmap sans la décision DEC-001
      mockReadFile.mockResolvedValue('# Roadmap vide\n\nAucune décision ici.');
      const result = await manager.executeDecision('DEC-001');
      // L'exception est catchée dans executeDecision → success=false
      expect(result.success).toBe(false);
    });
  });
});
