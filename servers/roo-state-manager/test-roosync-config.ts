/**
 * Test manuel de la configuration RooSync
 * Exécute: npx ts-node test-roosync-config.ts
 */

import { loadRooSyncConfig, tryLoadRooSyncConfig, isRooSyncEnabled } from './src/config/roosync-config.js';

console.log('=== Test Configuration RooSync ===\n');

// Test 1: Vérifier si RooSync est activé
console.log('Test 1: isRooSyncEnabled()');
const enabled = isRooSyncEnabled();
console.log(`  Résultat: ${enabled ? '✅ Activé' : '❌ Désactivé'}\n`);

// Test 2: Charger la configuration (safe)
console.log('Test 2: tryLoadRooSyncConfig()');
const config = tryLoadRooSyncConfig();
if (config) {
  console.log('  ✅ Configuration chargée avec succès:');
  console.log(`  - sharedPath: ${config.sharedPath}`);
  console.log(`  - machineId: ${config.machineId}`);
  console.log(`  - autoSync: ${config.autoSync}`);
  console.log(`  - conflictStrategy: ${config.conflictStrategy}`);
  console.log(`  - logLevel: ${config.logLevel}\n`);
} else {
  console.log('  ❌ Configuration invalide ou manquante\n');
}

// Test 3: Charger la configuration (strict)
console.log('Test 3: loadRooSyncConfig()');
try {
  const strictConfig = loadRooSyncConfig();
  console.log('  ✅ Configuration stricte validée\n');
} catch (error: any) {
  console.error(`  ❌ Erreur: ${error.message}\n`);
}

console.log('=== Fin des Tests ===');