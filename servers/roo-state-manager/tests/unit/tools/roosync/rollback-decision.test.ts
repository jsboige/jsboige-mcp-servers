/**
 * Tests pour roosync_rollback_decision
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

// Désactiver le mock global de fs pour ce test qui utilise le système de fichiers réel
vi.unmock('fs');
import { tmpdir } from 'os';
import { RooSyncService } from '../../../../src/services/RooSyncService.js';
import { roosyncRollbackDecision } from '../../../../src/tools/roosync/rollback-decision.js';

describe('roosync_rollback_decision', () => {
  const testDir = join(tmpdir(), `roosync-rollback-test-${Date.now()}`);

  beforeEach(() => {
    // Setup test environment
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Déjà existant
    }

    // Mock environment
    process.env.ROOSYNC_SHARED_PATH = testDir;
    process.env.ROOSYNC_MACHINE_ID = 'PC-PRINCIPAL';

    // Force reset et injection de config
    RooSyncService.resetInstance();
    const service = RooSyncService.getInstance(undefined, {
      sharedPath: testDir,
      machineId: 'PC-PRINCIPAL',
      autoSync: false,
      conflictStrategy: 'manual',
      logLevel: 'info'
    });

    // Create test dashboard and roadmap
    const dashboard = {
      version: '2.0.0',
      lastUpdate: '2025-10-08T10:00:00Z',
      overallStatus: 'diverged',
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

    writeFileSync(join(testDir, 'sync-dashboard.json'), JSON.stringify(dashboard), 'utf-8');
    writeFileSync(join(testDir, 'sync-roadmap.md'), roadmap, 'utf-8');

    // Créer répertoire .rollback avec backup simulé
    const rollbackDir = join(testDir, '.rollback');
    mkdirSync(rollbackDir, { recursive: true });

    // Créer backup simulé pour test-decision-applied
    const backupPath = join(rollbackDir, `test-decision-applied_${Date.now()}`);
    mkdirSync(backupPath, { recursive: true });
    writeFileSync(join(backupPath, 'backup-info.json'), JSON.stringify({
      decisionId: 'test-decision-applied',
      timestamp: new Date().toISOString(),
      files: ['.config/test.json']
    }), 'utf-8');

    // Mock restoreFromRollbackPoint pour simuler succès du rollback
    vi.spyOn(service, 'restoreFromRollbackPoint').mockResolvedValue({
      success: true,
      restoredFiles: ['.config/test.json'],
      logs: [
        '[ROLLBACK] Recherche du point de rollback...',
        '[ROLLBACK] Point de rollback trouvé',
        '[ROLLBACK] Restauration de .config/test.json',
        '[ROLLBACK] Rollback terminé avec succès'
      ]
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
    await expect(roosyncRollbackDecision({
      decisionId: 'test-decision-pending',
      reason: 'Test'
    })).rejects.toThrow('pas encore appliquée');
  });

  it('devrait lever une erreur si décision introuvable', async () => {
    await expect(roosyncRollbackDecision({
      decisionId: 'nonexistent',
      reason: 'Test'
    })).rejects.toThrow('introuvable');
  });

  it('devrait retourner la liste des fichiers restaurés', async () => {
    const result = await roosyncRollbackDecision({
      decisionId: 'test-decision-applied',
      reason: 'Restauration de test'
    });

    expect(Array.isArray(result.restoredFiles)).toBe(true);
    expect(result.restoredFiles.length).toBeGreaterThanOrEqual(0);
  });

  it('devrait inclure les logs d\'exécution', async () => {
    const result = await roosyncRollbackDecision({
      decisionId: 'test-decision-applied',
      reason: 'Test logs'
    });

    expect(Array.isArray(result.executionLog)).toBe(true);
    expect(result.executionLog.length).toBeGreaterThan(0);
    expect(result.executionLog.some(log => log.includes('ROLLBACK'))).toBe(true);
  });

  it('devrait mettre à jour sync-roadmap.md', async () => {
    const result = await roosyncRollbackDecision({
      decisionId: 'test-decision-applied',
      reason: 'Mise à jour roadmap'
    });

    expect(result.newStatus).toBe('rolled_back');

    // Vérifier que le fichier a été mis à jour
    const roadmapContent = readFileSync(join(testDir, 'sync-roadmap.md'), 'utf-8');
    expect(roadmapContent).toContain('**Statut:** rolled_back');
    expect(roadmapContent).toContain('**Rollback le:**');
    expect(roadmapContent).toContain('**Raison:** Mise à jour roadmap');
  });

  it('devrait inclure la date du rollback au format ISO 8601', async () => {
    const result = await roosyncRollbackDecision({
      decisionId: 'test-decision-applied',
      reason: 'Test date'
    });

    // Vérifier format ISO 8601
    expect(result.rolledBackAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});