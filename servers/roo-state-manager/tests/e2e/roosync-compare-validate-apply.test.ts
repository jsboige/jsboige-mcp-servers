/**
 * Tests End-to-End RooSync - Flux Compare → Validate → Apply
 *
 * Tests du flux complet de synchronisation RooSync avec mocks.
 * Ces tests valident la logique du workflow sans appeler PowerShell.
 *
 * @module tests/e2e/roosync-compare-validate-apply.test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock l'InventoryCollectorWrapper AVANT d'importer les modules
vi.mock('../../src/services/roosync/InventoryCollectorWrapper.js', () => ({
  InventoryCollectorWrapper: {
    collectInventory: vi.fn().mockResolvedValue({
      machineId: 'PC-TEST-E2E',
      timestamp: new Date().toISOString(),
      rooConfig: {
        modes: [{ name: 'code', enabled: true }],
        mcpServers: []
      },
      hardware: {
        cpu: 'Test CPU',
        ram: '16GB',
        os: 'Windows 11'
      }
    })
  }
}));

// Mock ConfigComparator pour éviter les appels réels
vi.mock('../../src/services/roosync/ConfigComparator.js', () => ({
  ConfigComparator: vi.fn().mockImplementation(() => ({
    compareRealConfigurations: vi.fn().mockResolvedValue({
      source: 'PC-TEST-E2E',
      target: 'PC-TARGET-TEST',
      differences: [
        {
          category: 'rooConfig',
          severity: 'WARNING',
          path: 'modes.architect',
          description: 'Mode architect: disabled → enabled',
          action: 'enable'
        }
      ],
      summary: {
        total: 1,
        critical: 0,
        important: 0,
        warning: 1,
        info: 0
      }
    }),
    compareWithBaseline: vi.fn().mockResolvedValue({
      source: 'PC-TEST-E2E',
      target: 'baseline',
      differences: [],
      summary: { total: 0, critical: 0, important: 0, warning: 0, info: 0 }
    })
  }))
}));

describe('RooSync E2E - Flux Compare → Validate → Apply', () => {
  let testDir: string;

  beforeAll(() => {
    // Créer répertoire de test
    testDir = join(tmpdir(), `roosync-e2e-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'decisions'), { recursive: true });

    // Configurer environnement
    process.env.ROOSYNC_SHARED_PATH = testDir;
    process.env.ROOSYNC_MACHINE_ID = 'PC-TEST-E2E';
  });

  afterAll(() => {
    // Nettoyer
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Scénario 1 : Flux Nominal (Succès)', () => {
    it('devrait détecter des différences avec le mock', async () => {
      // Import dynamique après les mocks
      const { roosyncCompareConfig } = await import('../../src/tools/roosync/compare-config.js');

      const result = await roosyncCompareConfig({
        source: 'PC-TEST-E2E',
        target: 'PC-TARGET-TEST'
      });

      // Le mock retourne des différences
      expect(result).toBeDefined();
      expect(result.differences).toBeDefined();
      expect(result.summary).toBeDefined();
    });
  });

  describe('Scénario 2 : Validation Schema Compare', () => {
    it('devrait valider le schema CompareConfigArgs', async () => {
      const { CompareConfigArgsSchema } = await import('../../src/tools/roosync/compare-config.js');

      // Valid args
      const valid = CompareConfigArgsSchema.safeParse({
        source: 'machine-a',
        target: 'machine-b'
      });
      expect(valid.success).toBe(true);

      // Empty args (should use defaults)
      const empty = CompareConfigArgsSchema.safeParse({});
      expect(empty.success).toBe(true);
    });
  });

  describe('Scénario 3 : Validation Schema Approve', () => {
    it('devrait valider le schema ApproveDecisionArgs', async () => {
      const { ApproveDecisionArgsSchema } = await import('../../src/tools/roosync/approve-decision.js');

      // Valid args
      const valid = ApproveDecisionArgsSchema.safeParse({
        decisionId: 'decision-001',
        comment: 'Approved for test'
      });
      expect(valid.success).toBe(true);

      // Missing decisionId
      const invalid = ApproveDecisionArgsSchema.safeParse({
        comment: 'No ID'
      });
      expect(invalid.success).toBe(false);
    });
  });

  describe('Scénario 4 : Validation Schema Reject', () => {
    it('devrait valider le schema RejectDecisionArgs', async () => {
      const { RejectDecisionArgsSchema } = await import('../../src/tools/roosync/reject-decision.js');

      // Valid args
      const valid = RejectDecisionArgsSchema.safeParse({
        decisionId: 'decision-001',
        reason: 'Not needed'
      });
      expect(valid.success).toBe(true);

      // Missing decisionId
      const invalid = RejectDecisionArgsSchema.safeParse({
        reason: 'No ID'
      });
      expect(invalid.success).toBe(false);
    });
  });

  describe('Scénario 5 : Validation Schema Apply', () => {
    it('devrait valider le schema ApplyDecisionArgs', async () => {
      const { ApplyDecisionArgsSchema } = await import('../../src/tools/roosync/apply-decision.js');

      // Valid args with all options
      const valid = ApplyDecisionArgsSchema.safeParse({
        decisionId: 'decision-001',
        dryRun: true,
        force: false
      });
      expect(valid.success).toBe(true);

      // Minimal args
      const minimal = ApplyDecisionArgsSchema.safeParse({
        decisionId: 'decision-001'
      });
      expect(minimal.success).toBe(true);

      // Missing decisionId
      const invalid = ApplyDecisionArgsSchema.safeParse({
        dryRun: true
      });
      expect(invalid.success).toBe(false);
    });
  });

  describe('Scénario 6 : Validation Schema Rollback', () => {
    it('devrait valider le schema RollbackDecisionArgs', async () => {
      const { RollbackDecisionArgsSchema } = await import('../../src/tools/roosync/rollback-decision.js');

      // Valid args
      const valid = RollbackDecisionArgsSchema.safeParse({
        decisionId: 'decision-001',
        reason: 'Need to revert'
      });
      expect(valid.success).toBe(true);

      // Missing decisionId
      const invalid = RollbackDecisionArgsSchema.safeParse({
        reason: 'No ID'
      });
      expect(invalid.success).toBe(false);
    });
  });
});
