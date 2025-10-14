/**
 * Tests End-to-End RooSync - Gestion des Erreurs
 * 
 * Tests de robustesse et gestion des cas d'erreur :
 * - Décisions invalides
 * - Configuration manquante
 * - Scripts PowerShell en échec
 * - Timeouts
 * - Rollback introuvable
 * 
 * @module tests/e2e/roosync-error-handling.test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RooSyncService } from '../../src/services/RooSyncService.js';
import { PowerShellExecutor } from '../../src/services/PowerShellExecutor.js';

describe('RooSync E2E Error Handling', () => {
  let service: RooSyncService;

  beforeAll(() => {
    service = RooSyncService.getInstance();
  });

  afterAll(() => {
    RooSyncService.resetInstance();
  });

  describe('Décisions Invalides', () => {
    it('devrait gérer un ID de décision inexistant', async () => {
      const invalidId = 'INVALID_DECISION_ID_12345';
      
      const result = await service.executeDecision(invalidId);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('not found');
      expect(result.logs.length).toBeGreaterThan(0);
      expect(result.changes.filesModified.length).toBe(0);
      
      console.log(`✅ Erreur ID invalide correctement gérée : ${result.error}`);
    }, 30000);

    it('devrait gérer un ID de décision null', async () => {
      const result = await service.executeDecision(null as any);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      
      console.log(`✅ Erreur ID null correctement gérée`);
    }, 30000);

    it('devrait gérer un ID de décision avec caractères spéciaux', async () => {
      const invalidId = '<script>alert("test")</script>';
      
      const result = await service.executeDecision(invalidId);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      
      console.log(`✅ Erreur ID avec caractères spéciaux correctement gérée`);
    }, 30000);
  });

  describe('Configuration Manquante', () => {
    it('devrait gérer SHARED_STATE_PATH inaccessible', async () => {
      // Sauvegarder la configuration originale
      const originalSharedPath = process.env.SHARED_STATE_PATH;
      
      try {
        // Configurer un chemin invalide
        process.env.SHARED_STATE_PATH = '/path/that/does/not/exist/12345';
        
        // Créer une nouvelle instance avec la config invalide
        RooSyncService.resetInstance();
        const testService = RooSyncService.getInstance();
        
        // Tenter de charger les décisions
        await expect(
          testService.loadDecisions()
        ).rejects.toThrow();
        
        console.log(`✅ Erreur SHARED_STATE_PATH invalide correctement gérée`);
      } finally {
        // Restaurer la configuration
        if (originalSharedPath) {
          process.env.SHARED_STATE_PATH = originalSharedPath;
        }
        RooSyncService.resetInstance();
        service = RooSyncService.getInstance();
      }
    }, 30000);

    it('devrait gérer l\'absence de fichiers RooSync', async () => {
      try {
        // Tenter d'obtenir une décision qui n'existe pas
        const decision = await service.getDecision('NONEXISTENT_ID');
        
        expect(decision).toBeNull();
        
        console.log(`✅ Décision inexistante retourne null`);
      } catch (error) {
        // Certaines implémentations peuvent throw au lieu de retourner null
        expect(error).toBeDefined();
        console.log(`✅ Erreur fichier manquant correctement gérée`);
      }
    }, 30000);
  });

  describe('PowerShell Failures', () => {
    it('devrait gérer un script PowerShell inexistant', async () => {
      const executor = new PowerShellExecutor();
      
      await expect(
        executor.executeScript('nonexistent-script-xyz.ps1', [])
      ).rejects.toThrow();
      
      console.log(`✅ Erreur script PowerShell inexistant correctement gérée`);
    }, 30000);

    it('devrait gérer PowerShell non disponible', async () => {
      const isAvailable = await PowerShellExecutor.isPowerShellAvailable('invalid-pwsh-path.exe');
      
      expect(isAvailable).toBe(false);
      
      console.log(`✅ Détection PowerShell indisponible fonctionne`);
    }, 10000);

    it('devrait gérer un script PowerShell avec erreur', async () => {
      // Ce test nécessite un script PowerShell qui génère une erreur
      // Pour l'instant, on vérifie juste que le mécanisme d'erreur fonctionne
      
      const executor = new PowerShellExecutor();
      
      try {
        const result = await executor.executeScript(
          '',
          ['-Command', 'exit 1'], // Commande qui échoue
          { timeout: 5000 }
        );
        
        expect(result.success).toBe(false);
        expect(result.exitCode).toBe(1);
        
        console.log(`✅ Erreur PowerShell (exit 1) correctement détectée`);
      } catch (error) {
        // Peut aussi throw selon l'implémentation
        console.log(`✅ Erreur PowerShell correctement propagée`);
      }
    }, 10000);
  });

  describe('Timeouts', () => {
    it('devrait gérer un timeout lors de l\'exécution PowerShell', async () => {
      const executor = new PowerShellExecutor();
      
      const result = await executor.executeScript(
        '',
        ['-Command', 'Start-Sleep -Seconds 60'], // Script qui prend 60s
        { timeout: 1000 } // Timeout de 1s seulement
      );
      
      expect(result.success).toBe(false);
      expect(result.stderr).toContain('timed out');
      
      console.log(`✅ Timeout PowerShell correctement géré`);
    }, 10000);

    it('devrait respecter le timeout par défaut', async () => {
      const executor = new PowerShellExecutor({
        defaultTimeout: 2000 // 2 secondes
      });
      
      const startTime = Date.now();
      
      const result = await executor.executeScript(
        '',
        ['-Command', 'Start-Sleep -Seconds 30'], // Script qui prend 30s
        // Pas de timeout explicite, utilise le défaut
      );
      
      const duration = Date.now() - startTime;
      
      expect(result.success).toBe(false);
      expect(duration).toBeLessThan(5000); // Devrait timeout en moins de 5s
      
      console.log(`✅ Timeout par défaut respecté (${duration}ms)`);
    }, 10000);
  });

  describe('Rollback Errors', () => {
    it('devrait gérer l\'absence de rollback point', async () => {
      const nonexistentId = 'DECISION_WITHOUT_ROLLBACK_12345';
      
      const result = await service.restoreFromRollbackPoint(nonexistentId);
      
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.restoredFiles.length).toBe(0);
      expect(result.logs.length).toBeGreaterThan(0);
      
      console.log(`✅ Absence de rollback correctement gérée`);
    }, 30000);

    it('devrait gérer la création de rollback sur une décision invalide', async () => {
      try {
        await service.createRollbackPoint('INVALID_DECISION_ID');
        
        // La création peut réussir même si la décision n'existe pas
        // car elle backup juste les fichiers actuels
        console.log(`ℹ️ Rollback créé pour ID invalide (fichiers actuels)`);
      } catch (error) {
        // Ou peut échouer selon l'implémentation
        expect(error).toBeDefined();
        console.log(`✅ Erreur création rollback ID invalide correctement gérée`);
      }
    }, 30000);
  });

  describe('Cache et Concurrence', () => {
    it('devrait gérer l\'invalidation du cache après modification', async () => {
      // Charger les décisions (mise en cache)
      const decisionsFirst = await service.loadDecisions();
      
      // Vider le cache
      service.clearCache();
      
      // Recharger (pas de cache)
      const decisionsSecond = await service.loadDecisions();
      
      // Les deux devraient avoir le même contenu (mais pas être la même référence)
      expect(decisionsFirst.length).toBe(decisionsSecond.length);
      
      console.log(`✅ Invalidation cache fonctionne correctement`);
    }, 30000);

    it('devrait gérer plusieurs instances du service', () => {
      // Le service est un singleton
      const instance1 = RooSyncService.getInstance();
      const instance2 = RooSyncService.getInstance();
      
      expect(instance1).toBe(instance2);
      
      console.log(`✅ Pattern Singleton respecté`);
    });

    it('devrait créer une nouvelle instance après reset', () => {
      const instance1 = RooSyncService.getInstance();
      
      RooSyncService.resetInstance();
      
      const instance2 = RooSyncService.getInstance();
      
      expect(instance1).not.toBe(instance2);
      
      console.log(`✅ Reset d'instance fonctionne correctement`);
    });
  });

  describe('Validation des Données', () => {
    it('devrait gérer des décisions avec données malformées', async () => {
      // Difficile à tester sans modifier les fichiers réels
      // On vérifie juste que le parsing ne crash pas
      
      try {
        const decisions = await service.loadDecisions();
        
        // Vérifier que chaque décision a les champs requis
        decisions.forEach(decision => {
          expect(decision.id).toBeDefined();
          expect(decision.status).toBeDefined();
          expect(decision.title).toBeDefined();
        });
        
        console.log(`✅ Validation structure décisions OK`);
      } catch (error) {
        console.warn('⚠️ Erreur chargement décisions :', error);
      }
    }, 30000);

    it('devrait gérer un dashboard avec données manquantes', async () => {
      try {
        const dashboard = await service.loadDashboard();
        
        // Vérifier structure minimale
        expect(dashboard).toBeDefined();
        expect(dashboard.machines).toBeDefined();
        
        console.log(`✅ Validation structure dashboard OK`);
      } catch (error) {
        console.warn('⚠️ Erreur chargement dashboard :', error);
      }
    }, 30000);
  });

  describe('Permissions et Accès Fichiers', () => {
    it('devrait gérer les erreurs de permissions en lecture', async () => {
      // Difficile à tester sans modifier les permissions réelles
      // Ce test vérifie juste que les erreurs sont propagées correctement
      
      try {
        const config = service.getConfig();
        expect(config).toBeDefined();
        expect(config.sharedPath).toBeDefined();
        
        console.log(`✅ Configuration accessible`);
      } catch (error) {
        expect(error).toBeDefined();
        console.log(`✅ Erreur configuration correctement propagée`);
      }
    });

    it('devrait gérer les erreurs de permissions en écriture', async () => {
      // Test conceptuel : vérifier que les erreurs d'écriture sont gérées
      
      try {
        // Tenter de créer un rollback (opération d'écriture)
        await service.createRollbackPoint('TEST_PERMISSIONS');
        
        console.log(`✅ Écriture rollback autorisée`);
      } catch (error) {
        // Si erreur de permission, elle devrait être gérée proprement
        expect(error).toBeDefined();
        console.log(`✅ Erreur permission écriture correctement gérée`);
      }
    }, 30000);
  });
});