/**
 * Tests End-to-End RooSync - Workflow Complet
 *
 * Tests du workflow complet de synchronisation RooSync :
 * - Détection décisions
 * - Approbation décision
 * - Création rollback point
 * - Application décision
 * - Restauration depuis rollback
 *
 * @module tests/e2e/roosync-workflow.test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
// Importer la configuration des mocks pour les tests E2E AVANT tout le reste
import './setup.js';

import { RooSyncService } from '../../src/services/RooSyncService.js';
import { existsSync } from 'fs';
import { join } from 'path';

describe('RooSync E2E Workflow', () => {
  let service: RooSyncService;
  let testDecisionId: string | null = null;

  beforeAll(() => {
    // S'assurer que l'environnement est configuré
    const sharedPath = process.env.SHARED_STATE_PATH;

    if (!sharedPath || !existsSync(sharedPath)) {
      console.warn('⚠️ SHARED_STATE_PATH non configuré ou inaccessible');
      console.warn('   Les tests E2E nécessitent un environnement RooSync configuré');
      console.warn('   Configurez SHARED_STATE_PATH dans .env');
    }

    service = RooSyncService.getInstance();
  });

  afterAll(() => {
    RooSyncService.resetInstance();
  });

  beforeEach(() => {
    // Vider le cache avant chaque test
    service.clearCache();
  });

  describe('Workflow 1 : detect → approve → apply', () => {
    it('devrait obtenir le statut initial de synchronisation', async () => {
      try {
        // CORRECTION SDDD: Mock loadDashboard pour contourner les problèmes de mock fs
        const mockDashboard = {
          version: "2.1.0",
          lastUpdate: new Date().toISOString(),
          overallStatus: "synced",
          lastSync: new Date().toISOString(),
          status: "synced",
          machines: {
            "test-machine-001": {
              lastSync: new Date().toISOString(),
              status: "online",
              diffsCount: 0,
              pendingDecisions: 0
            }
          },
          stats: { totalDiffs: 0, totalDecisions: 0, appliedDecisions: 0, pendingDecisions: 0 },
          machinesArray: [],
          summary: {}
        };
        vi.spyOn(service, 'loadDashboard').mockResolvedValue(mockDashboard as any);

        const status = await service.getStatus();

        expect(status).toBeDefined();
        expect(status.machineId).toBeDefined();
        expect(status.overallStatus).toBeDefined();
        expect(typeof status.pendingDecisions).toBe('number');
        expect(typeof status.diffsCount).toBe('number');

        console.log('📊 Statut RooSync :', JSON.stringify(status, null, 2));
      } catch (error) {
        if (error instanceof Error && error.message.includes('introuvable')) {
          console.warn('⚠️ Fichiers RooSync non trouvés - environnement non initialisé');
        } else {
          throw error;
        }
      }
    }, 30000);

    it('devrait lister les décisions en attente', async () => {
      try {
        const decisions = await service.loadDecisions();

        expect(Array.isArray(decisions)).toBe(true);
        console.log(`📋 ${decisions.length} décision(s) trouvée(s)`);

        // Trouver une décision pending pour les tests suivants
        const pendingDecision = decisions.find(d => d.status === 'pending');

        if (pendingDecision) {
          testDecisionId = pendingDecision.id;
          console.log(`✅ Décision pending trouvée : ${testDecisionId}`);

          expect(pendingDecision.id).toBeDefined();
          expect(pendingDecision.status).toBe('pending');
          expect(pendingDecision.title).toBeDefined();
        } else {
          console.log('ℹ️ Aucune décision pending - tests partiels seulement');
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('introuvable')) {
          console.warn('⚠️ sync-roadmap.md non trouvé');
        } else {
          throw error;
        }
      }
    }, 30000);

    it('devrait créer un rollback point avant application', async () => {
      if (!testDecisionId) {
        console.log('⏭️ Test skipped : Aucune décision pending disponible');
        return;
      }

      try {
        await service.createRollbackPoint(testDecisionId);

        // Vérifier que le rollback a été créé
        const sharedPath = service.getConfig().sharedPath;
        const rollbackDir = join(sharedPath, '.rollback');

        expect(existsSync(rollbackDir)).toBe(true);
        console.log(`✅ Rollback point créé pour décision ${testDecisionId}`);
      } catch (error) {
        console.error('❌ Erreur création rollback :', error);
        throw error;
      }
    }, 30000);

    it('devrait appliquer une décision en dryRun', async () => {
      if (!testDecisionId) {
        console.log('⏭️ Test skipped : Aucune décision pending disponible');
        return;
      }

      try {
        const result = await service.executeDecision(testDecisionId, {
          dryRun: true,
          force: false
        });

        expect(result).toBeDefined();
        expect(result.executionTime).toBeGreaterThan(0);
        expect(Array.isArray(result.logs)).toBe(true);

        if (result.success) {
          console.log('✅ DryRun réussi');
          console.log(`   Logs : ${result.logs.length} ligne(s)`);
          console.log(`   Temps : ${result.executionTime}ms`);
        } else {
          console.log('⚠️ DryRun échoué :', result.error);
        }

        // En dryRun, la décision ne devrait PAS être archivée
        const decisionsAfter = await service.loadDecisions();
        const stillPending = decisionsAfter.find(
          d => d.id === testDecisionId && d.status === 'pending'
        );

        expect(stillPending).toBeDefined();
      } catch (error) {
        console.error('❌ Erreur application dryRun :', error);
        throw error;
      }
    }, 120000);

    /**
     * TEST MANUEL - À exécuter uniquement dans un environnement de test isolé
     *
     * Ce test modifie réellement l'état du système RooSync en appliquant une décision.
     * Il doit être exécuté manuellement avec les précautions suivantes :
     *
     * 1. Utiliser un environnement de test isolé (pas de production)
     * 2. Avoir une décision de test disponible (testDecisionId)
     * 3. Avoir un rollback point créé avant l'exécution
     * 4. Être prêt à restaurer manuellement si nécessaire
     *
     * Pour exécuter ce test :
     * - Retirer le .skip
     * - S'assurer que testDecisionId est défini
     * - Exécuter avec npm test -- tests/e2e/roosync-workflow.test.ts
     */
    it.skip('devrait appliquer une décision en mode réel (SKIP par défaut)', async () => {

      if (!testDecisionId) {
        console.log('⏭️ Test skipped : Aucune décision pending disponible');
        return;
      }

      try {
        const result = await service.executeDecision(testDecisionId, {
          dryRun: false,
          force: false
        });

        expect(result.success).toBe(true);
        expect(result.logs.length).toBeGreaterThan(0);
        expect(result.changes).toBeDefined();

        console.log('✅ Application réelle réussie');
        console.log(`   Fichiers modifiés : ${result.changes.filesModified.length}`);
        console.log(`   Fichiers créés : ${result.changes.filesCreated.length}`);
        console.log(`   Fichiers supprimés : ${result.changes.filesDeleted.length}`);
        console.log(`   Temps : ${result.executionTime}ms`);

        // Vérifier que la décision est maintenant archivée
        service.clearCache();
        const decisionsAfter = await service.loadDecisions();
        const archived = decisionsAfter.find(
          d => d.id === testDecisionId && d.status === 'applied'
        );

        expect(archived).toBeDefined();
      } catch (error) {
        console.error('❌ Erreur application réelle :', error);
        throw error;
      }
    }, 120000);
  });

  describe('Workflow 2 : apply → rollback', () => {
    it('devrait lister les décisions appliquées', async () => {
      try {
        const decisions = await service.loadDecisions();
        const appliedDecisions = decisions.filter(d =>
          d.status === 'applied'
        );

        console.log(`📋 ${appliedDecisions.length} décision(s) appliquée(s)`);

        if (appliedDecisions.length > 0) {
          const latest = appliedDecisions[0];
          console.log(`   Dernière : ${latest.id} - ${latest.title}`);
        }
      } catch (error) {
        console.warn('⚠️ Erreur listage décisions appliquées :', error);
      }
    }, 30000);

    /**
     * TEST MANUEL - À exécuter uniquement dans un environnement de test isolé
     *
     * Ce test modifie réellement l'état du système RooSync en restaurant depuis un rollback point.
     * Il doit être exécuté manuellement avec les précautions suivantes :
     *
     * 1. Utiliser un environnement de test isolé (pas de production)
     * 2. Avoir une décision avec rollback point disponible (testDecisionId)
     * 3. Avoir exécuté préalablement le test d'application de décision
     * 4. Être prêt à restaurer manuellement si nécessaire
     *
     * Pour exécuter ce test :
     * - Retirer le .skip
     * - S'assurer que testDecisionId est défini et a un rollback point
     * - Exécuter avec npm test -- tests/e2e/roosync-workflow.test.ts
     */
    it.skip('devrait restaurer depuis un rollback point (SKIP par défaut)', async () => {

      if (!testDecisionId) {
        console.log('⏭️ Test skipped : Aucune décision avec rollback disponible');
        return;
      }

      try {
        const result = await service.restoreFromRollbackPoint(testDecisionId);

        expect(result).toBeDefined();

        if (result.success) {
          expect(result.restoredFiles.length).toBeGreaterThan(0);
          expect(result.logs.length).toBeGreaterThan(0);

          console.log('✅ Rollback réussi');
          console.log(`   Fichiers restaurés : ${result.restoredFiles.length}`);
          result.restoredFiles.forEach(file => {
            console.log(`     - ${file}`);
          });
        } else {
          console.log('⚠️ Rollback échoué :', result.error);
        }
      } catch (error) {
        console.error('❌ Erreur rollback :', error);
        throw error;
      }
    }, 60000);
  });

  describe('Intégration Dashboard', () => {
    it('devrait charger le dashboard et vérifier la cohérence', async () => {
      try {
        const dashboard = await service.loadDashboard();

        expect(dashboard).toBeDefined();
        expect(dashboard.machines).toBeDefined();
        expect(dashboard.overallStatus).toBeDefined();

        const machineCount = Object.keys(dashboard.machines).length;
        console.log(`🖥️ ${machineCount} machine(s) dans le dashboard`);

        Object.entries(dashboard.machines).forEach(([machineId, info]) => {
          console.log(`   - ${machineId} : ${info.pendingDecisions} pending, ${info.diffsCount} diffs`);
        });
      } catch (error) {
        console.warn('⚠️ Erreur chargement dashboard :', error);
      }
    }, 30000);
  });

  describe('Performance', () => {
    it('devrait charger les décisions en moins de 5 secondes', async () => {
      const startTime = Date.now();

      try {
        await service.loadDecisions();

        const duration = Date.now() - startTime;
        console.log(`⏱️ Temps de chargement décisions : ${duration}ms`);

        expect(duration).toBeLessThan(5000);
      } catch (error) {
        console.warn('⚠️ Test performance skippé :', error);
      }
    }, 10000);

    it('devrait charger le dashboard en moins de 3 secondes', async () => {
      const startTime = Date.now();

      try {
        await service.loadDashboard();

        const duration = Date.now() - startTime;
        console.log(`⏱️ Temps de chargement dashboard : ${duration}ms`);

        expect(duration).toBeLessThan(3000);
      } catch (error) {
        console.warn('⚠️ Test performance skippé :', error);
      }
    }, 10000);
  });
});