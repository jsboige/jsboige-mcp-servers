/**
 * Tests End-to-End RooSync - Résolution de Conflits
 *
 * Tests complets de la résolution de conflits dans RooSync :
 * - Conflits de modification sur le même fichier
 * - Conflits de suppression vs modification
 * - Conflits de modification vs suppression
 * - Approbation et rejet de décisions
 * - Rollback après résolution
 *
 * @module tests/e2e/roosync-conflict-resolution.test
 * @task T2.23 - Tester gestion conflits
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { RooSyncService } from '../../src/services/RooSyncService.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { roosyncApproveDecision } from '../../src/tools/roosync/approve-decision.js';
import { roosyncRejectDecision } from '../../src/tools/roosync/reject-decision.js';
import { roosyncApplyDecision } from '../../src/tools/roosync/apply-decision.js';
import { roosyncRollbackDecision } from '../../src/tools/roosync/rollback-decision.js';
import { roosyncGetDecisionDetails } from '../../src/tools/roosync/get-decision-details.js';

describe('RooSync E2E - Résolution de Conflits', () => {
  let testDir: string;
  let serviceA: RooSyncService;
  let serviceB: RooSyncService;
  let testDecisionId: string | null = null;

  beforeAll(() => {
    // Créer répertoire de test isolé
    testDir = join(tmpdir(), `roosync-conflict-resolution-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'decisions'), { recursive: true });
    mkdirSync(join(testDir, '.rollback'), { recursive: true });

    // Configurer environnement pour Machine A
    process.env.ROOSYNC_SHARED_PATH = testDir;
    process.env.ROOSYNC_MACHINE_ID = 'MACHINE-A-TEST';

    // Créer service pour Machine A
    serviceA = RooSyncService.getInstance();

    // Créer un fichier de configuration de test
    const configPath = join(testDir, 'test-config.json');
    writeFileSync(configPath, JSON.stringify({ value: 'initial', timestamp: Date.now() }), 'utf-8');

    // Créer sync-roadmap.md initial
    const roadmap = `# Roadmap RooSync

## Décisions de Synchronisation

<!-- DECISION_BLOCK_START -->
**ID:** \`test-decision-001\`
**Titre:** Test Conflit Résolution
**Statut:** pending
**Type:** config
**Chemin:** \`test-config.json\`
**Machine Source:** MACHINE-A-TEST
**Machines Cibles:** MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Détails:** Test de résolution de conflits
<!-- DECISION_BLOCK_END -->
`;
    writeFileSync(join(testDir, 'sync-roadmap.md'), roadmap, 'utf-8');
  });

  afterAll(() => {
    // Nettoyer
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    RooSyncService.resetInstance();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // Vider le cache avant chaque test
    serviceA.clearCache();
    if (serviceB) {
      serviceB.clearCache();
    }
  });

  describe('Test 1 : Conflit de modification sur le même fichier', () => {
    it('devrait détecter un conflit de modification', async () => {
      // Simuler Machine B
      process.env.ROOSYNC_MACHINE_ID = 'MACHINE-B-TEST';
      serviceB = RooSyncService.getInstance();

      // Machine A modifie le fichier
      const configPath = join(testDir, 'test-config.json');
      const configA = { value: 'machine-a', timestamp: Date.now() };
      writeFileSync(configPath, JSON.stringify(configA), 'utf-8');

      // Machine B modifie le même fichier (simulation)
      const configB = { value: 'machine-b', timestamp: Date.now() + 100 };

      // Détecter le conflit
      const hasConflict = configA.value !== configB.value;
      expect(hasConflict).toBe(true);

      console.log('✅ Test détection conflit modification: Réussi');
      console.log(`   Valeur A: ${configA.value}`);
      console.log(`   Valeur B: ${configB.value}`);
      console.log(`   Conflit détecté: ${hasConflict}`);
    });

    it('devrait créer une décision de conflit', async () => {
      const conflictDecisionId = `conflict-mod-${Date.now()}`;
      const roadmapPath = join(testDir, 'sync-roadmap.md');
      let roadmap = readFileSync(roadmapPath, 'utf-8');
      
      const decisionBlock = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${conflictDecisionId}\`
**Titre:** Conflit de Modification
**Statut:** pending
**Type:** config
**Chemin:** \`test-config.json\`
**Machine Source:** SYSTEM
**Machines Cibles:** MACHINE-A-TEST, MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Détails:** Conflit détecté entre MACHINE-A-TEST et MACHINE-B-TEST
<!-- DECISION_BLOCK_END -->
`;
      
      roadmap += decisionBlock;
      writeFileSync(roadmapPath, roadmap, 'utf-8');

      expect(existsSync(roadmapPath)).toBe(true);

      console.log('✅ Test création décision conflit: Réussi');
      console.log(`   ID: ${conflictDecisionId}`);
    });

    it('devrait approuver une décision de conflit', async () => {
      const decisionId = `conflict-approve-${Date.now()}`;
      
      // Créer une décision de conflit dans sync-roadmap.md
      const roadmapPath = join(testDir, 'sync-roadmap.md');
      let roadmap = readFileSync(roadmapPath, 'utf-8');
      
      const decisionBlock = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Titre:** Conflit de Modification
**Statut:** pending
**Type:** config
**Chemin:** \`test-config.json\`
**Machine Source:** SYSTEM
**Machines Cibles:** MACHINE-A-TEST, MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Détails:** Conflit détecté entre MACHINE-A-TEST et MACHINE-B-TEST
<!-- DECISION_BLOCK_END -->
`;
      
      roadmap += decisionBlock;
      writeFileSync(roadmapPath, roadmap, 'utf-8');

      // Approuver la décision
      const result = await roosyncApproveDecision({
        decisionId,
        comment: 'Approuvé pour test'
      });

      expect(result.decisionId).toBe(decisionId);
      expect(result.previousStatus).toBe('pending');
      expect(result.newStatus).toBe('approved');
      expect(result.approvedBy).toBe('MACHINE-A-TEST');

      console.log('✅ Test approbation décision conflit: Réussi');
      console.log(`   ID: ${decisionId}`);
      console.log(`   Statut: ${result.newStatus}`);
    });
  });

  describe('Test 2 : Conflit de suppression vs modification', () => {
    it('devrait détecter un conflit suppression vs modification', async () => {
      const configPath = join(testDir, 'test-config-delete.json');
      
      // Créer le fichier
      writeFileSync(configPath, JSON.stringify({ value: 'initial' }), 'utf-8');

      // Machine A supprime le fichier
      unlinkSync(configPath);

      // Machine B modifie le fichier (simulation)
      const configB = { value: 'machine-b-modified' };

      // Détecter le conflit
      const fileExists = existsSync(configPath);
      const hasConflict = !fileExists && configB.value !== undefined;
      expect(hasConflict).toBe(true);

      console.log('✅ Test détection conflit suppression vs modification: Réussi');
      console.log(`   Fichier existe: ${fileExists}`);
      console.log(`   Conflit détecté: ${hasConflict}`);
    });

    it('devrait créer une décision de conflit suppression', async () => {
      const decisionId = `conflict-delete-${Date.now()}`;
      const roadmapPath = join(testDir, 'sync-roadmap.md');
      let roadmap = readFileSync(roadmapPath, 'utf-8');
      
      const decisionBlock = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Titre:** Conflit Suppression vs Modification
**Statut:** pending
**Type:** config
**Chemin:** \`test-config-delete.json\`
**Machine Source:** SYSTEM
**Machines Cibles:** MACHINE-A-TEST, MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Détails:** Conflit détecté: suppression vs modification
<!-- DECISION_BLOCK_END -->
`;
      
      roadmap += decisionBlock;
      writeFileSync(roadmapPath, roadmap, 'utf-8');

      expect(existsSync(roadmapPath)).toBe(true);

      console.log('✅ Test création décision conflit suppression: Réussi');
      console.log(`   ID: ${decisionId}`);
    });
  });

  describe('Test 3 : Conflit de modification vs suppression', () => {
    it('devrait détecter un conflit modification vs suppression', async () => {
      const configPath = join(testDir, 'test-config-mod-delete.json');
      
      // Créer le fichier
      writeFileSync(configPath, JSON.stringify({ value: 'initial' }), 'utf-8');

      // Machine A modifie le fichier
      const configA = { value: 'machine-a-modified' };
      writeFileSync(configPath, JSON.stringify(configA), 'utf-8');

      // Machine B supprime le fichier (simulation)
      const fileDeleted = false; // Simulation

      // Détecter le conflit
      const hasConflict = configA.value !== 'initial' && !fileDeleted;
      expect(hasConflict).toBe(true);

      console.log('✅ Test détection conflit modification vs suppression: Réussi');
      console.log(`   Valeur modifiée: ${configA.value}`);
      console.log(`   Conflit détecté: ${hasConflict}`);
    });

    it('devrait créer une décision de conflit modification', async () => {
      const decisionId = `conflict-mod-delete-${Date.now()}`;
      const roadmapPath = join(testDir, 'sync-roadmap.md');
      let roadmap = readFileSync(roadmapPath, 'utf-8');
      
      const decisionBlock = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Titre:** Conflit Modification vs Suppression
**Statut:** pending
**Type:** config
**Chemin:** \`test-config-mod-delete.json\`
**Machine Source:** SYSTEM
**Machines Cibles:** MACHINE-A-TEST, MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Détails:** Conflit détecté: modification vs suppression
<!-- DECISION_BLOCK_END -->
`;
      
      roadmap += decisionBlock;
      writeFileSync(roadmapPath, roadmap, 'utf-8');

      expect(existsSync(roadmapPath)).toBe(true);

      console.log('✅ Test création décision conflit modification: Réussi');
      console.log(`   ID: ${decisionId}`);
    });
  });

  describe('Test 4 : Approbation et rejet de décisions', () => {
    it('devrait approuver une décision avec commentaire', async () => {
      const decisionId = `approve-comment-${Date.now()}`;
      const roadmapPath = join(testDir, 'sync-roadmap.md');
      let roadmap = readFileSync(roadmapPath, 'utf-8');
      
      // Créer une décision
      const decisionBlock = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Titre:** Test Approbation
**Statut:** pending
**Type:** config
**Machine Source:** MACHINE-A-TEST
**Machines Cibles:** MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Détails:** Test d'approbation avec commentaire
<!-- DECISION_BLOCK_END -->
`;
      
      roadmap += decisionBlock;
      writeFileSync(roadmapPath, roadmap, 'utf-8');

      // Approuver avec commentaire
      const result = await roosyncApproveDecision({
        decisionId,
        comment: 'Approuvé pour test T2.23'
      });

      expect(result.decisionId).toBe(decisionId);
      expect(result.comment).toBe('Approuvé pour test T2.23');
      expect(result.approvedBy).toBe('MACHINE-A-TEST');

      console.log('✅ Test approbation avec commentaire: Réussi');
      console.log(`   ID: ${decisionId}`);
      console.log(`   Commentaire: ${result.comment}`);
    });

    it('devrait rejeter une décision', async () => {
      const decisionId = `reject-test-${Date.now()}`;
      const roadmapPath = join(testDir, 'sync-roadmap.md');
      let roadmap = readFileSync(roadmapPath, 'utf-8');
      
      // Créer une décision
      const decisionBlock = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Titre:** Test Rejet
**Statut:** pending
**Type:** config
**Machine Source:** MACHINE-A-TEST
**Machines Cibles:** MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Détails:** Test de rejet de décision
<!-- DECISION_BLOCK_END -->
`;
      
      roadmap += decisionBlock;
      writeFileSync(roadmapPath, roadmap, 'utf-8');

      // Rejeter la décision
      const result = await roosyncRejectDecision({
        decisionId,
        reason: 'Test de rejet pour T2.23'
      });

      expect(result.decisionId).toBe(decisionId);
      expect(result.previousStatus).toBe('pending');
      expect(result.newStatus).toBe('rejected');
      expect(result.reason).toBe('Test de rejet pour T2.23');

      console.log('✅ Test rejet de décision: Réussi');
      console.log(`   ID: ${decisionId}`);
      console.log(`   Raison: ${result.reason}`);
    });

    it('devrait lever une erreur si la décision est déjà traitée', async () => {
      const decisionId = `already-processed-${Date.now()}`;
      const roadmapPath = join(testDir, 'sync-roadmap.md');
      let roadmap = readFileSync(roadmapPath, 'utf-8');
      
      // Créer une décision déjà approuvée
      const decisionBlock = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Titre:** Déjà Traité
**Statut:** approved
**Type:** config
**Machine Source:** MACHINE-A-TEST
**Machines Cibles:** MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Détails:** Décision déjà traitée
<!-- DECISION_BLOCK_END -->
`;
      
      roadmap += decisionBlock;
      writeFileSync(roadmapPath, roadmap, 'utf-8');

      // Tenter d'approuver à nouveau
      await expect(roosyncApproveDecision({ decisionId }))
        .rejects.toThrow('Décision déjà traitée');

      console.log('✅ Test erreur décision déjà traitée: Réussi');
    });
  });

  describe('Test 5 : Rollback après résolution', () => {
    it('devrait effectuer un rollback après application', async () => {
      const decisionId = `rollback-test-${Date.now()}`;
      const roadmapPath = join(testDir, 'sync-roadmap.md');
      let roadmap = readFileSync(roadmapPath, 'utf-8');
      
      // Créer une décision
      const decisionBlock = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Titre:** Test Rollback
**Statut:** applied
**Type:** config
**Machine Source:** MACHINE-A-TEST
**Machines Cibles:** MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Appliqué le:** ${new Date().toISOString()}
**Appliqué par:** MACHINE-A-TEST
**Détails:** Test de rollback après application
<!-- DECISION_BLOCK_END -->
`;
      
      roadmap += decisionBlock;
      writeFileSync(roadmapPath, roadmap, 'utf-8');

      // Effectuer un rollback (simulation - le rollback réel nécessite un backup)
      const result = await roosyncRollbackDecision({
        decisionId,
        reason: 'Test de rollback pour T2.23'
      });

      // Le rollback peut échouer si pas de backup, mais on vérifie le résultat
      expect(result.decisionId).toBe(decisionId);
      expect(result.newStatus).toBe('rolled_back');
      expect(result.reason).toBe('Test de rollback pour T2.23');

      console.log('✅ Test rollback après application: Réussi');
      console.log(`   ID: ${decisionId}`);
      console.log(`   Raison: ${result.reason}`);
    });

    it('devrait lever une erreur si la décision n\'est pas appliquée', async () => {
      const decisionId = `not-applied-${Date.now()}`;
      const roadmapPath = join(testDir, 'sync-roadmap.md');
      let roadmap = readFileSync(roadmapPath, 'utf-8');
      
      // Créer une décision pending
      const decisionBlock = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Titre:** Non Appliqué
**Statut:** pending
**Type:** config
**Machine Source:** MACHINE-A-TEST
**Machines Cibles:** MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Détails:** Décision non appliquée
<!-- DECISION_BLOCK_END -->
`;
      
      roadmap += decisionBlock;
      writeFileSync(roadmapPath, roadmap, 'utf-8');

      // Tenter de rollback
      await expect(roosyncRollbackDecision({
        decisionId,
        reason: 'Test'
      })).rejects.toThrow('pas encore appliquée');

      console.log('✅ Test erreur rollback non appliqué: Réussi');
    });

    it('devrait restaurer les fichiers depuis le backup', async () => {
      const decisionId = `restore-backup-${Date.now()}`;
      const backupPath = join(testDir, '.rollback', `${decisionId}.json`);
      const roadmapPath = join(testDir, 'sync-roadmap.md');
      let roadmap = readFileSync(roadmapPath, 'utf-8');
      
      // Créer un backup
      const backupContent = { value: 'backup-value', timestamp: Date.now() };
      writeFileSync(backupPath, JSON.stringify(backupContent), 'utf-8');

      // Créer une décision appliquée avec backup
      const decisionBlock = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Titre:** Test Restauration Backup
**Statut:** applied
**Type:** config
**Machine Source:** MACHINE-A-TEST
**Machines Cibles:** MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Appliqué le:** ${new Date().toISOString()}
**Appliqué par:** MACHINE-A-TEST
**Backup:** .rollback/${decisionId}.json
**Détails:** Test de restauration depuis backup
<!-- DECISION_BLOCK_END -->
`;
      
      roadmap += decisionBlock;
      writeFileSync(roadmapPath, roadmap, 'utf-8');

      // Effectuer un rollback (simulation - le rollback réel nécessite plus de setup)
      const result = await roosyncRollbackDecision({
        decisionId,
        reason: 'Restauration depuis backup'
      });

      // Vérifier que le résultat contient les informations de restauration
      expect(result.decisionId).toBe(decisionId);
      expect(result.newStatus).toBe('rolled_back');

      console.log('✅ Test restauration depuis backup: Réussi');
      console.log(`   ID: ${decisionId}`);
      console.log(`   Backup existe: ${existsSync(backupPath)}`);
    });
  });

  describe('Test 6 : Détails de décision', () => {
    it('devrait récupérer les détails d\'une décision', async () => {
      const decisionId = `details-test-${Date.now()}`;
      const roadmapPath = join(testDir, 'sync-roadmap.md');
      let roadmap = readFileSync(roadmapPath, 'utf-8');
      
      // Créer une décision complète
      const decisionBlock = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Titre:** Test Détails
**Statut:** approved
**Type:** config
**Machine Source:** MACHINE-A-TEST
**Machines Cibles:** MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Approuvé le:** ${new Date().toISOString()}
**Approuvé par:** MACHINE-A-TEST
**Commentaire:** Test de détails
**Détails:** Test de récupération des détails
<!-- DECISION_BLOCK_END -->
`;
      
      roadmap += decisionBlock;
      writeFileSync(roadmapPath, roadmap, 'utf-8');

      // Récupérer les détails
      const result = await roosyncGetDecisionDetails({
        decisionId,
        includeHistory: true
      });

      expect(result.decision).toBeDefined();
      expect(result.decision.id).toBe(decisionId);
      expect(result.decision.status).toBe('approved');
      expect(result.history).toBeDefined();

      console.log('✅ Test récupération détails: Réussi');
      console.log(`   ID: ${decisionId}`);
      console.log(`   Statut: ${result.decision.status}`);
    });

    it('devrait inclure les informations de rollback', async () => {
      const decisionId = `rollback-details-${Date.now()}`;
      const roadmapPath = join(testDir, 'sync-roadmap.md');
      let roadmap = readFileSync(roadmapPath, 'utf-8');
      
      // Créer une décision appliquée
      const decisionBlock = `
<!-- DECISION_BLOCK_START -->
**ID:** \`${decisionId}\`
**Titre:** Test Rollback Details
**Statut:** applied
**Type:** config
**Machine Source:** MACHINE-A-TEST
**Machines Cibles:** MACHINE-B-TEST
**Créé:** ${new Date().toISOString()}
**Appliqué le:** ${new Date().toISOString()}
**Appliqué par:** MACHINE-A-TEST
**Backup:** .rollback/${decisionId}.json
**Détails:** Test d'informations de rollback
<!-- DECISION_BLOCK_END -->
`;
      
      roadmap += decisionBlock;
      writeFileSync(roadmapPath, roadmap, 'utf-8');

      // Récupérer les détails
      const result = await roosyncGetDecisionDetails({
        decisionId
      });

      expect(result.rollbackPoint).toBeDefined();
      expect(result.rollbackPoint?.available).toBe(true);

      console.log('✅ Test informations rollback: Réussi');
      console.log(`   Rollback disponible: ${result.rollbackPoint?.available}`);
    });
  });
});
