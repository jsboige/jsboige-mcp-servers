/**
 * Tests pour roosync_apply_decision
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

vi.unmock('fs');
import { tmpdir } from 'os';
import { RooSyncService } from '../../../../src/services/RooSyncService.js';
import { roosyncApplyDecision } from '../../../../src/tools/roosync/apply-decision.js';

describe('roosync_apply_decision', () => {
  const testDir = join(tmpdir(), `roosync-apply-test-${Date.now()}`);

  beforeEach(() => {
    // Créer répertoire de test
    try {
      mkdirSync(testDir, { recursive: true });
    } catch (error) {
      // Déjà existant
    }

    // Mock environnement
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

    // Mock executeDecision pour éviter les appels PowerShell réels
    vi.spyOn(service, 'executeDecision').mockResolvedValue({
      success: true,
      logs: ['[MOCK] Exécution simulée réussie'],
      changes: {
        filesModified: ['.config/test.json'],
        filesCreated: [],
        filesDeleted: []
      },
      executionTime: 100
    });

    // Mock createRollbackPoint pour éviter les appels PowerShell réels
    vi.spyOn(service, 'createRollbackPoint').mockResolvedValue(undefined);

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
**ID:** \`test-decision-approved\`
**Titre:** Décision approuvée prête
**Statut:** approved
**Type:** config
**Chemin:** \`.config/test.json\`
**Machine Source:** PC-PRINCIPAL
**Machines Cibles:** MAC-DEV
**Créé:** 2025-10-08T09:00:00Z
**Approuvé le:** 2025-10-08T09:30:00Z
**Approuvé par:** PC-PRINCIPAL
<!-- DECISION_BLOCK_END -->

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-pending\`
**Titre:** Décision pas encore approuvée
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

  it('devrait exécuter en mode dry run', async () => {
    const result = await roosyncApplyDecision({
      decisionId: 'test-decision-approved',
      dryRun: true
    });

    expect(result.newStatus).toBe('applied');
    expect(result.executionLog.some(log => log.includes('DRY RUN'))).toBe(true);
    expect(result.rollbackAvailable).toBe(false);
  });

  it('devrait lever une erreur si décision pas approuvée', async () => {
    await expect(roosyncApplyDecision({
      decisionId: 'test-decision-pending'
    })).rejects.toThrow('pas encore approuvée');
  });

  it('devrait inclure les logs d\'exécution', async () => {
    const result = await roosyncApplyDecision({
      decisionId: 'test-decision-approved',
      dryRun: true
    });

    expect(result.executionLog.length).toBeGreaterThan(0);
    expect(Array.isArray(result.executionLog)).toBe(true);
  });

  it('devrait retourner la structure de changements', async () => {
    const result = await roosyncApplyDecision({
      decisionId: 'test-decision-approved',
      dryRun: true
    });

    expect(result.changes).toHaveProperty('filesModified');
    expect(result.changes).toHaveProperty('filesCreated');
    expect(result.changes).toHaveProperty('filesDeleted');
  });

  it('devrait lever une erreur si décision introuvable', async () => {
    await expect(roosyncApplyDecision({
      decisionId: 'nonexistent'
    })).rejects.toThrow('introuvable');
  });

  it('devrait créer un point de rollback en mode normal', async () => {
    const result = await roosyncApplyDecision({
      decisionId: 'test-decision-approved',
      dryRun: false
    });

    expect(result.rollbackAvailable).toBe(true);
    expect(result.executionLog.some(log => log.includes('ROLLBACK'))).toBe(true);
  });

  it('devrait mettre à jour sync-roadmap.md en mode normal', async () => {
    const result = await roosyncApplyDecision({
      decisionId: 'test-decision-approved',
      dryRun: false
    });

    expect(result.newStatus).toBe('applied');
    expect(result.appliedBy).toBe('PC-PRINCIPAL');

    // Vérifier que le fichier a été mis à jour
    const roadmapContent = readFileSync(join(testDir, 'sync-roadmap.md'), 'utf-8');
    expect(roadmapContent).toContain('**Statut:** applied');
    expect(roadmapContent).toContain('**Appliqué le:**');
  });
});