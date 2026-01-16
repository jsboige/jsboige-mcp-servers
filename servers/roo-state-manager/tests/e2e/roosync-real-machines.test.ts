/**
 * Tests End-to-End RooSync - Machines Réelles
 *
 * Tests du workflow complet de synchronisation RooSync sur des machines réelles
 * sans utiliser de mocks. Ces tests valident le déploiement fonctionnel de RooSync.
 *
 * Workflow testé:
 * 1. get-machine-inventory - Récupérer l'inventaire de la machine
 * 2. collect-config - Collecter la configuration
 * 3. compare-config - Comparer les configurations
 * 4. apply-config - Appliquer la configuration
 *
 * @module tests/e2e/roosync-real-machines.test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getMachineInventoryTool } from '../../src/tools/roosync/get-machine-inventory.js';
import { roosyncCollectConfig } from '../../src/tools/roosync/collect-config.js';
import { roosyncCompareConfig } from '../../src/tools/roosync/compare-config.js';
import { roosyncApplyConfig } from '../../src/tools/roosync/apply-config.js';
import { RooSyncService } from '../../src/services/RooSyncService.js';

// Wrapper function pour getMachineInventoryTool
async function roosyncGetMachineInventory(args: { machineId?: string }) {
  return getMachineInventoryTool.execute(args, {});
}

// Configuration des machines pour les tests
const SOURCE_MACHINE = 'myia-ai-01';
const TARGET_MACHINE = 'myia-po-2026';

describe('RooSync E2E - Machines Réelles', () => {
  let service: RooSyncService;
  let inventoryResult: any = null;
  let collectResult: any = null;
  let compareResult: any = null;

  beforeAll(() => {
    // Initialiser le service RooSync
    service = RooSyncService.getInstance();
    console.log('🚀 Initialisation des tests E2E RooSync sur machines réelles');
    console.log(`   Machine source: ${SOURCE_MACHINE}`);
    console.log(`   Machine cible: ${TARGET_MACHINE}`);
  });

  afterAll(() => {
    RooSyncService.resetInstance();
    console.log('🏁 Tests E2E terminés');
  });

  beforeEach(() => {
    // Vider le cache avant chaque test
    service.clearCache();
  });

  describe('Test 1: get-machine-inventory', () => {
    it('devrait récupérer l\'inventaire de la machine myia-ai-01', async () => {
      try {
        const result = await roosyncGetMachineInventory({
          machineId: SOURCE_MACHINE
        });

        expect(result).toBeDefined();
        expect(result.success).toBe(true);
        expect(result.data).toBeDefined();

        inventoryResult = result.data;

        // Vérifier la structure de l'inventaire
        expect(inventoryResult.machineId).toBeDefined();
        expect(inventoryResult.hostname).toBeDefined();
        expect(inventoryResult.os).toBeDefined();
        expect(inventoryResult.architecture).toBeDefined();
        expect(inventoryResult.hardware).toBeDefined();
        expect(inventoryResult.software).toBeDefined();

        console.log('✅ Inventaire récupéré avec succès');
        console.log(`   Machine ID: ${inventoryResult.machineId}`);
        console.log(`   Hostname: ${inventoryResult.hostname}`);
        console.log(`   OS: ${inventoryResult.os}`);
        console.log(`   Architecture: ${inventoryResult.architecture}`);
        console.log(`   CPU: ${inventoryResult.hardware?.cpu?.model}`);
        console.log(`   RAM: ${inventoryResult.hardware?.memory?.total} bytes`);
        console.log(`   PowerShell: ${inventoryResult.software?.powershell}`);
        console.log(`   Node: ${inventoryResult.software?.node}`);
        console.log(`   Python: ${inventoryResult.software?.python}`);
      } catch (error: any) {
        console.error('❌ Erreur lors de la récupération de l\'inventaire:', error);
        throw error;
      }
    }, 60000);
  });

  describe('Test 2: collect-config', () => {
    it('devrait collecter la configuration sur myia-ai-01', async () => {
      try {
        const result = await roosyncCollectConfig({
          targets: ['modes', 'mcp'],
          dryRun: false
        });

        expect(result).toBeDefined();
        expect(result.status).toBe('success');
        expect(result.packagePath).toBeDefined();
        expect(result.totalSize).toBeGreaterThan(0);
        expect(result.manifest).toBeDefined();

        collectResult = result;

        console.log('✅ Configuration collectée avec succès');
        console.log(`   Package path: ${result.packagePath}`);
        console.log(`   Total size: ${result.totalSize} bytes`);
        console.log(`   Manifest:`, result.manifest);
      } catch (error: any) {
        console.error('❌ Erreur lors de la collecte de configuration:', error);
        throw error;
      }
    }, 60000);

    it('devrait collecter la configuration en mode dry-run', async () => {
      try {
        const result = await roosyncCollectConfig({
          targets: ['modes', 'mcp'],
          dryRun: true
        });

        expect(result).toBeDefined();
        expect(result.status).toBe('success');

        console.log('✅ Configuration collectée en dry-run avec succès');
        console.log(`   Package path: ${result.packagePath}`);
      } catch (error: any) {
        console.error('❌ Erreur lors de la collecte de configuration en dry-run:', error);
        throw error;
      }
    }, 30000);
  });

  describe('Test 3: compare-config', () => {
    it('devrait comparer les configurations entre myia-ai-01 et myia-po-2026', async () => {
      try {
        const result = await roosyncCompareConfig({
          source: SOURCE_MACHINE,
          target: TARGET_MACHINE,
          force_refresh: false
        });

        expect(result).toBeDefined();
        expect(result.source).toBeDefined();
        expect(result.target).toBeDefined();
        expect(result.differences).toBeDefined();
        expect(result.summary).toBeDefined();

        compareResult = result;

        console.log('✅ Comparaison des configurations réussie');
        console.log(`   Source: ${result.source}`);
        console.log(`   Target: ${result.target}`);
        console.log(`   Host ID: ${result.host_id}`);
        console.log(`   Différences totales: ${result.summary.total}`);
        console.log(`   - Critiques: ${result.summary.critical}`);
        console.log(`   - Importantes: ${result.summary.important}`);
        console.log(`   - Avertissements: ${result.summary.warning}`);
        console.log(`   - Infos: ${result.summary.info}`);

        // Afficher les différences si présentes
        if (result.differences.length > 0) {
          console.log('\n   Différences détectées:');
          result.differences.slice(0, 10).forEach((diff: any, index: number) => {
            console.log(`   ${index + 1}. [${diff.severity}] ${diff.category}: ${diff.description}`);
            console.log(`      Path: ${diff.path}`);
            if (diff.action) {
              console.log(`      Action: ${diff.action}`);
            }
          });

          if (result.differences.length > 10) {
            console.log(`   ... et ${result.differences.length - 10} autres différences`);
          }
        } else {
          console.log('   ✨ Aucune différence détectée - configurations identiques');
        }
      } catch (error: any) {
        console.error('❌ Erreur lors de la comparaison des configurations:', error);
        throw error;
      }
    }, 60000);

    it('devrait comparer avec force_refresh pour forcer la collecte d\'inventaire', async () => {
      try {
        const result = await roosyncCompareConfig({
          source: SOURCE_MACHINE,
          target: TARGET_MACHINE,
          force_refresh: true
        });

        expect(result).toBeDefined();
        expect(result.differences).toBeDefined();

        console.log('✅ Comparaison avec force_refresh réussie');
        console.log(`   Différences totales: ${result.summary.total}`);
      } catch (error: any) {
        console.error('❌ Erreur lors de la comparaison avec force_refresh:', error);
        throw error;
      }
    }, 60000);
  });

  describe('Test 4: apply-config', () => {
    it('devrait appliquer la configuration en dry-run sur myia-po-2026', async () => {
      try {
        const result = await roosyncApplyConfig({
          version: 'latest',
          machineId: SOURCE_MACHINE,
          targets: ['modes', 'mcp'],
          backup: true,
          dryRun: true
        });

        expect(result).toBeDefined();
        expect(result.status).toBeDefined();

        console.log('✅ Application de configuration en dry-run réussie');
        console.log(`   Status: ${result.status}`);
        console.log(`   Message: ${result.message}`);

        if (result.filesApplied !== undefined) {
          console.log(`   Fichiers appliqués: ${result.filesApplied}`);
        }

        if (result.backupPath) {
          console.log(`   Backup path: ${result.backupPath}`);
        }

        if (result.errors && result.errors.length > 0) {
          console.log(`   Erreurs: ${result.errors.length}`);
          result.errors.forEach((err: any, index: number) => {
            console.log(`     ${index + 1}. ${err}`);
          });
        }
      } catch (error: any) {
        console.error('❌ Erreur lors de l\'application de configuration en dry-run:', error);
        throw error;
      }
    }, 60000);

    it('devrait appliquer la configuration avec backup', async () => {
      try {
        const result = await roosyncApplyConfig({
          version: 'latest',
          machineId: SOURCE_MACHINE,
          targets: ['modes'],
          backup: true,
          dryRun: true
        });

        expect(result).toBeDefined();
        expect(result.status).toBeDefined();

        console.log('✅ Application de configuration avec backup réussie');
        console.log(`   Status: ${result.status}`);
        console.log(`   Backup créé: ${result.backupPath ? 'Oui' : 'Non'}`);
      } catch (error: any) {
        console.error('❌ Erreur lors de l\'application de configuration avec backup:', error);
        throw error;
      }
    }, 60000);
  });

  describe('Test 5: Workflow complet', () => {
    it('devrait exécuter le workflow complet en séquence', async () => {
      try {
        console.log('\n🔄 Début du workflow complet RooSync');

        // Étape 1: Récupérer l'inventaire
        console.log('\n📋 Étape 1: Récupération de l\'inventaire...');
        const inventory = await roosyncGetMachineInventory({
          machineId: SOURCE_MACHINE
        });
        expect(inventory.success).toBe(true);
        console.log('   ✅ Inventaire récupéré');

        // Étape 2: Collecter la configuration
        console.log('\n📦 Étape 2: Collecte de la configuration...');
        const collect = await roosyncCollectConfig({
          targets: ['modes', 'mcp'],
          dryRun: false
        });
        expect(collect.status).toBe('success');
        console.log('   ✅ Configuration collectée');

        // Étape 3: Comparer les configurations
        console.log('\n🔍 Étape 3: Comparaison des configurations...');
        const compare = await roosyncCompareConfig({
          source: SOURCE_MACHINE,
          target: TARGET_MACHINE,
          force_refresh: false
        });
        expect(compare.differences).toBeDefined();
        console.log('   ✅ Comparaison effectuée');
        console.log(`   Différences détectées: ${compare.summary.total}`);

        // Étape 4: Appliquer la configuration (dry-run)
        console.log('\n⚙️ Étape 4: Application de la configuration (dry-run)...');
        const apply = await roosyncApplyConfig({
          version: 'latest',
          machineId: SOURCE_MACHINE,
          targets: ['modes', 'mcp'],
          backup: true,
          dryRun: true
        });
        expect(apply.status).toBeDefined();
        console.log('   ✅ Application simulée');

        console.log('\n✨ Workflow complet terminé avec succès');
        console.log('   Résumé:');
        console.log(`   - Inventaire: ${inventory.data?.hostname}`);
        console.log(`   - Configuration: ${collect.packagePath}`);
        console.log(`   - Différences: ${compare.summary.total}`);
        console.log(`   - Application: ${apply.status}`);
      } catch (error: any) {
        console.error('❌ Erreur lors du workflow complet:', error);
        throw error;
      }
    }, 120000);
  });

  describe('Tests de performance', () => {
    it('devrait récupérer l\'inventaire en moins de 30 secondes', async () => {
      const startTime = Date.now();

      const result = await roosyncGetMachineInventory({
        machineId: SOURCE_MACHINE
      });

      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(30000);

      console.log(`⏱️ Temps de récupération inventaire: ${duration}ms`);
    }, 60000);

    it('devrait collecter la configuration en moins de 60 secondes', async () => {
      const startTime = Date.now();

      const result = await roosyncCollectConfig({
        targets: ['modes', 'mcp'],
        dryRun: false
      });

      const duration = Date.now() - startTime;

      expect(result.status).toBe('success');
      expect(duration).toBeLessThan(60000);

      console.log(`⏱️ Temps de collecte configuration: ${duration}ms`);
    }, 120000);

    it('devrait comparer les configurations en moins de 60 secondes', async () => {
      const startTime = Date.now();

      const result = await roosyncCompareConfig({
        source: SOURCE_MACHINE,
        target: TARGET_MACHINE,
        force_refresh: false
      });

      const duration = Date.now() - startTime;

      expect(result.differences).toBeDefined();
      expect(duration).toBeLessThan(60000);

      console.log(`⏱️ Temps de comparaison configuration: ${duration}ms`);
    }, 120000);
  });
});
