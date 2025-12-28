/**
 * Tests pour roosync_get_decision_details
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Mock pour RooSyncService
const { mockRooSyncService, mockRooSyncServiceError, mockGetRooSyncService } = vi.hoisted(() => {
  // Mock de la classe d'erreur
  const errorClass = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'RooSyncServiceError';
    }
  };
  
  const service = {
    resetInstance: vi.fn(),
    getInstance: vi.fn(() => ({
      getConfig: vi.fn().mockReturnValue({
        version: '2.0.0',
        sharedPath: '/mock/shared',
        baselinePath: '/mock/baseline',
        machines: {
          'PC-PRINCIPAL': {
            id: 'PC-PRINCIPAL',
            name: 'PC Principal',
            basePath: '/mock/pc-principal',
            lastSync: '2025-10-08T09:00:00Z',
            status: 'online'
          }
        }
      }),
      getDecision: vi.fn().mockImplementation((decisionId: string) => {
        if (decisionId === 'test-decision-complete') {
          return {
            id: 'test-decision-complete',
            type: 'config',
            status: 'applied',
            title: 'Décision complète avec historique',
            description: 'Test decision with complete history',
            files: ['.config/complete.json'],
            sourceMachine: 'PC-PRINCIPAL',
            targetMachines: ['MAC-DEV'],
            createdAt: '2025-10-08T09:00:00Z',
            approvedAt: '2025-10-08T09:30:00Z',
            appliedAt: '2025-10-08T10:00:00Z',
            rollbackPoint: {
              backupPath: '/mock/backup',
              files: ['.config/complete.json']
            },
            history: [
              {
                action: 'created',
                timestamp: '2025-10-08T09:00:00Z',
                details: 'Décision créée'
              },
              {
                action: 'approved',
                timestamp: '2025-10-08T09:30:00Z',
                details: 'Décision approuvée'
              },
              {
                action: 'applied',
                timestamp: '2025-10-08T10:00:00Z',
                details: 'Décision appliquée'
              }
            ]
          };
        }
        if (decisionId === 'test-decision-rejected') {
          return {
            id: 'test-decision-rejected',
            type: 'config',
            status: 'rejected',
            title: 'Décision rejetée',
            description: 'Test rejected decision',
            files: ['.config/rejected.json'],
            sourceMachine: 'PC-PRINCIPAL',
            targetMachines: ['MAC-DEV'],
            createdAt: '2025-10-08T09:00:00Z',
            rejectedAt: '2025-10-08T09:45:00Z',
            rejectionReason: 'Configuration incompatible',
            history: [
              {
                action: 'created',
                timestamp: '2025-10-08T09:00:00Z',
                details: 'Décision créée'
              },
              {
                action: 'rejected',
                timestamp: '2025-10-08T09:45:00Z',
                details: 'Décision rejetée: Configuration incompatible'
              }
            ]
          };
        }
        if (decisionId === 'test-decision-rolledback') {
          return {
            id: 'test-decision-rolledback',
            type: 'config',
            status: 'rolledback',
            title: 'Décision avec rollback',
            description: 'Test decision with rollback',
            files: ['.config/rollback.json'],
            sourceMachine: 'PC-PRINCIPAL',
            targetMachines: ['MAC-DEV'],
            createdAt: '2025-10-08T09:00:00Z',
            appliedAt: '2025-10-08T10:00:00Z',
            rolledbackAt: '2025-10-08T11:00:00Z',
            rollbackPoint: {
              backupPath: '/mock/backup',
              files: ['.config/rollback.json']
            },
            history: [
              {
                action: 'created',
                timestamp: '2025-10-08T09:00:00Z',
                details: 'Décision créée'
              },
              {
                action: 'applied',
                timestamp: '2025-10-08T10:00:00Z',
                details: 'Décision appliquée'
              },
              {
                action: 'rolledback',
                timestamp: '2025-10-08T11:00:00Z',
                details: 'Décision annulée (rollback)'
              }
            ]
          };
        }
        return null;
      }),
      loadDashboard: vi.fn().mockResolvedValue({
        version: '2.0.0',
        lastUpdate: '2025-10-08T10:00:00Z',
        overallStatus: 'diverged',
        machines: {
          'PC-PRINCIPAL': {
            id: 'PC-PRINCIPAL',
            name: 'PC Principal',
            lastSync: '2025-10-08T09:00:00Z',
            status: 'online',
            diffsCount: 2,
            pendingDecisions: 1
          }
        }
      })
    }))
  };
  
  // Mock de la fonction getRooSyncService
  const getRooSyncService = vi.fn(() => service.getInstance());
  
  return {
    mockRooSyncService: service,
    mockRooSyncServiceError: errorClass,
    mockGetRooSyncService: getRooSyncService
  };
});

vi.mock('../../../../src/services/RooSyncService.js', () => ({
  RooSyncService: mockRooSyncService,
  RooSyncServiceError: mockRooSyncServiceError,
  getRooSyncService: mockGetRooSyncService
}));

import { RooSyncService } from '../../../../src/services/RooSyncService.js';
import { roosyncGetDecisionDetails } from '../../../../src/tools/roosync/get-decision-details.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('roosync_get_decision_details', () => {
  const testDir = join(__dirname, '../../../fixtures/roosync-details-test');

  beforeEach(() => {
    // Setup test environment
    mkdirSync(testDir, { recursive: true });

    // Create test dashboard and roadmap
    const dashboard = {
      version: '2.0.0',
      lastUpdate: '2025-10-08T10:00:00Z',
      overallStatus: 'synced',
      machines: {
        'PC-PRINCIPAL': {
          lastSync: '2025-10-08T09:00:00Z',
          status: 'online',
          diffsCount: 0,
          pendingDecisions: 0
        }
      }
    };

    const roadmap = `# Roadmap RooSync

## Décisions de Synchronisation

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-complete\`
**Titre:** Décision complète avec historique
**Statut:** applied
**Type:** config
**Chemin:** \`.config/complete.json\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** MAC-DEV
**Créé:** 2025-10-08T09:00:00Z
**Approuvé le:** 2025-10-08T09:30:00Z
**Approuvé par:** PC-PRINCIPAL
**Commentaire:** Validation complète
**Appliqué le:** 2025-10-08T10:00:00Z
**Appliqué par:** PC-PRINCIPAL
**Rollback disponible:** Oui
<!-- DECISION_BLOCK_END -->

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-rejected\`
**Titre:** Décision rejetée
**Statut:** rejected
**Type:** file
**Chemin:** \`test.txt\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** all
**Créé:** 2025-10-08T09:00:00Z
**Rejeté le:** 2025-10-08T09:15:00Z
**Rejeté par:** PC-PRINCIPAL
**Motif:** Configuration incorrecte
<!-- DECISION_BLOCK_END -->

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-rolledback\`
**Titre:** Décision annulée
**Statut:** rolled_back
**Type:** setting
**Chemin:** \`settings.json\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** MAC-DEV
**Créé:** 2025-10-08T08:00:00Z
**Approuvé le:** 2025-10-08T08:30:00Z
**Approuvé par:** PC-PRINCIPAL
**Appliqué le:** 2025-10-08T09:00:00Z
**Appliqué par:** PC-PRINCIPAL
**Rollback le:** 2025-10-08T10:30:00Z
**Rollback par:** PC-PRINCIPAL
**Raison:** Problème de compatibilité
<!-- DECISION_BLOCK_END -->
`;

    writeFileSync(join(testDir, 'sync-dashboard.json'), JSON.stringify(dashboard), 'utf-8');
    writeFileSync(join(testDir, 'sync-roadmap.md'), roadmap, 'utf-8');
    
    // Create dummy baseline for BaselineService
    const baseline = {
      version: "1.0.0",
      baselineId: "test-baseline-001",
      machineId: "PC-PRINCIPAL",
      timestamp: "2025-10-08T10:00:00Z",
      machines: [
        {
          id: "PC-PRINCIPAL",
          roo: { modes: [], mcpServers: [] },
          hardware: { cpu: {}, memory: {} },
          software: {},
          system: {}
        }
      ]
    };
    writeFileSync(join(testDir, 'sync-config.ref.json'), JSON.stringify(baseline), 'utf-8');
    
    // Mock fs pour utiliser les fichiers de test
    vi.mock('fs', async () => ({
      readFileSync: vi.fn((path: string) => {
        if (path.includes('sync-roadmap.md')) {
          return `# Roadmap RooSync

## Décisions de Synchronisation

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-complete\`
**Titre:** Décision complète avec historique
**Statut:** applied
**Type:** config
**Chemin:** \`.config/complete.json\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** MAC-DEV
**Créé:** 2025-10-08T09:00:00Z
**Approuvé le:** 2025-10-08T09:30:00Z
**Approuvé par:** PC-PRINCIPAL
**Commentaire:** Validation complète
**Appliqué le:** 2025-10-08T10:00:00Z
**Appliqué par:** PC-PRINCIPAL
<!-- DECISION_BLOCK_END -->

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-rejected\`
**Titre:** Décision rejetée
**Statut:** rejected
**Type:** file
**Chemin:** \`rejected.txt\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** all
**Créé:** 2025-10-08T06:00:00Z
**Rejeté le:** 2025-10-08T11:00:00Z
**Rejeté par:** PC-PRINCIPAL
**Motif:** Configuration incorrecte
<!-- DECISION_BLOCK_END -->

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-rolledback\`
**Titre:** Décision annulée
**Statut:** rolled_back
**Type:** config
**Chemin:** \`.config/rollback.json\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** MAC-DEV
**Créé:** 2025-10-08T05:00:00Z
**Appliqué le:** 2025-10-08T09:00:00Z
**Rollback le:** 2025-10-08T12:00:00Z
**Rollback par:** PC-PRINCIPAL
**Raison:** Problème de compatibilité
<!-- DECISION_BLOCK_END -->
`;
        }
        return '';
      }),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      rmSync: vi.fn()
    }));
    
    // Mock environment
    process.env.ROOSYNC_SHARED_PATH = testDir;
    process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';
    process.env.ROOSYNC_AUTO_SYNC = 'false';
    process.env.ROOSYNC_CONFLICT_STRATEGY = 'manual';
    process.env.ROOSYNC_LOG_LEVEL = 'info';

    RooSyncService.resetInstance();
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore
    }
    RooSyncService.resetInstance();
  });

  it('devrait récupérer les détails complets d\'une décision', async () => {
    const result = await roosyncGetDecisionDetails({
      decisionId: 'test-decision-complete'
    });

    expect(result.decision).toBeDefined();
    expect(result.decision.id).toBe('test-decision-complete');
    expect(result.decision.status).toBe('applied');
    expect(result.decision.type).toBe('config');
  });

  it('devrait inclure l\'historique par défaut', async () => {
    const result = await roosyncGetDecisionDetails({
      decisionId: 'test-decision-complete'
    });

    expect(result.history).toBeDefined();
    expect(result.history?.created).toBeDefined();
    expect(result.history?.approved).toBeDefined();
    expect(result.history?.applied).toBeDefined();
  });

  it('devrait exclure l\'historique si demandé', async () => {
    const result = await roosyncGetDecisionDetails({
      decisionId: 'test-decision-complete',
      includeHistory: false
    });

    expect(result.history).toBeUndefined();
  });

  it('devrait parser l\'historique de rejet', async () => {
    const result = await roosyncGetDecisionDetails({
      decisionId: 'test-decision-rejected'
    });

    expect(result.history?.rejected).toBeDefined();
    expect(result.history?.rejected?.reason).toBe('Configuration incorrecte');
  });

  it('devrait parser l\'historique de rollback', async () => {
    const result = await roosyncGetDecisionDetails({
      decisionId: 'test-decision-rolledback'
    });

    expect(result.history?.rolledBack).toBeDefined();
    expect(result.history?.rolledBack?.reason).toBe('Problème de compatibilité');
  });

  it('devrait inclure les informations de rollback pour décision appliquée', async () => {
    const result = await roosyncGetDecisionDetails({
      decisionId: 'test-decision-complete'
    });

    expect(result.rollbackPoint).toBeDefined();
    expect(result.rollbackPoint?.available).toBe(true);
  });

  it('devrait lever une erreur si décision introuvable', async () => {
    await expect(roosyncGetDecisionDetails({
      decisionId: 'nonexistent'
    })).rejects.toThrow('introuvable');
  });

  it('devrait inclure les logs d\'exécution pour décisions appliquées', async () => {
    const result = await roosyncGetDecisionDetails({
      decisionId: 'test-decision-complete',
      includeLogs: true
    });

    expect(result.executionLogs).toBeDefined();
    expect(Array.isArray(result.executionLogs)).toBe(true);
  });
});