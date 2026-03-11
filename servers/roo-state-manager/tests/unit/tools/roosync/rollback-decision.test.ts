/**
 * Tests pour roosync_rollback_decision
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

// Désactiver le mock global de fs pour ce test qui utilise le système de fichiers réel
vi.unmock('fs');
// Désactiver le mock global de RooSyncService et ConfigService pour utiliser l'implémentation réelle
vi.unmock('../../../../src/services/RooSyncService.js');
vi.unmock('../../../../src/services/ConfigService.js');

import { tmpdir } from 'os';

// Set environment variables at module level for mock
// These must be set before importing any RooSyncService module
process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
process.env.ROOSYNC_SHARED_PATH = join(tmpdir(), `roosync-rollback-test-${Date.now()}`);

// CRITICAL: Mock the @ alias path to ensure both test file and source file use the same mock
// The @ alias is defined in vitest.config.ts and points to ./src
vi.mock('@/services/RooSyncService.js', () => {
  const sharedMockInstance = {
    getConfig: vi.fn(() => ({
      sharedPath: process.env.ROOSYNC_SHARED_PATH || '/mock/roosync/shared-path',
      machineId: process.env.ROOSYNC_MACHINE_ID || 'ci-test-machine',
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    })),
    loadDashboard: vi.fn(async () => ({ version: '2.1.0', machines: [] })),
    resetInstance: vi.fn(() => undefined),
    getDecision: vi.fn(),
    restoreFromRollbackPoint: vi.fn(async () => ({ success: true, restoredFiles: [], logs: [] })),
    clearCache: vi.fn(() => undefined)
  };

  return {
    RooSyncService: {
      getInstance: vi.fn(() => sharedMockInstance),
      resetInstance: vi.fn(() => undefined)
    },
    getRooSyncService: vi.fn(() => sharedMockInstance),
    RooSyncServiceError: class extends Error {
      constructor(message: string, code?: string) {
        super(message);
        this.name = 'RooSyncServiceError';
        this.code = code;
      }
    }
  };
});

// CRITICAL: Import using the @ alias to match the vitest config path alias
// This ensures consistent module resolution
import { RooSyncService, getRooSyncService } from '@/services/RooSyncService.js';

describe('roosync_rollback_decision', () => {
  const testDir = process.env.ROOSYNC_SHARED_PATH as string;

  beforeEach(async () => {
    // Setup test environment
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Already exists
    }

    // Create test roadmap
    const roadmap = `# Roadmap RooSync

## Décisions de Synchronisation

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-applied\`
**Titre:** Décision déjà appliquée
**Statut:** applied
**Type:** config
**Chemin:** \`.config/test.json\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** MAC-DEV
**Créé:** 2025-10-08T09:00:00Z
**Approuvé le:** 2025-10-08T09:30:00Z
**Approuvé par:** PC-PRINCIPAL
**Appliqué le:** 2025-10-08T10:00:00Z
**Appliqué par:** PC-PRINCIPAL
**Rollback disponible:** Oui
<!-- DECISION_BLOCK_END -->

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-pending\`
**Titre:** Décision pas encore appliquée
**Statut:** pending
**Type:** file
**Chemin:** \`test.txt\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** all
**Créé:** 2025-10-08T09:00:00Z
<!-- DECISION_BLOCK_END -->
`;

    writeFileSync(join(testDir, 'sync-roadmap.md'), roadmap, 'utf-8');

    // Initialize service
    RooSyncService.resetInstance();

    // Create rollback directory with backup
    const rollbackDir = join(testDir, '.rollback');
    mkdirSync(rollbackDir, { recursive: true });

    const backupPath = join(rollbackDir, `test-decision-applied_${Date.now()}`);
    mkdirSync(backupPath, { recursive: true });
    writeFileSync(join(backupPath, 'backup-info.json'), JSON.stringify({
      decisionId: 'test-decision-applied',
      timestamp: new Date().toISOString(),
      files: ['.config/test.json']
    }), 'utf-8');

    // Mock getDecision to return test decisions
    // Note: The service is already mocked by jest.setup.js, we just need to add the spy
    const service = getRooSyncService();
    console.log('[DEBUG] service:', service);
    console.log('[DEBUG] service.getConfig:', typeof service?.getConfig);
    console.log('[DEBUG] process.env.ROOSYNC_MACHINE_ID:', process.env.ROOSYNC_MACHINE_ID);
    console.log('[DEBUG] process.env.ROOSYNC_SHARED_PATH:', process.env.ROOSYNC_SHARED_PATH);

    if (service?.getConfig) {
      const testConfig = service.getConfig();
      console.log('[DEBUG] testConfig:', testConfig);
    }

    // Add the spy for getDecision
    vi.spyOn(service, 'getDecision').mockImplementation(async (id: string) => {
      if (id === 'test-decision-applied') {
        return {
          id,
          status: 'applied',
          type: 'config',
          title: 'Décision déjà appliquée',
          sourceMachine: 'PC-PRINCIPAL',
          targetMachines: ['MAC-DEV'],
          createdAt: '2025-10-08T09:00:00Z',
          appliedAt: '2025-10-08T10:00:00Z',
          rollbackAvailable: true
        };
      } else if (id === 'test-decision-pending') {
        return {
          id,
          status: 'pending',
          type: 'file',
          title: 'Décision pas encore appliquée',
          sourceMachine: 'PC-PRINCIPAL',
          targetMachines: ['all'],
          createdAt: '2025-10-08T09:00:00Z'
        };
      }
      return null;
    });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore
    }
    RooSyncService.resetInstance();
    vi.restoreAllMocks();
  });

  it('devrait annuler une décision appliquée', async () => {
    // Dynamic import to ensure mock is applied before source file loads
    const { roosyncRollbackDecision } = await import('../../../../src/tools/roosync/rollback-decision.js');

    const result = await roosyncRollbackDecision({
      decisionId: 'test-decision-applied',
      reason: 'Problème détecté après application'
    });

    expect(result.newStatus).toBe('rolled_back');
    expect(result.previousStatus).toBe('applied');
    expect(result.reason).toBe('Problème détecté après application');
    expect(result.rolledBackBy).toBe('PC-PRINCIPAL');
  });

  it('devrait lever une erreur si décision pas appliquée', async () => {
    const { roosyncRollbackDecision } = await import('../../../../src/tools/roosync/rollback-decision.js');

    await expect(roosyncRollbackDecision({
      decisionId: 'test-decision-pending',
      reason: 'Test'
    })).rejects.toThrow('pas encore appliquée');
  });

  it('devrait lever une erreur si décision introuvable', async () => {
    const { roosyncRollbackDecision } = await import('../../../../src/tools/roosync/rollback-decision.js');

    await expect(roosyncRollbackDecision({
      decisionId: 'nonexistent',
      reason: 'Test'
    })).rejects.toThrow('introuvable');
  });

  it('devrait retourner la liste des fichiers restaurés', async () => {
    const { roosyncRollbackDecision } = await import('../../../../src/tools/roosync/rollback-decision.js');

    const result = await roosyncRollbackDecision({
      decisionId: 'test-decision-applied',
      reason: 'Restauration de test'
    });

    expect(Array.isArray(result.restoredFiles)).toBe(true);
    expect(result.restoredFiles.length).toBeGreaterThanOrEqual(0);
  });

  it('devrait inclure les logs d\'exécution', async () => {
    const { roosyncRollbackDecision } = await import('../../../../src/tools/roosync/rollback-decision.js');

    const result = await roosyncRollbackDecision({
      decisionId: 'test-decision-applied',
      reason: 'Test logs'
    });

    expect(Array.isArray(result.executionLog)).toBe(true);
    expect(result.executionLog.length).toBeGreaterThan(0);
    expect(result.executionLog.some(log => log.includes('ROLLBACK'))).toBe(true);
  });

  it('devrait mettre à jour sync-roadmap.md', async () => {
    const { roosyncRollbackDecision } = await import('../../../../src/tools/roosync/rollback-decision.js');

    const result = await roosyncRollbackDecision({
      decisionId: 'test-decision-applied',
      reason: 'Mise à jour roadmap'
    });

    expect(result.newStatus).toBe('rolled_back');

    // Verify the file was updated
    const updatedRoadmap = readFileSync(join(testDir, 'sync-roadmap.md'), 'utf-8');
    expect(updatedRoadmap).toContain('**Statut:** rolled_back');
    expect(updatedRoadmap).toContain('**Rollback le:**');
    expect(updatedRoadmap).toContain('**Raison:** Mise à jour roadmap');
  });

  it('devrait inclure la date du rollback au format ISO 8601', async () => {
    const { roosyncRollbackDecision } = await import('../../../../src/tools/roosync/rollback-decision.js');

    const result = await roosyncRollbackDecision({
      decisionId: 'test-decision-applied',
      reason: 'Test date'
    });

    // Verify ISO 8601 format
    expect(result.rolledBackAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
