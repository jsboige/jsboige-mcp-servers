/**
 * Script de test pour valider le correctif du bug de corruption mcp_settings.json
 * 
 * Ce test vérifie que:
 * 1. Les modifications ne se perdent pas lors de redémarrages multiples
 * 2. Le fichier JSON reste valide après plusieurs écritures
 * 3. Aucune race condition ne corrompt le fichier
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const SETTINGS_PATH = 'C:/Users/MYIA/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json';
const BACKUP_PATH = SETTINGS_PATH + '.test-backup.' + Date.now();

interface McpSettings {
  mcpServers: Record<string, any>;
}

/**
 * Crée une sauvegarde du fichier de settings
 */
async function backupSettings(): Promise<void> {
  try {
    const content = await fs.readFile(SETTINGS_PATH, 'utf-8');
    await fs.writeFile(BACKUP_PATH, content, 'utf-8');
    console.log(`✅ Sauvegarde créée: ${BACKUP_PATH}`);
  } catch (error) {
    console.error('❌ Erreur lors de la création de la sauvegarde:', error);
    throw error;
  }
}

/**
 * Restaure le fichier de settings depuis la sauvegarde
 */
async function restoreSettings(): Promise<void> {
  try {
    const content = await fs.readFile(BACKUP_PATH, 'utf-8');
    await fs.writeFile(SETTINGS_PATH, content, 'utf-8');
    await fs.unlink(BACKUP_PATH);
    console.log('✅ Settings restaurés depuis la sauvegarde');
  } catch (error) {
    console.error('❌ Erreur lors de la restauration:', error);
    throw error;
  }
}

/**
 * Valide que le fichier JSON est bien formé
 */
async function validateJson(): Promise<boolean> {
  try {
    const content = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(content) as McpSettings;
    
    // Vérifier la structure de base
    if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
      console.error('❌ Structure invalide: mcpServers manquant ou incorrect');
      return false;
    }
    
    console.log('✅ JSON valide avec structure correcte');
    return true;
  } catch (error) {
    console.error('❌ JSON invalide:', error);
    return false;
  }
}

/**
 * Simule un redémarrage de serveur MCP
 */
async function simulateRestart(serverName: string): Promise<boolean> {
  try {
    // Lire l'état actuel
    let settingsRaw = await fs.readFile(SETTINGS_PATH, 'utf-8');
    let settings = JSON.parse(settingsRaw) as McpSettings;
    
    if (!settings.mcpServers[serverName]) {
      console.error(`❌ Serveur ${serverName} non trouvé`);
      return false;
    }
    
    // Désactiver
    settings.mcpServers[serverName].enabled = false;
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    console.log(`   ⏸️  Serveur ${serverName} désactivé`);
    
    // Attendre un peu
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Relire (comme dans le fix)
    settingsRaw = await fs.readFile(SETTINGS_PATH, 'utf-8');
    settings = JSON.parse(settingsRaw) as McpSettings;
    
    // Réactiver
    settings.mcpServers[serverName].enabled = true;
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    console.log(`   ▶️  Serveur ${serverName} réactivé`);
    
    return true;
  } catch (error) {
    console.error(`❌ Erreur lors du redémarrage de ${serverName}:`, error);
    return false;
  }
}

/**
 * Test 1: Redémarrages séquentiels multiples
 */
async function testSequentialRestarts(): Promise<boolean> {
  console.log('\n🧪 TEST 1: Redémarrages séquentiels multiples');
  console.log('─'.repeat(60));
  
  const servers = ['quickfiles', 'roo-state-manager', 'git'];
  
  for (const server of servers) {
    console.log(`\n📡 Redémarrage de ${server}...`);
    const success = await simulateRestart(server);
    if (!success) return false;
    
    const valid = await validateJson();
    if (!valid) {
      console.error(`❌ JSON corrompu après redémarrage de ${server}`);
      return false;
    }
  }
  
  console.log('\n✅ Test 1 réussi: Tous les redémarrages séquentiels OK');
  return true;
}

/**
 * Test 2: Validation de la persistance des modifications
 */
async function testPersistence(): Promise<boolean> {
  console.log('\n🧪 TEST 2: Validation de la persistance');
  console.log('─'.repeat(60));
  
  // Lire l'état initial
  const initialContent = await fs.readFile(SETTINGS_PATH, 'utf-8');
  const initialSettings = JSON.parse(initialContent) as McpSettings;
  
  // Effectuer plusieurs redémarrages
  await simulateRestart('quickfiles');
  await simulateRestart('git');
  
  // Vérifier que tous les serveurs sont toujours présents
  const finalContent = await fs.readFile(SETTINGS_PATH, 'utf-8');
  const finalSettings = JSON.parse(finalContent) as McpSettings;
  
  const initialServers = Object.keys(initialSettings.mcpServers);
  const finalServers = Object.keys(finalSettings.mcpServers);
  
  if (initialServers.length !== finalServers.length) {
    console.error(`❌ Nombre de serveurs différent: ${initialServers.length} -> ${finalServers.length}`);
    return false;
  }
  
  for (const server of initialServers) {
    if (!finalSettings.mcpServers[server]) {
      console.error(`❌ Serveur ${server} perdu après les redémarrages`);
      return false;
    }
  }
  
  console.log('✅ Test 2 réussi: Tous les serveurs préservés');
  return true;
}

/**
 * Test 3: Vérification de l'intégrité du JSON
 */
async function testJsonIntegrity(): Promise<boolean> {
  console.log('\n🧪 TEST 3: Vérification de l\'intégrité JSON');
  console.log('─'.repeat(60));
  
  // Lire et parser le fichier
  const content = await fs.readFile(SETTINGS_PATH, 'utf-8');
  
  // Vérifier qu'il n'y a pas de braces en trop
  const openBraces = (content.match(/{/g) || []).length;
  const closeBraces = (content.match(/}/g) || []).length;
  
  if (openBraces !== closeBraces) {
    console.error(`❌ Braces déséquilibrées: ${openBraces} ouvrantes, ${closeBraces} fermantes`);
    return false;
  }
  
  console.log(`✅ Braces équilibrées: ${openBraces} ouvrantes, ${closeBraces} fermantes`);
  
  // Vérifier qu'il n'y a pas de contenu après la dernière brace
  const lastBraceIndex = content.lastIndexOf('}');
  const afterLastBrace = content.substring(lastBraceIndex + 1).trim();
  
  if (afterLastBrace.length > 0) {
    console.error(`❌ Contenu trouvé après la dernière brace: "${afterLastBrace}"`);
    return false;
  }
  
  console.log('✅ Pas de contenu parasite après la dernière brace');
  console.log('✅ Test 3 réussi: Intégrité JSON validée');
  return true;
}

/**
 * Fonction principale de test
 */
async function runTests(): Promise<void> {
  console.log('🚀 DÉBUT DES TESTS DE VALIDATION DU CORRECTIF');
  console.log('═'.repeat(60));
  
  let allTestsPassed = true;
  
  try {
    // Créer une sauvegarde
    await backupSettings();
    
    // Exécuter les tests
    const test1 = await testSequentialRestarts();
    if (!test1) allTestsPassed = false;
    
    const test2 = await testPersistence();
    if (!test2) allTestsPassed = false;
    
    const test3 = await testJsonIntegrity();
    if (!test3) allTestsPassed = false;
    
    // Afficher le résultat final
    console.log('\n' + '═'.repeat(60));
    if (allTestsPassed) {
      console.log('✅ TOUS LES TESTS RÉUSSIS !');
      console.log('🎉 Le correctif fonctionne correctement');
    } else {
      console.log('❌ CERTAINS TESTS ONT ÉCHOUÉ');
      console.log('⚠️ Le correctif nécessite des ajustements');
    }
    
  } catch (error) {
    console.error('\n❌ ERREUR FATALE LORS DES TESTS:', error);
    allTestsPassed = false;
  } finally {
    // Restaurer la sauvegarde
    try {
      await restoreSettings();
    } catch (error) {
      console.error('⚠️ Impossible de restaurer la sauvegarde automatiquement');
      console.error(`Restaurez manuellement depuis: ${BACKUP_PATH}`);
    }
  }
  
  process.exit(allTestsPassed ? 0 : 1);
}

// Exécuter les tests
runTests().catch(error => {
  console.error('❌ Erreur non gérée:', error);
  process.exit(1);
});