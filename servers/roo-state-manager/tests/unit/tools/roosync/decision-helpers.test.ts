/**
 * Tests pour decision-helpers (utils)
 *
 * Couvre les fonctions pures: validateDecisionStatus, formatDecisionResult,
 * generateNextSteps, createBackup (mocked), restoreBackup (mocked).
 *
 * @module tools/roosync/utils/decision-helpers.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.unmock('fs');

describe('validateDecisionStatus', () => {
  let validateDecisionStatus: typeof import('../../../../src/tools/roosync/utils/decision-helpers.js').validateDecisionStatus;

  beforeEach(async () => {
    vi.resetModules();
    // Mock fs et path pour éviter les accès disque (updateRoadmapStatus les utilise)
    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockReturnValue(''),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      copyFileSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(true),
      readdirSync: vi.fn().mockReturnValue([])
    }));
    vi.doMock('../../../src/utils/roosync-parsers.js', () => ({
      parseRoadmapMarkdown: vi.fn().mockReturnValue([]),
      findDecisionById: vi.fn().mockReturnValue(null)
    }));
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
    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockReturnValue(''),
      writeFileSync: vi.fn()
    }));
    vi.doMock('../../../src/utils/roosync-parsers.js', () => ({
      parseRoadmapMarkdown: vi.fn().mockReturnValue([]),
      findDecisionById: vi.fn().mockReturnValue(null)
    }));
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
    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockReturnValue(''),
      writeFileSync: vi.fn()
    }));
    vi.doMock('../../../src/utils/roosync-parsers.js', () => ({
      parseRoadmapMarkdown: vi.fn().mockReturnValue([]),
      findDecisionById: vi.fn().mockReturnValue(null)
    }));
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
  });
});
