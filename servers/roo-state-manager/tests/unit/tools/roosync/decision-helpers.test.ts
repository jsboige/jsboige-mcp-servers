/**
 * Tests pour decision-helpers (utils)
 *
 * Couvre les fonctions pures: validateDecisionStatus, formatDecisionResult,
 * generateNextSteps, createBackup (mocked), restoreBackup (mocked), moveDecisionFile (mocked).
 *
 * @module tools/roosync/utils/decision-helpers.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Define mock functions using hoisted pattern before vi.mock()
const mockFsFunctions = vi.hoisted(() => ({
  readFileSync: vi.fn().mockReturnValue(''),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(true),
  readdirSync: vi.fn().mockReturnValue([]),
  appendFileSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ isDirectory: () => true, size: 100, mtime: new Date() }),
  unlinkSync: vi.fn()
}));

const mockParserFunctions = vi.hoisted(() => ({
  parseRoadmapMarkdown: vi.fn().mockReturnValue([]),
  findDecisionById: vi.fn().mockReturnValue(null)
}));

// Mock fs and parsers BEFORE any imports
vi.unmock('fs');
vi.mock('fs', () => ({
  readFileSync: mockFsFunctions.readFileSync,
  writeFileSync: mockFsFunctions.writeFileSync,
  mkdirSync: mockFsFunctions.mkdirSync,
  copyFileSync: mockFsFunctions.copyFileSync,
  existsSync: mockFsFunctions.existsSync,
  readdirSync: mockFsFunctions.readdirSync,
  appendFileSync: mockFsFunctions.appendFileSync,
  statSync: mockFsFunctions.statSync,
  unlinkSync: mockFsFunctions.unlinkSync
}));

vi.mock('../../../src/utils/roosync-parsers.js', () => ({
  parseRoadmapMarkdown: mockParserFunctions.parseRoadmapMarkdown,
  findDecisionById: mockParserFunctions.findDecisionById
}));

describe('validateDecisionStatus', () => {
  let validateDecisionStatus: typeof import('../../../../src/tools/roosync/utils/decision-helpers.js').validateDecisionStatus;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const module = await import('../../../../src/tools/roosync/utils/decision-helpers.js');
    validateDecisionStatus = module.validateDecisionStatus;
  });

  describe('transitions valides', () => {
    it('approve : pending → valide', () => {
      expect(validateDecisionStatus('pending', 'approve')).toBe(true);
    });

    it('reject : pending → valide', () => {
      expect(validateDecisionStatus('pending', 'reject')).toBe(true);
    });

    it('apply : approved → valide', () => {
      expect(validateDecisionStatus('approved', 'apply')).toBe(true);
    });

    it('rollback : applied → valide', () => {
      expect(validateDecisionStatus('applied', 'rollback')).toBe(true);
    });
  });

  describe('transitions invalides', () => {
    it('approve : approved → invalide', () => {
      expect(validateDecisionStatus('approved', 'approve')).toBe(false);
    });

    it('apply : pending → invalide (pas encore approuvé)', () => {
      expect(validateDecisionStatus('pending', 'apply')).toBe(false);
    });

    it('rollback : pending → invalide', () => {
      expect(validateDecisionStatus('pending', 'rollback')).toBe(false);
    });

    it('approve : rejected → invalide', () => {
      expect(validateDecisionStatus('rejected', 'approve')).toBe(false);
    });

    it('statut inconnu → invalide', () => {
      expect(validateDecisionStatus('unknown_status', 'approve')).toBe(false);
    });
  });
});

describe('formatDecisionResult', () => {
  let formatDecisionResult: typeof import('../../../../src/tools/roosync/utils/decision-helpers.js').formatDecisionResult;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const module = await import('../../../../src/tools/roosync/utils/decision-helpers.js');
    formatDecisionResult = module.formatDecisionResult;
  });

  it('devrait retourner les champs de base', () => {
    const result = formatDecisionResult('approve', 'DEC-001', 'pending', 'approved', 'machine-1');

    expect(result.decisionId).toBe('DEC-001');
    expect(result.action).toBe('approve');
    expect(result.previousStatus).toBe('pending');
    expect(result.newStatus).toBe('approved');
    expect(result.machineId).toBe('machine-1');
    expect(result.timestamp).toBeDefined();
    expect(Array.isArray(result.nextSteps)).toBe(true);
  });

  it('devrait inclure nextSteps pour approved', () => {
    const result = formatDecisionResult('approve', 'DEC-001', 'pending', 'approved', 'machine-1');
    expect(result.nextSteps.length).toBeGreaterThan(0);
    expect(result.nextSteps[0]).toContain('apply');
  });

  it('devrait inclure nextSteps pour rejected', () => {
    const result = formatDecisionResult('reject', 'DEC-001', 'pending', 'rejected', 'machine-1');
    expect(result.nextSteps.length).toBeGreaterThan(0);
    expect(result.nextSteps[0]).toContain('rejet');
  });

  it('devrait inclure nextSteps pour applied', () => {
    const result = formatDecisionResult('apply', 'DEC-001', 'approved', 'applied', 'machine-1');
    expect(result.nextSteps.length).toBeGreaterThan(0);
  });

  it('devrait inclure nextSteps pour rolled_back', () => {
    const result = formatDecisionResult('rollback', 'DEC-001', 'applied', 'rolled_back', 'machine-1');
    expect(result.nextSteps.length).toBeGreaterThan(0);
    expect(result.nextSteps[0]).toContain('annul');
  });

  it('devrait fusionner additionalData dans le résultat', () => {
    const result = formatDecisionResult(
      'approve', 'DEC-001', 'pending', 'approved', 'machine-1',
      { comment: 'LGTM', extraField: 42 }
    );

    expect(result.comment).toBe('LGTM');
    expect(result.extraField).toBe(42);
  });

  it('devrait retourner nextSteps par défaut pour statut inconnu', () => {
    const result = formatDecisionResult('approve', 'DEC-001', 'pending', 'unknown_status', 'machine-1');
    expect(Array.isArray(result.nextSteps)).toBe(true);
    expect(result.nextSteps[0]).toContain('roosync_decision_info');
  });
});

describe('generateNextSteps', () => {
  let generateNextSteps: typeof import('../../../../src/tools/roosync/utils/decision-helpers.js').generateNextSteps;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const module = await import('../../../../src/tools/roosync/utils/decision-helpers.js');
    generateNextSteps = module.generateNextSteps;
  });

  it('devrait retourner les étapes pour approve', () => {
    const steps = generateNextSteps('approve');
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]).toContain('apply');
  });

  it('devrait retourner les étapes pour reject', () => {
    const steps = generateNextSteps('reject');
    expect(Array.isArray(steps)).toBe(true);
    expect(steps[0]).toContain('rejet');
  });

  it('devrait retourner les étapes pour apply', () => {
    const steps = generateNextSteps('apply');
    expect(Array.isArray(steps)).toBe(true);
    expect(steps[0]).toContain('appliqu');
  });

  it('devrait retourner les étapes pour rollback', () => {
    const steps = generateNextSteps('rollback');
    expect(Array.isArray(steps)).toBe(true);
    expect(steps[0]).toContain('Rollback');
  });
});

describe('Interface - exports', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('devrait exporter toutes les fonctions publiques', async () => {
    const module = await import('../../../../src/tools/roosync/utils/decision-helpers.js');

    expect(typeof module.validateDecisionStatus).toBe('function');
    expect(typeof module.formatDecisionResult).toBe('function');
    expect(typeof module.generateNextSteps).toBe('function');
    expect(typeof module.updateRoadmapStatus).toBe('function');
    expect(typeof module.updateRoadmapStatusAsync).toBe('function');
    expect(typeof module.loadDecisionDetails).toBe('function');
    expect(typeof module.createBackup).toBe('function');
    expect(typeof module.restoreBackup).toBe('function');
    expect(typeof module.moveDecisionFile).toBe('function');
  });
});

describe('createBackup', () => {
  let createBackup: typeof import('../../../../src/tools/roosync/utils/decision-helpers.js').createBackup;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const module = await import('../../../../src/tools/roosync/utils/decision-helpers.js');
    createBackup = module.createBackup;
  });

  it('devrait retourner un objet avec les propriétés attendues', () => {
    const files = ['/path/to/file1.txt'];
    const backupPath = '/tmp/backups';

    const result = createBackup(files, backupPath);

    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('files');
    expect(result).toHaveProperty('backupDir');
  });

  it('devrait gérer les fichiers inexistants sans erreur', () => {
    const files = ['/nonexistent/file.txt'];
    const backupPath = '/tmp/backups';

    // Ne devrait pas lancer d'erreur même si le fichier n'existe pas
    expect(() => createBackup(files, backupPath)).not.toThrow();
  });
});

describe('restoreBackup', () => {
  let restoreBackup: typeof import('../../../../src/tools/roosync/utils/decision-helpers.js').restoreBackup;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const module = await import('../../../../src/tools/roosync/utils/decision-helpers.js');
    restoreBackup = module.restoreBackup;
  });

  it('devrait lancer une erreur si backupDir manquant', () => {
    const backupInfo = {
      timestamp: '2026-03-21T12-00-00',
      files: [],
      // backupDir manquant
    };
    const targetPath = '/target';

    expect(() => restoreBackup(backupInfo, targetPath)).toThrow();
  });
});

describe('moveDecisionFile', () => {
  let moveDecisionFile: typeof import('../../../../src/tools/roosync/utils/decision-helpers.js').moveDecisionFile;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const module = await import('../../../../src/tools/roosync/utils/decision-helpers.js');
    moveDecisionFile = module.moveDecisionFile;
  });

  it('devrait déplacer un fichier de décision et mettre à jour le statut', () => {
    const sharedPath = '/shared-state';
    const decisionId = 'DEC-001';
    const fromStatus = 'pending';
    const toStatus = 'approved';

    const originalDecision = {
      title: 'Test Decision',
      status: 'pending'
    };

    mockFsFunctions.existsSync.mockReturnValue(true);
    mockFsFunctions.readFileSync.mockReturnValue(JSON.stringify(originalDecision));

    const result = moveDecisionFile(sharedPath, decisionId, fromStatus, toStatus);

    expect(result).toBe(true);
    expect(mockFsFunctions.readFileSync).toHaveBeenCalled();
    expect(mockFsFunctions.writeFileSync).toHaveBeenCalled();
    expect(mockFsFunctions.unlinkSync).toHaveBeenCalled();

    // Vérifier que le statut a été mis à jour dans le JSON écrit
    const writtenContent = mockFsFunctions.writeFileSync.mock.calls[0][1];
    const updatedDecision = JSON.parse(writtenContent as string);
    expect(updatedDecision.status).toBe('approved');
  });

  it('devrait retourner false si le fichier source n\'existe pas', () => {
    const sharedPath = '/shared-state';
    const decisionId = 'DEC-999';
    const fromStatus = 'pending';
    const toStatus = 'approved';

    mockFsFunctions.existsSync.mockReturnValue(false);

    const result = moveDecisionFile(sharedPath, decisionId, fromStatus, toStatus);

    expect(result).toBe(false);
    expect(mockFsFunctions.readFileSync).not.toHaveBeenCalled();
  });

  it('devrait ajouter les timestamps appropriés selon le statut', () => {
    const sharedPath = '/shared-state';
    const decisionId = 'DEC-002';
    const fromStatus = 'approved';
    const toStatus = 'applied';

    const originalDecision = {
      title: 'Test Decision',
      status: 'approved',
      approvedAt: '2026-03-20T10:00:00Z',
      approvedBy: 'machine-1'
    };

    mockFsFunctions.existsSync.mockReturnValue(true);
    mockFsFunctions.readFileSync.mockReturnValue(JSON.stringify(originalDecision));

    moveDecisionFile(sharedPath, decisionId, fromStatus, toStatus);

    const writtenContent = mockFsFunctions.writeFileSync.mock.calls[0][1];
    const updatedDecision = JSON.parse(writtenContent as string);

    expect(updatedDecision.status).toBe('applied');
    expect(updatedDecision).toHaveProperty('appliedAt');
    expect(updatedDecision).toHaveProperty('appliedBy');
  });
});
