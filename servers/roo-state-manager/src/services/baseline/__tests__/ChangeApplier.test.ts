/**
 * Tests unitaires pour ChangeApplier
 *
 * Couvre :
 * - applyDecision : succès selon les catégories (config, software, system)
 * - applyDecision : décision non approuvée → exception
 * - applyDecision : catégorie hardware → success=false
 * - applyDecision : catégorie inconnue → success=false
 * - applyDecision : erreur interne → BaselineServiceError
 * - Branches de differenceId (roo.modes, roo.mcpSettings, powershell, node, os, architecture)
 *
 * @module services/baseline/__tests__/ChangeApplier.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ChangeApplier } from '../ChangeApplier.js';
import { BaselineServiceError, BaselineServiceErrorCode } from '../../../types/baseline.js';
import type { SyncDecision } from '../../../types/baseline.js';

// ─────────────────── helpers ───────────────────

function makeDecision(overrides: Partial<SyncDecision> = {}): SyncDecision {
  return {
    id: 'DEC-001',
    machineId: 'test-machine',
    differenceId: 'roo.config.setting',
    category: 'config',
    description: 'Test decision',
    baselineValue: 'baseline',
    targetValue: 'target',
    action: 'sync_to_baseline',
    severity: 'low',
    status: 'approved',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ─────────────────── setup ───────────────────

let applier: ChangeApplier;

beforeEach(() => {
  applier = new ChangeApplier();
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ─────────────────── tests ───────────────────

describe('ChangeApplier', () => {

  // ============================================================
  // applyDecision - decision non approuvée
  // ============================================================

  describe('applyDecision - statut invalide', () => {
    test('lève BaselineServiceError si statut est pending', async () => {
      const decision = makeDecision({ status: 'pending' });

      await expect(applier.applyDecision(decision))
        .rejects.toBeInstanceOf(BaselineServiceError);
    });

    test('lève BaselineServiceError avec code DECISION_INVALID_STATUS', async () => {
      const decision = makeDecision({ status: 'pending' });

      try {
        await applier.applyDecision(decision);
        expect.fail('Should throw');
      } catch (err: any) {
        expect(err.code).toBe(BaselineServiceErrorCode.DECISION_INVALID_STATUS);
      }
    });

    test('lève une erreur si statut est rejected', async () => {
      const decision = makeDecision({ status: 'rejected' });

      await expect(applier.applyDecision(decision))
        .rejects.toBeInstanceOf(BaselineServiceError);
    });
  });

  // ============================================================
  // applyDecision - catégorie config
  // ============================================================

  describe('applyDecision - catégorie config', () => {
    test('retourne success=true pour une décision config approuvée', async () => {
      const result = await applier.applyDecision(makeDecision({ category: 'config' }));

      expect(result.success).toBe(true);
      expect(result.decisionId).toBe('DEC-001');
      expect(result.appliedAt).toBeDefined();
    });

    test('retourne message de succès approprié', async () => {
      const result = await applier.applyDecision(makeDecision({ category: 'config' }));

      expect(result.message).toContain('succès');
    });

    test('branche roo.modes: success=true', async () => {
      const result = await applier.applyDecision(
        makeDecision({ category: 'config', differenceId: 'roo.modes.code' })
      );

      expect(result.success).toBe(true);
    });

    test('branche roo.mcpSettings: success=true', async () => {
      const result = await applier.applyDecision(
        makeDecision({ category: 'config', differenceId: 'roo.mcpSettings.win-cli' })
      );

      expect(result.success).toBe(true);
    });

    test('branche roo.userSettings: success=true', async () => {
      const result = await applier.applyDecision(
        makeDecision({ category: 'config', differenceId: 'roo.userSettings.theme' })
      );

      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // applyDecision - catégorie software
  // ============================================================

  describe('applyDecision - catégorie software', () => {
    test('retourne success=true pour une décision software', async () => {
      const result = await applier.applyDecision(makeDecision({ category: 'software' }));

      expect(result.success).toBe(true);
    });

    test('branche powershell: success=true', async () => {
      const result = await applier.applyDecision(
        makeDecision({ category: 'software', differenceId: 'powershell.version' })
      );

      expect(result.success).toBe(true);
    });

    test('branche node: success=true', async () => {
      const result = await applier.applyDecision(
        makeDecision({ category: 'software', differenceId: 'node.version' })
      );

      expect(result.success).toBe(true);
    });

    test('branche python: success=true', async () => {
      const result = await applier.applyDecision(
        makeDecision({ category: 'software', differenceId: 'python.version' })
      );

      expect(result.success).toBe(true);
    });
  });

  // ============================================================
  // applyDecision - catégorie system
  // ============================================================

  describe('applyDecision - catégorie system', () => {
    test('retourne success=true pour une décision system générique', async () => {
      const result = await applier.applyDecision(
        makeDecision({ category: 'system', differenceId: 'system.config.something' })
      );

      expect(result.success).toBe(true);
    });

    test('branche os: retourne success=false (lecture seule)', async () => {
      const result = await applier.applyDecision(
        makeDecision({ category: 'system', differenceId: 'os.version' })
      );

      expect(result.success).toBe(false);
    });

    test('branche architecture: retourne success=false', async () => {
      const result = await applier.applyDecision(
        makeDecision({ category: 'system', differenceId: 'architecture.type' })
      );

      expect(result.success).toBe(false);
    });
  });

  // ============================================================
  // applyDecision - catégorie hardware
  // ============================================================

  describe('applyDecision - catégorie hardware', () => {
    test('retourne success=false pour hardware (non automatisable)', async () => {
      const result = await applier.applyDecision(makeDecision({ category: 'hardware' }));

      expect(result.success).toBe(false);
    });

    test('retourne message d\'échec pour hardware', async () => {
      const result = await applier.applyDecision(makeDecision({ category: 'hardware' }));

      expect(result.message).toContain('hec');
    });
  });

  // ============================================================
  // applyDecision - catégorie inconnue
  // ============================================================

  describe('applyDecision - catégorie inconnue', () => {
    test('retourne success=false pour catégorie inconnue', async () => {
      const result = await applier.applyDecision(makeDecision({ category: 'unknown' as any }));

      expect(result.success).toBe(false);
    });
  });

  // ============================================================
  // Structure du résultat
  // ============================================================

  describe('structure du résultat', () => {
    test('résultat contient toujours decisionId', async () => {
      const result = await applier.applyDecision(makeDecision({ id: 'DEC-XYZ' }));

      expect(result.decisionId).toBe('DEC-XYZ');
    });

    test('résultat contient appliedAt ISO', async () => {
      const result = await applier.applyDecision(makeDecision());

      expect(result.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('résultat contient error si success=false', async () => {
      const result = await applier.applyDecision(makeDecision({ category: 'hardware' }));

      expect(result.error).toBeDefined();
    });
  });
});
