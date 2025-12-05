/**
 * Tests pour roosync_approve_decision
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

// Désactiver le mock global de fs pour ce test qui utilise le système de fichiers réel
vi.unmock('fs');
import { tmpdir } from 'os';
import { RooSyncService } from '../../../../src/services/RooSyncService.js';
import { roosyncApproveDecision, ApproveDecisionArgs } from '../../../../src/tools/roosync/approve-decision.js';

describe('roosync_approve_decision', () => {
  const testDir = join(tmpdir(), `roosync-approve-test-${Date.now()}`);

  beforeEach(() => {
    // Créer répertoire de test
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Déjà existant
    }

    // Mock environnement
    process.env.ROOSYNC_SHARED_PATH = testDir;

    // Force reset et injection de config
    RooSyncService.resetInstance();
    RooSyncService.getInstance(undefined, {
      sharedPath: testDir,
      machineId: 'PC-PRINCIPAL',
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
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
  });

  it('devrait approuver une décision pending', async () => {
    // Arrange
    const args: ApproveDecisionArgs = {
      decisionId: 'test-decision-001',
      comment: 'Approuvé pour test'
    };

    // Debug
    const service = RooSyncService.getInstance();
    process.stdout.write(`DEBUG TEST: Service Config sharedPath: ${service.getConfig().sharedPath}\n`);
    process.stdout.write(`DEBUG TEST: Expected testDir: ${testDir}\n`);

    try {
        const decisions = await service.loadDecisions();
        process.stdout.write(`DEBUG TEST: Decisions loaded: ${JSON.stringify(decisions, null, 2)}\n`);
    } catch (e) {
        process.stdout.write(`DEBUG TEST: Error loading decisions: ${e}\n`);
    }

    process.stdout.write(`DEBUG TEST: File content:\n${readFileSync(join(testDir, 'sync-roadmap.md'), 'utf-8')}\n`);

    // Act
    const result = await roosyncApproveDecision(args);

    // Assert
    expect(result.decisionId).toBe('test-decision-001');
    expect(result.previousStatus).toBe('pending');
    expect(result.newStatus).toBe('approved');
    expect(result.approvedBy).toBe('PC-PRINCIPAL');
    expect(result.comment).toBe('Approuvé pour test');
    expect(result.nextSteps).toHaveLength(3);

    // Vérifier que le fichier a été modifié
    const roadmapContent = readFileSync(join(testDir, 'sync-roadmap.md'), 'utf-8');
    expect(roadmapContent).toContain('**Statut:** approved');
    expect(roadmapContent).toContain('**Approuvé par:** PC-PRINCIPAL');
    expect(roadmapContent).toContain('**Commentaire:** Approuvé pour test');
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

    const roadmapContent = readFileSync(join(testDir, 'sync-roadmap.md'), 'utf-8');
    expect(roadmapContent).not.toContain('**Commentaire:**');
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