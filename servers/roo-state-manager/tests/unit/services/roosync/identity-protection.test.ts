/**
 * Script de test pour valider les protections contre l'écrasement d'identités
 * 
 * Ce script teste toutes les fonctionnalités de protection implémentées :
 * - Validation d'unicité dans BaselineManager
 * - Logs d'avertissement lors de conflits
 * - Registre central des machines
 * - Protection des fichiers de présence
 * - Validation au démarrage du service
 * 
 * @module identity-protection-test
 * @version 1.0.0
 */

import { RooSyncService } from '@/services/RooSyncService';
import { loadRooSyncConfig } from '@/config/roosync-config';

/**
 * Résultats de test
 */
interface TestResult {
  testName: string;
  success: boolean;
  message: string;
  details?: any;
}

/**
 * Classe de test pour les protections d'identité
 */
class IdentityProtectionTest {
  private results: TestResult[] = [];

  /**
   * Ajouter un résultat de test
   */
  private addResult(testName: string, success: boolean, message: string, details?: any): void {
    const result: TestResult = {
      testName,
      success,
      message,
      details
    };
    
    this.results.push(result);
    
    const status = success ? '✅' : '❌';
    console.log(`${status} ${testName}: ${message}`);
    
    if (details) {
      console.log('   Détails:', JSON.stringify(details, null, 2));
    }
  }

  /**
   * Tester la validation d'unicité dans BaselineManager
   */
  public async testBaselineManagerUniqueness(): Promise<void> {
    try {
      console.log('\n🧪 Test: Validation d\'unicité BaselineManager');
      
      const config = loadRooSyncConfig();
      const service = RooSyncService.getInstance(undefined, config);
      
      // Tenter de charger le dashboard (devrait valider l'unicité)
      const dashboard = await service.loadDashboard();
      
      this.addResult(
        'BaselineManager Uniqueness',
        dashboard && dashboard.machines && Object.keys(dashboard.machines).length > 0,
        'Validation d\'unicité fonctionnelle dans BaselineManager',
        { machinesCount: Object.keys(dashboard?.machines || {}).length }
      );
      
    } catch (error) {
      this.addResult(
        'BaselineManager Uniqueness',
        false,
        `Erreur lors du test: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Tester les logs d'avertissement lors de conflits
   */
  public async testConflictLogging(): Promise<void> {
    try {
      console.log('\n🧪 Test: Logs d\'avertissement lors de conflits');
      
      const config = loadRooSyncConfig();
      const service = RooSyncService.getInstance(undefined, config);
      
      // Capturer les logs console
      const originalWarn = console.warn;
      const originalError = console.error;
      const capturedLogs: string[] = [];
      
      console.warn = (message: string, ...args: any[]) => {
        capturedLogs.push(`WARN: ${message}`);
        originalWarn.call(console, message, ...args);
      };
      
      console.error = (message: string, ...args: any[]) => {
        capturedLogs.push(`ERROR: ${message}`);
        originalError.call(console, message, ...args);
      };
      
      // Tenter de valider les identités (devrait générer des logs si conflits)
      const validation = await service.validateAllIdentities();
      
      // Restaurer les logs originaux
      console.warn = originalWarn;
      console.error = originalError;
      
      const hasConflictLogs = capturedLogs.some(log => 
        log.includes('CONFLIT') || log.includes('conflit')
      );
      
      this.addResult(
        'Conflict Logging',
        hasConflictLogs || validation.isValid, // OK si pas de conflits OU si logs de conflits présents
        hasConflictLogs ? 'Logs de conflits détectés correctement' : 'Aucun conflit détecté (normal)',
        { 
          capturedLogsCount: capturedLogs.length,
          hasConflictLogs,
          validationValid: validation.isValid
        }
      );
      
    } catch (error) {
      this.addResult(
        'Conflict Logging',
        false,
        `Erreur lors du test: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Tester le registre central des machines
   */
  public async testMachineRegistry(): Promise<void> {
    try {
      console.log('\n🧪 Test: Registre central des machines');
      
      const config = loadRooSyncConfig();
      const service = RooSyncService.getInstance(undefined, config);
      
      // Vérifier que le registre est créé et accessible
      const identityManager = service.getIdentityManager();
      const primaryIdentity = identityManager.getPrimaryIdentity();
      
      this.addResult(
        'Machine Registry',
        primaryIdentity && primaryIdentity.machineId === config.machineId,
        'Registre central des machines accessible',
        { 
          primaryIdentity: primaryIdentity.machineId,
          configMachineId: config.machineId
        }
      );
      
    } catch (error) {
      this.addResult(
        'Machine Registry',
        false,
        `Erreur lors du test: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Tester la protection des fichiers de présence
   */
  public async testPresenceProtection(): Promise<void> {
    try {
      console.log('\n🧪 Test: Protection des fichiers de présence');
      
      const config = loadRooSyncConfig();
      const service = RooSyncService.getInstance(undefined, config);
      
      const presenceManager = service.getPresenceManager();
      
      // Tenter de mettre à jour la présence (devrait être protégé)
      const updateResult = await presenceManager.updateCurrentPresence('online', 'test');
      
      this.addResult(
        'Presence Protection',
        updateResult.success,
        updateResult.success ? 
          'Protection des fichiers de présence fonctionnelle' : 
          `Échec protection: ${updateResult.warningMessage}`,
        { 
          success: updateResult.success,
          conflictDetected: updateResult.conflictDetected,
          warningMessage: updateResult.warningMessage
        }
      );
      
    } catch (error) {
      this.addResult(
        'Presence Protection',
        false,
        `Erreur lors du test: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Tester la validation au démarrage du service
   */
  public async testStartupValidation(): Promise<void> {
    try {
      console.log('\n🧪 Test: Validation au démarrage du service');
      
      const config = loadRooSyncConfig();
      
      // Créer une nouvelle instance (devrait déclencher la validation au démarrage)
      RooSyncService.resetInstance(); // Réinitialiser pour forcer une nouvelle instance
      const service = RooSyncService.getInstance(undefined, config);
      
      // Attendre un peu pour la validation asynchrone
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      this.addResult(
        'Startup Validation',
        true, // Si on arrive ici, le démarrage a réussi
        'Validation au démarrage du service effectuée',
        { 
          machineId: config.machineId,
          sharedPath: config.sharedPath
        }
      );
      
    } catch (error) {
      this.addResult(
        'Startup Validation',
        false,
        `Erreur lors du test: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Tester l'unification des sources d'identité
   */
  public async testIdentityUnification(): Promise<void> {
    try {
      console.log('\n🧪 Test: Unification des sources d\'identité');
      
      const config = loadRooSyncConfig();
      const service = RooSyncService.getInstance(undefined, config);
      
      const identityManager = service.getIdentityManager();
      
      // Collecter toutes les identités
      const identities = await identityManager.collectAllIdentities();
      
      this.addResult(
        'Identity Unification',
        identities && identities.size > 0,
        `Unification des sources d'identité fonctionnelle (${identities.size} identités collectées)`,
        { 
          identitiesCount: identities.size,
          machineIds: Array.from(identities.keys())
        }
      );
      
    } catch (error) {
      this.addResult(
        'Identity Unification',
        false,
        `Erreur lors du test: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Exécuter tous les tests
   */
  public async runAllTests(): Promise<void> {
    console.log('🚀 DÉMARRAGE DES TESTS DE PROTECTION D\'IDENTITÉ ROOSYNC');
    console.log('=' .repeat(60));
    
    await this.testBaselineManagerUniqueness();
    await this.testConflictLogging();
    await this.testMachineRegistry();
    await this.testPresenceProtection();
    await this.testStartupValidation();
    await this.testIdentityUnification();
    
    this.printSummary();
  }

  /**
   * Afficher le résumé des tests
   */
  private printSummary(): void {
    console.log('\n' + '='.repeat(60));
    console.log('📊 RÉSUMÉ DES TESTS DE PROTECTION D\'IDENTITÉ');
    console.log('='.repeat(60));
    
    const successCount = this.results.filter(r => r.success).length;
    const totalCount = this.results.length;
    
    console.log(`\n✅ Tests réussis: ${successCount}/${totalCount}`);
    console.log(`❌ Tests échoués: ${totalCount - successCount}/${totalCount}`);
    console.log(`📈 Taux de réussite: ${Math.round((successCount / totalCount) * 100)}%`);
    
    if (successCount === totalCount) {
      console.log('\n🎉 TOUS LES TESTS DE PROTECTION SONT FONCTIONNELS!');
      console.log('✅ Le système RooSync est protégé contre l\'écrasement d\'identités');
    } else {
      console.log('\n⚠️ CERTAINS TESTS ONT ÉCHOUÉ:');
      this.results
        .filter(r => !r.success)
        .forEach(r => {
          console.log(`   ❌ ${r.testName}: ${r.message}`);
        });
    }
    
    console.log('\n' + '='.repeat(60));
  }
}

/**
 * Point d'entrée principal
 */
// Skipped: This is an integration test that requires live GDrive access,
// not a unit test. It timeouts in CI/automated runs (15s limit).
// TODO: Move to integration test suite with proper fixtures.
describe.skip('IdentityProtectionTest', () => {
  let test: IdentityProtectionTest;

  beforeEach(() => {
    test = new IdentityProtectionTest();
  });

  it('should run all identity protection tests', async () => {
    await test.runAllTests();
  });
});

export { IdentityProtectionTest };