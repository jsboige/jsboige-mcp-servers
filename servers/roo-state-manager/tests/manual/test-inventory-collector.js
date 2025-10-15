/**
 * Script de test manuel pour InventoryCollector
 * Utilisation: node test-inventory-collector.js
 */

import { RooSyncService } from './build/src/services/RooSyncService.js';
import os from 'os';

async function testInventoryCollector() {
  console.log('=== Test InventoryCollector Phase 1 ===\n');
  
  try {
    // Obtenir l'instance RooSyncService
    const service = RooSyncService.getInstance();
    console.log('✅ RooSyncService instancié\n');
    
    // Utiliser le hostname comme machineId
    const machineId = os.hostname();
    console.log(`🔍 Test collecte inventaire pour machine: ${machineId}\n`);
    
    // Test 1: Première collecte (sans cache)
    console.log('--- Test 1: Première collecte (cache vide) ---');
    const startTime1 = Date.now();
    const inventory1 = await service.getInventory(machineId, false);
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
    const inventory2 = await service.getInventory(machineId, false);
    const duration2 = Date.now() - startTime2;
    
    if (inventory2) {
      console.log(`✅ Inventaire récupéré depuis cache en ${duration2}ms`);
      console.log(`   Cache hit: ${duration2 < 100 ? 'OUI ✓' : 'NON (trop lent)'}`);
      console.log(`   Même timestamp: ${inventory1.timestamp === inventory2.timestamp ? 'OUI ✓' : 'NON'}`);
    } else {
      console.log('❌ Échec de la récupération depuis cache');
    }
    
    // Test 3: Force refresh
    console.log('\n--- Test 3: Force refresh (bypass cache) ---');
    const startTime3 = Date.now();
    const inventory3 = await service.getInventory(machineId, true);
    const duration3 = Date.now() - startTime3;
    
    if (inventory3) {
      console.log(`✅ Inventaire re-collecté (force refresh) en ${duration3}ms`);
      console.log(`   Nouveau timestamp: ${inventory3.timestamp !== inventory1.timestamp ? 'OUI ✓' : 'NON'}`);
    } else {
      console.log('❌ Échec du force refresh');
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
testInventoryCollector().then(() => {
  console.log('\n✅ Script de test terminé');
  process.exit(0);
}).catch(error => {
  console.error('\n❌ Erreur fatale:', error);
  process.exit(1);
});