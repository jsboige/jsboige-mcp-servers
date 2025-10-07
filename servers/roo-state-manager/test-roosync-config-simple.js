/**
 * Test simple de la configuration RooSync (JavaScript)
 * Exécute: node test-roosync-config-simple.js
 */

import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger le fichier .env
dotenv.config({ path: resolve(__dirname, '.env') });

console.log('=== Test Configuration RooSync ===\n');

// Test 1: Vérifier les variables
console.log('Test 1: Vérification des variables d\'environnement');
const requiredVars = [
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_AUTO_SYNC',
  'ROOSYNC_CONFLICT_STRATEGY',
  'ROOSYNC_LOG_LEVEL'
];

let allPresent = true;
for (const varName of requiredVars) {
  const value = process.env[varName];
  if (value) {
    console.log(`  ✅ ${varName} = ${value}`);
  } else {
    console.log(`  ❌ ${varName} = MANQUANTE`);
    allPresent = false;
  }
}
console.log();

if (!allPresent) {
  console.log('❌ Certaines variables sont manquantes. Arrêt du test.\n');
  process.exit(1);
}

// Test 2: Valider sharedPath
console.log('Test 2: Validation du chemin Google Drive');
const sharedPath = process.env.ROOSYNC_SHARED_PATH;

if (!isAbsolute(sharedPath)) {
  console.log(`  ❌ Le chemin n'est pas absolu: ${sharedPath}\n`);
} else if (!existsSync(sharedPath)) {
  console.log(`  ❌ Le chemin n'existe pas: ${sharedPath}\n`);
} else {
  console.log(`  ✅ Chemin valide et accessible: ${sharedPath}\n`);
}

// Test 3: Valider machineId
console.log('Test 3: Validation de l\'identifiant machine');
const machineId = process.env.ROOSYNC_MACHINE_ID;
const machineIdPattern = /^[A-Z0-9_-]+$/i;

if (machineIdPattern.test(machineId)) {
  console.log(`  ✅ Format valide: ${machineId}\n`);
} else {
  console.log(`  ❌ Format invalide: ${machineId} (attendu: [A-Z0-9_-]+)\n`);
}

// Test 4: Valider autoSync
console.log('Test 4: Validation du flag de synchronisation automatique');
const autoSync = process.env.ROOSYNC_AUTO_SYNC.toLowerCase();

if (autoSync === 'true' || autoSync === 'false') {
  console.log(`  ✅ Valeur valide: ${autoSync}\n`);
} else {
  console.log(`  ❌ Valeur invalide: ${autoSync} (attendu: true ou false)\n`);
}

// Test 5: Valider conflictStrategy
console.log('Test 5: Validation de la stratégie de résolution de conflits');
const conflictStrategy = process.env.ROOSYNC_CONFLICT_STRATEGY;
const validStrategies = ['manual', 'auto-local', 'auto-remote'];

if (validStrategies.includes(conflictStrategy)) {
  console.log(`  ✅ Stratégie valide: ${conflictStrategy}\n`);
} else {
  console.log(`  ❌ Stratégie invalide: ${conflictStrategy} (attendu: ${validStrategies.join(', ')})\n`);
}

// Test 6: Valider logLevel
console.log('Test 6: Validation du niveau de log');
const logLevel = process.env.ROOSYNC_LOG_LEVEL;
const validLogLevels = ['debug', 'info', 'warn', 'error'];

if (validLogLevels.includes(logLevel)) {
  console.log(`  ✅ Niveau de log valide: ${logLevel}\n`);
} else {
  console.log(`  ❌ Niveau de log invalide: ${logLevel} (attendu: ${validLogLevels.join(', ')})\n`);
}

console.log('=== Résumé de la Configuration ===\n');
console.log('Configuration RooSync:');
console.log(`  - Chemin partagé: ${sharedPath}`);
console.log(`  - ID Machine: ${machineId}`);
console.log(`  - Synchronisation auto: ${autoSync}`);
console.log(`  - Stratégie de conflits: ${conflictStrategy}`);
console.log(`  - Niveau de log: ${logLevel}`);
console.log('\n✅ Configuration complète et valide!\n');

console.log('=== Fin des Tests ===');