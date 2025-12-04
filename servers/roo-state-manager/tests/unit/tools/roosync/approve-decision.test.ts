/**
 * Tests pour roosync_approve_decision
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RooSyncService } from '../../../../src/services/RooSyncService.js';
import { roosyncApproveDecision, ApproveDecisionArgs } from '../../../../src/tools/roosync/approve-decision.js';

// Mock fs module pour contourner le bug Vitest
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => true)
}));

describe('roosync_approve_decision', () => {
  const testDir = join(tmpdir(), `roosync-approve-test-${Date.now()}`);

  let service: RooSyncService;

  beforeEach(async () => {
    // Configurer les mocks fs avant toute utilisation
    const fs = await import('fs');
    const path = await import('path');
    
    // Mock readFileSync pour retourner le contenu du roadmap
    (fs.readFileSync as any) = vi.fn().mockImplementation((filePath: string) => {
      if (filePath.includes('sync-roadmap.md')) {
        return roadmap;
      }
      return '';
    });
    
    // Mock writeFileSync pour capturer les écritures
    (fs.writeFileSync as any) = vi.fn().mockImplementation(() => {});
    
    // Mock mkdirSync et rmSync pour éviter les erreurs
    (fs.mkdirSync as any) = vi.fn().mockImplementation(() => {});
    (fs.rmSync as any) = vi.fn().mockImplementation(() => {});
    (path.join as any) = vi.fn().mockImplementation((...args: string[]) => args.join('/'));

    // Créer répertoire de test
    try {
      fs.mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Déjà existant
    }

    // Mock environnement
    process.env.ROOSYNC_SHARED_PATH = testDir;

    // Force reset et injection de config
    RooSyncService.resetInstance();
    service = RooSyncService.getInstance(undefined, {
      sharedPath: testDir,
      machineId: 'PC-PRINCIPAL',
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    });

    // Créer les décisions de test
    const testDecisions: any[] = [
      {
        id: 'test-decision-001',
        title: 'Mise à jour configuration test',
        status: 'pending',
        type: 'config',
        path: '.config/test.json',
        sourceMachine: 'PC-PRINCIPAL',
        targetMachines: ['MAC-DEV'],
        createdAt: '2025-10-08T09:00:00Z',
        details: 'Synchroniser paramètres de test'
      },
      {
        id: 'test-decision-002',
        title: 'Décision déjà approuvée',
        status: 'approved',
        type: 'file',
        sourceMachine: 'PC-PRINCIPAL',
        targetMachines: ['all'],
        createdAt: '2025-10-08T08:00:00Z'
      }
    ];

    // Mock getDecision pour contourner le bug Vitest
    (service as any).getDecision = vi.fn().mockImplementation(async (id: string) => {
      const decision = testDecisions.find(d => d.id === id);
      return Promise.resolve(decision || null);
    });

    // Créer dashboard de test
    const dashboard = {
      version: '2.0.0',
      lastUpdate: '2025-10-08T10:00:00Z',
      overallStatus: 'diverged',
      machines: {
        'PC-PRINCIPAL': {
          lastSync: '2025-10-08T09:00:00Z',
          status: 'online',
          diffsCount: 1,
          pendingDecisions: 1
        }
      }
    };

    // Créer roadmap avec décision pending
    const roadmap = `# Roadmap RooSync

## Décisions de Synchronisation

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-001\`
**Titre:** Mise à jour configuration test
**Statut:** pending
**Type:** config
**Chemin:** \`.config/test.json\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** MAC-DEV
**Créé:** 2025-10-08T09:00:00Z
**Détails:** Synchroniser paramètres de test
<!-- DECISION_BLOCK_END -->

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-002\`
**Titre:** Décision déjà approuvée
**Statut:** approved
**Type:** file
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** all
**Créé:** 2025-10-08T08:00:00Z
<!-- DECISION_BLOCK_END -->
`;

    writeFileSync(join(testDir, 'sync-dashboard.json'), JSON.stringify(dashboard), 'utf-8');
    writeFileSync(join(testDir, 'sync-roadmap.md'), roadmap, 'utf-8');
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

  it('devrait approuver une décision pending', async () => {
    // Arrange
    const args: ApproveDecisionArgs = {
      decisionId: 'test-decision-001',
      comment: 'Approuvé pour test'
    };

    // Act
    const result = await roosyncApproveDecision(args);

    // Assert
    expect(result.decisionId).toBe('test-decision-001');
    expect(result.previousStatus).toBe('pending');
    expect(result.newStatus).toBe('approved');
    expect(result.approvedBy).toBe('PC-PRINCIPAL');
    expect(result.comment).toBe('Approuvé pour test');
    expect(result.nextSteps).toHaveLength(3);

    // Vérifier que writeFileSync a été appelé avec le bon contenu
    expect(writeFileSync).toHaveBeenCalledWith(
      join(testDir, 'sync-roadmap.md'),
      expect.stringContaining('**Statut:** approved'),
      'utf-8'
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      join(testDir, 'sync-roadmap.md'),
      expect.stringContaining('**Approuvé par:** PC-PRINCIPAL'),
      'utf-8'
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      join(testDir, 'sync-roadmap.md'),
      expect.stringContaining('**Commentaire:** Approuvé pour test'),
      'utf-8'
    );
  });

  it('devrait approuver sans commentaire', async () => {
    // Arrange
    const args: ApproveDecisionArgs = {
      decisionId: 'test-decision-001'
    };

    // Act
    const result = await roosyncApproveDecision(args);

    // Assert
    expect(result.comment).toBeUndefined();

    // Vérifier que writeFileSync a été appelé sans commentaire
    expect(writeFileSync).toHaveBeenCalledWith(
      join(testDir, 'sync-roadmap.md'),
      expect.not.stringContaining('**Commentaire:**'),
      'utf-8'
    );
  });

  it('devrait lever une erreur si la décision n\'existe pas', async () => {
    // Arrange
    const args: ApproveDecisionArgs = {
      decisionId: 'nonexistent'
    };

    // Act & Assert
    await expect(roosyncApproveDecision(args)).rejects.toThrow('Décision \'nonexistent\' introuvable');
  });

  it('devrait lever une erreur si la décision est déjà approuvée', async () => {
    // Arrange
    const args: ApproveDecisionArgs = {
      decisionId: 'test-decision-002'
    };

    // Act & Assert
    await expect(roosyncApproveDecision(args)).rejects.toThrow('Décision déjà traitée');
  });

  it('devrait inclure la date d\'approbation au format ISO', async () => {
    // Arrange
    const args: ApproveDecisionArgs = {
      decisionId: 'test-decision-001'
    };

    // Act
    const result = await roosyncApproveDecision(args);

    // Assert
    expect(result.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});