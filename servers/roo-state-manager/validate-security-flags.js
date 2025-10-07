/**
 * Script de validation des sécurités critiques
 * Vérifie que les feature flags sont verrouillés suite aux incompatibilités découvertes
 */

import { getParsingConfig, shouldUseNewParsing, getCompatibilityStatus } from './src/utils/parsing-config.ts';

console.log('🔍 === VALIDATION SÉCURITÉ FEATURE FLAGS ===\n');

// 1. Configuration actuelle
const config = getParsingConfig();
console.log('📋 Configuration parsing:', JSON.stringify(config, null, 2));

// 2. Test verrouillage nouveau système
const newParsingAllowed = shouldUseNewParsing();
console.log('\n🔒 Nouveau parsing autorisé:', newParsingAllowed);

// 3. Statut compatibilité
const status = getCompatibilityStatus();
console.log('\n🚨 Statut compatibilité:', JSON.stringify(status, null, 2));

// 4. Validation sécurité
console.log('\n🛡️  === RÉSULTATS VALIDATION SÉCURITÉ ===');
console.log(`✅ Nouveau parsing bloqué: ${!newParsingAllowed}`);
console.log(`✅ Phase 2c investigation: ${status.blocked ? 'REQUISE' : 'TERMINÉE'}`);
console.log(`⚠️  Similarité actuelle: ${status.similarityAchieved}%`);
console.log(`🎯 Similarité requise: ${status.similarityRequired}%`);

if (newParsingAllowed) {
  console.log('\n🚨 ERREUR CRITIQUE: Nouveau système autorisé malgré incompatibilités !');
  process.exit(1);
} else {
  console.log('\n✅ SÉCURITÉ CONFIRMÉE: Ancien système protégé, déploiement suspendu.');
  process.exit(0);
}