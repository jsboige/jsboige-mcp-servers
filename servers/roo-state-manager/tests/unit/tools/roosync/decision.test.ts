/**
 * Tests pour les schémas Zod de roosync_decision et roosync_decision_info
 */

import { describe, it, expect } from 'vitest';
import {
  RooSyncDecisionArgsSchema,
  RooSyncDecisionResultSchema
} from '../../../../src/tools/roosync/decision.js';
import {
  RooSyncDecisionInfoArgsSchema,
  RooSyncDecisionInfoResultSchema
} from '../../../../src/tools/roosync/decision-info.js';

describe('RooSyncDecisionArgsSchema', () => {
  describe('Validation des actions valides', () => {
    it('devrait valider action="approve"', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'approve',
        decisionId: 'test-decision-001'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('approve');
        expect(result.data.decisionId).toBe('test-decision-001');
      }
    });

    it('devrait valider action="reject"', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'reject',
        decisionId: 'test-decision-002',
        reason: 'Configuration incompatible'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('reject');
        expect(result.data.reason).toBe('Configuration incompatible');
      }
    });

    it('devrait valider action="apply"', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'apply',
        decisionId: 'test-decision-003',
        dryRun: true,
        force: false
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('apply');
        expect(result.data.dryRun).toBe(true);
        expect(result.data.force).toBe(false);
      }
    });

    it('devrait valider action="rollback"', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'rollback',
        decisionId: 'test-decision-004',
        reason: 'Problème détecté après application'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('rollback');
        expect(result.data.reason).toBe('Problème détecté après application');
      }
    });
  });

  describe('Validation des actions invalides', () => {
    it('devrait échouer avec action invalide', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'invalid-action',
        decisionId: 'test-decision-001'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('action');
      }
    });

    it('devrait échouer avec action manquante', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        decisionId: 'test-decision-001'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('action');
      }
    });
  });

  describe('Validation du decisionId', () => {
    it('devrait valider decisionId valide', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'approve',
        decisionId: 'test-decision-001'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decisionId).toBe('test-decision-001');
      }
    });

    it('devrait valider decisionId avec format UUID', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'approve',
        decisionId: '550e8400-e29b-41d4-a716-446655440000'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decisionId).toBe('550e8400-e29b-41d4-a716-446655440000');
      }
    });

    it('devrait échouer avec decisionId manquant', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'approve'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('decisionId');
      }
    });

    it('devrait valider decisionId vide (z.string() accepte les chaînes vides)', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'approve',
        decisionId: ''
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decisionId).toBe('');
      }
    });

    it('devrait échouer avec decisionId non-string', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'approve',
        decisionId: 123
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('decisionId');
      }
    });
  });

  describe('Validation contextuelle pour reject', () => {
    it('devrait échouer avec reject sans reason', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'reject',
        decisionId: 'test-decision-001'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('reason is required');
        expect(result.error.issues[0].path).toContain('reason');
      }
    });

    it('devrait valider reject avec reason', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'reject',
        decisionId: 'test-decision-001',
        reason: 'Configuration incompatible'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reason).toBe('Configuration incompatible');
      }
    });

    it('devrait échouer avec reject avec reason vide (la validation contextuelle vérifie l\'existence)', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'reject',
        decisionId: 'test-decision-001',
        reason: ''
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('reason is required');
        expect(result.error.issues[0].path).toContain('reason');
      }
    });
  });

  describe('Validation contextuelle pour rollback', () => {
    it('devrait échouer avec rollback sans reason', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'rollback',
        decisionId: 'test-decision-001'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('reason is required');
        expect(result.error.issues[0].path).toContain('reason');
      }
    });

    it('devrait valider rollback avec reason', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'rollback',
        decisionId: 'test-decision-001',
        reason: 'Problème détecté après application'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.reason).toBe('Problème détecté après application');
      }
    });
  });

  describe('Validation des champs optionnels', () => {
    it('devrait valider approve avec comment optionnel', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'approve',
        decisionId: 'test-decision-001',
        comment: 'Approbation validée'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.comment).toBe('Approbation validée');
      }
    });

    it('devrait valider approve sans comment', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'approve',
        decisionId: 'test-decision-001'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.comment).toBeUndefined();
      }
    });

    it('devrait valider apply avec dryRun optionnel', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'apply',
        decisionId: 'test-decision-001',
        dryRun: true
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.dryRun).toBe(true);
      }
    });

    it('devrait valider apply sans dryRun', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'apply',
        decisionId: 'test-decision-001'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.dryRun).toBeUndefined();
      }
    });

    it('devrait valider apply avec force optionnel', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'apply',
        decisionId: 'test-decision-001',
        force: true
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.force).toBe(true);
      }
    });

    it('devrait valider apply sans force', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'apply',
        decisionId: 'test-decision-001'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.force).toBeUndefined();
      }
    });
  });

  describe('Validation avec tous les champs valides', () => {
    it('devrait valider approve avec tous les champs', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'approve',
        decisionId: 'test-decision-001',
        comment: 'Approbation validée'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('approve');
        expect(result.data.decisionId).toBe('test-decision-001');
        expect(result.data.comment).toBe('Approbation validée');
      }
    });

    it('devrait valider reject avec tous les champs', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'reject',
        decisionId: 'test-decision-002',
        reason: 'Configuration incompatible'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('reject');
        expect(result.data.decisionId).toBe('test-decision-002');
        expect(result.data.reason).toBe('Configuration incompatible');
      }
    });

    it('devrait valider apply avec tous les champs', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'apply',
        decisionId: 'test-decision-003',
        dryRun: false,
        force: true
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('apply');
        expect(result.data.decisionId).toBe('test-decision-003');
        expect(result.data.dryRun).toBe(false);
        expect(result.data.force).toBe(true);
      }
    });

    it('devrait valider rollback avec tous les champs', () => {
      const result = RooSyncDecisionArgsSchema.safeParse({
        action: 'rollback',
        decisionId: 'test-decision-004',
        reason: 'Problème détecté après application'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.action).toBe('rollback');
        expect(result.data.decisionId).toBe('test-decision-004');
        expect(result.data.reason).toBe('Problème détecté après application');
      }
    });
  });
});

describe('RooSyncDecisionInfoArgsSchema', () => {
  describe('Validation du decisionId', () => {
    it('devrait valider decisionId valide', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: 'test-decision-001'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decisionId).toBe('test-decision-001');
      }
    });

    it('devrait valider decisionId avec format UUID', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: '550e8400-e29b-41d4-a716-446655440000'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decisionId).toBe('550e8400-e29b-41d4-a716-446655440000');
      }
    });

    it('devrait échouer avec decisionId manquant', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('decisionId');
      }
    });

    it('devrait valider decisionId vide (z.string() accepte les chaînes vides)', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: ''
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decisionId).toBe('');
      }
    });

    it('devrait échouer avec decisionId non-string', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: 123
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('decisionId');
      }
    });
  });

  describe('Validation des champs optionnels', () => {
    it('devrait utiliser la valeur par défaut pour includeHistory', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: 'test-decision-001'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeHistory).toBe(true);
      }
    });

    it('devrait valider includeHistory explicitement à true', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: 'test-decision-001',
        includeHistory: true
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeHistory).toBe(true);
      }
    });

    it('devrait valider includeHistory à false', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: 'test-decision-001',
        includeHistory: false
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeHistory).toBe(false);
      }
    });

    it('devrait utiliser la valeur par défaut pour includeLogs', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: 'test-decision-001'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeLogs).toBe(true);
      }
    });

    it('devrait valider includeLogs explicitement à true', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: 'test-decision-001',
        includeLogs: true
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeLogs).toBe(true);
      }
    });

    it('devrait valider includeLogs à false', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: 'test-decision-001',
        includeLogs: false
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeLogs).toBe(false);
      }
    });

    it('devrait échouer avec includeHistory non-boolean', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: 'test-decision-001',
        includeHistory: 'true'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('includeHistory');
      }
    });

    it('devrait échouer avec includeLogs non-boolean', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: 'test-decision-001',
        includeLogs: 'true'
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('includeLogs');
      }
    });
  });

  describe('Validation avec tous les champs valides', () => {
    it('devrait valider avec tous les champs', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: 'test-decision-001',
        includeHistory: true,
        includeLogs: true
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decisionId).toBe('test-decision-001');
        expect(result.data.includeHistory).toBe(true);
        expect(result.data.includeLogs).toBe(true);
      }
    });

    it('devrait valider avec tous les champs à false', () => {
      const result = RooSyncDecisionInfoArgsSchema.safeParse({
        decisionId: 'test-decision-001',
        includeHistory: false,
        includeLogs: false
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decisionId).toBe('test-decision-001');
        expect(result.data.includeHistory).toBe(false);
        expect(result.data.includeLogs).toBe(false);
      }
    });
  });
});
