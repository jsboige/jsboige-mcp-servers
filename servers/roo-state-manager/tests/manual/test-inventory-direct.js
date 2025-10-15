/**
 * Script de test direct pour InventoryCollector (sans RooSyncService)
 * Utilisation: node test-inventory-direct.js
 */

import { PowerShellExecutor } from './build/src/services/PowerShellExecutor.js';
import { InventoryCollector } from './build/src/services/InventoryCollector.js';
import os from 'os';

async function testInventoryCollectorDirect() {
  console.log('=== Test Direct InventoryCollector Phase 1 ===\n');
  
  try {
    // Créer PowerShellExecutor
    const executor = new PowerShellExecutor();
    console.log('✅ PowerShellExecutor créé\n');
    
    // Créer InventoryCollector
    const collector = new InventoryCollector(executor);
    console.log('✅ InventoryCollector créé\n');
    
    // Utiliser le hostname comme machineId
    const machineId = os.hostname();
    console.log(`🔍 Test collecte inventaire pour machine: ${machineId}\n`);
    
    // Test 1: Première collecte (sans cache)
    console.log('--- Test 1: Première collecte (cache vide) ---');
    const startTime1 = Date.now();
    const inventory1 = await collector.collectInventory(machineId, false);
    const duration1 = Date.now() - startTime1;
    
    if (inventory1) {
      console.log(`✅ Inventaire collecté avec succès en ${duration1}ms`);
      console.log(`   - Machine ID: ${inventory1.machineId}`);
      console.log(`   - Timestamp: ${inventory1.timestamp}`);
      console.log(`   - OS: ${inventory1.system.os}`);
      console.log(`   - Hostname: ${inventory1.system.hostname}`);
      console.log(`   - CPU Cores: ${inventory1.hardware.cpu.cores}`);
      console.log(`   - Memory Total: ${Math.round(inventory1.hardware.memory.total / 1024 / 1024 / 1024)}GB`);
      console.log(`   - PowerShell: ${inventory1.software.powershell}`);
    } else {
      console.log('❌ Échec de la collecte d\'inventaire');
      return;
    }
    
    // Test 2: Deuxième collecte (depuis cache)
    console.log('\n--- Test 2: Deuxième collecte (depuis cache) ---');
    const startTime2 = Date.now();
    const inventory2 = await collector.collectInventory(machineId, false);
    const duration2 = Date.now() - startTime2;
    
    if (inventory2) {
      console.log(`✅ Inventaire récupéré depuis cache en ${duration2}ms`);
      console.log(`   Cache hit: ${duration2 < 100 ? 'OUI ✓' : 'NON (trop lent)'}`);
      console.log(`   Même timestamp: ${inventory1.timestamp === inventory2.timestamp ? 'OUI ✓' : 'NON'}`);
    } else {
      console.log('❌ Échec de la récupération depuis cache');
    }
    
    // Test 3: Statistiques cache
    console.log('\n--- Test 3: Statistiques cache ---');
    const stats = collector.getCacheStats();
    console.log(`✅ Cache stats:`);
    console.log(`   - Entrées: ${stats.size}`);
    console.log(`   - Machines en cache: ${stats.entries.map(e => e.machineId).join(', ')}`);
    console.log(`   - Âge cache: ${Math.round(stats.entries[0]?.age / 1000)}s`);
    
    // Test 4: Force refresh
    console.log('\n--- Test 4: Force refresh (bypass cache) ---');
    const startTime3 = Date.now();
    const inventory3 = await collector.collectInventory(machineId, true);
    const duration3 = Date.now() - startTime3;
    
    if (inventory3) {
      console.log(`✅ Inventaire re-collecté (force refresh) en ${duration3}ms`);
      console.log(`   Nouveau timestamp: ${inventory3.timestamp !== inventory1.timestamp ? 'OUI ✓' : 'NON'}`);
    } else {
      console.log('❌ Échec du force refresh');
    }
    
    // Test 5: Vérifier fichiers générés
    console.log('\n--- Test 5: Vérification fichiers générés ---');
    const outputPath = `d:/roo-extensions/outputs/machine-inventory-${machineId}.json`;
    const sharedStatePath = `G:/Mon Drive/Synchronisation/RooSync/.shared-state/inventories/`;
    
    const fs = await import('fs');
    if (fs.existsSync(outputPath)) {
      console.log(`✅ Fichier JSON temporaire créé: ${outputPath}`);
    } else {
      console.log(`⚠️  Fichier JSON temporaire non trouvé: ${outputPath}`);
    }
    
    if (fs.existsSync(sharedStatePath)) {
      const files = fs.readdirSync(sharedStatePath);
      const inventoryFiles = files.filter(f => f.startsWith(machineId));
      console.log(`✅ Fichiers .shared-state/inventories/: ${inventoryFiles.length} fichier(s)`);
      if (inventoryFiles.length > 0) {
        console.log(`   Dernier: ${inventoryFiles[inventoryFiles.length - 1]}`);
      }
    } else {
      console.log(`⚠️  Répertoire .shared-state/inventories/ non accessible`);
    }
    
    console.log('\n=== Tests terminés avec succès ===');
    
  } catch (error) {
    console.error('\n❌ ERREUR:', error.message);
    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Exécuter les tests
testInventoryCollectorDirect().then(() => {
  console.log('\n✅ Script de test terminé');
  process.exit(0);
}).catch(error => {
  console.error('\n❌ Erreur fatale:', error);
  process.exit(1);
});