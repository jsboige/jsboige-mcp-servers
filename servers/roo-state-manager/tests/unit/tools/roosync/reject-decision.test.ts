/**
 * Tests pour roosync_reject_decision
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { RooSyncService } from '../../../../src/services/RooSyncService.js';
import { roosyncRejectDecision, RejectDecisionArgs } from '../../../../src/tools/roosync/reject-decision.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('roosync_reject_decision', () => {
  const testDir = join(__dirname, '../../../fixtures/roosync-reject-test');
  
  beforeEach(() => {
    // Créer répertoire de test
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Déjà existant
    }
    
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
    
    // Créer roadmap avec décisions
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
    
    // Mock environnement
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

  it('devrait rejeter une décision pending avec motif', async () => {
    // Arrange
    const args: RejectDecisionArgs = {
      decisionId: 'test-decision-001',
      reason: 'Configuration incompatible avec environnement de test'
    };
    
    // Act
    const result = await roosyncRejectDecision(args);
    
    // Assert
    expect(result.decisionId).toBe('test-decision-001');
    expect(result.previousStatus).toBe('pending');
    expect(result.newStatus).toBe('rejected');
    expect(result.rejectedBy).toBe('PC-PRINCIPAL');
    expect(result.reason).toBe('Configuration incompatible avec environnement de test');
    expect(result.nextSteps).toHaveLength(3);
    
    // Vérifier que le fichier a été modifié
    const roadmapContent = readFileSync(join(testDir, 'sync-roadmap.md'), 'utf-8');
    expect(roadmapContent).toContain('**Statut:** rejected');
    expect(roadmapContent).toContain('**Rejeté par:** PC-PRINCIPAL');
    expect(roadmapContent).toContain('**Motif:** Configuration incompatible avec environnement de test');
  });
  
  it('devrait lever une erreur si la décision n\'existe pas', async () => {
    // Arrange
    const args: RejectDecisionArgs = {
      decisionId: 'nonexistent',
      reason: 'Test'
    };
    
    // Act & Assert
    await expect(roosyncRejectDecision(args)).rejects.toThrow('Décision \'nonexistent\' introuvable');
  });
  
  it('devrait lever une erreur si la décision est déjà traitée', async () => {
    // Arrange
    const args: RejectDecisionArgs = {
      decisionId: 'test-decision-002',
      reason: 'Test'
    };
    
    // Act & Assert
    await expect(roosyncRejectDecision(args)).rejects.toThrow('Décision déjà traitée');
  });
  
  it('devrait inclure la date de rejet au format ISO', async () => {
    // Arrange
    const args: RejectDecisionArgs = {
      decisionId: 'test-decision-001',
      reason: 'Test de format date'
    };
    
    // Act
    const result = await roosyncRejectDecision(args);
    
    // Assert
    expect(result.rejectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
  
  it('devrait inclure le motif dans le fichier roadmap', async () => {
    // Arrange
    const args: RejectDecisionArgs = {
      decisionId: 'test-decision-001',
      reason: 'Motif spécifique de rejet'
    };
    
    // Act
    await roosyncRejectDecision(args);
    
    // Assert
    const roadmapContent = readFileSync(join(testDir, 'sync-roadmap.md'), 'utf-8');
    expect(roadmapContent).toContain('**Motif:** Motif spécifique de rejet');
  });
});