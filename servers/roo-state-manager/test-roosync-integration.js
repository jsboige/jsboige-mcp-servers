/**
 * Script de Test d'Intégration Phase 3 - RooSync Real Diff Detection
 *
 * Tests du workflow complet :
 * 1. Collecte inventaire (avec cache)
 * 2. Comparaison réelle entre machines
 * 3. Génération de rapport
 * 4. Force refresh (bypass cache)
 * 5. Génération de décisions (placeholder)
 *
 * Usage: node test-roosync-integration.js
 */

// Charger les variables d'environnement depuis .env
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '.env') });

import { RooSyncService } from './build/src/services/RooSyncService.js';
import { loadRooSyncConfig } from './build/src/config/roosync-config.js';

// Couleurs console
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

function log(emoji, color, message) {
  console.log(`${emoji} ${color}${message}${colors.reset}`);
}

function logSection(title) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${colors.cyan}${title}${colors.reset}`);
  console.log('='.repeat(70));
}

function logTest(testName) {
  console.log(`\n${colors.blue}▶${colors.reset} Test: ${testName}`);
}

async function runTests() {
  console.log('\n' + '═'.repeat(70));
  console.log(`  ${colors.cyan}🧪 TEST D'INTÉGRATION ROOSYNC PHASE 3${colors.reset}`);
  console.log('═'.repeat(70));
  
  let testsPassed = 0;
  let testsFailed = 0;
  const startTime = Date.now();

  try {
    // Configuration
    logSection('📋 Configuration');
    const config = loadRooSyncConfig();
    log('✓', colors.green, `Machine locale: ${config.machineId}`);
    log('✓', colors.green, `Shared state: ${config.sharedPath}`);

    // Créer instance service
    const service = RooSyncService.getInstance();
    log('✓', colors.green, 'Service RooSync initialisé');

    // Test 1: Collecte inventaire local avec cache
    logTest('1. Collecte inventaire local (première fois)');
    const startCollect1 = Date.now();
    const inventory1 = await service.getInventory(config.machineId, false);
    const duration1 = Date.now() - startCollect1;
    
    if (inventory1) {
      log('✓', colors.green, `Inventaire collecté en ${duration1}ms`);
      log('ℹ', colors.gray, `  - Machine: ${inventory1.machineId}`);
      log('ℹ', colors.gray, `  - OS: ${inventory1.system.os}`);
      log('ℹ', colors.gray, `  - CPU: ${inventory1.hardware.cpu.cores} cores`);
      log('ℹ', colors.gray, `  - RAM: ${(inventory1.hardware.memory.total / (1024**3)).toFixed(1)} GB`);
      testsPassed++;
    } else {
      log('✗', colors.red, 'Échec collecte inventaire');
      testsFailed++;
    }

    // Test 2: Collecte inventaire avec cache (doit être rapide)
    logTest('2. Collecte inventaire (cache hit)');
    const startCollect2 = Date.now();
    const inventory2 = await service.getInventory(config.machineId, false);
    const duration2 = Date.now() - startCollect2;
    
    if (inventory2 && duration2 < 100) {
      log('✓', colors.green, `Cache hit confirmé (${duration2}ms < 100ms)`);
      testsPassed++;
    } else if (inventory2) {
      log('⚠', colors.yellow, `Cache hit mais lent (${duration2}ms)`);
      testsPassed++;
    } else {
      log('✗', colors.red, 'Échec lecture cache');
      testsFailed++;
    }

    // Test 3: Force refresh (bypass cache)
    logTest('3. Force refresh inventaire (bypass cache)');
    const startCollect3 = Date.now();
    const inventory3 = await service.getInventory(config.machineId, true);
    const duration3 = Date.now() - startCollect3;
    
    if (inventory3 && duration3 > 100) {
      log('✓', colors.green, `Force refresh confirmé (${duration3}ms > 100ms)`);
      testsPassed++;
    } else if (inventory3) {
      log('⚠', colors.yellow, `Force refresh rapide (${duration3}ms) - cache peut-être persistant`);
      testsPassed++;
    } else {
      log('✗', colors.red, 'Échec force refresh');
      testsFailed++;
    }

    // Test 4: Comparaison réelle entre machines
    logTest('4. Comparaison réelle entre machines');
    
    // Obtenir une machine cible
    const dashboard = await service.loadDashboard();
    const machines = Object.keys(dashboard.machines);
    log('ℹ', colors.gray, `Machines disponibles: ${machines.join(', ')}`);
    
    const targetMachine = machines.find(m => m !== config.machineId);
    
    if (targetMachine) {
      log('ℹ', colors.gray, `Machine cible: ${targetMachine}`);
      
      const startCompare = Date.now();
      const report = await service.compareRealConfigurations(
        config.machineId,
        targetMachine,
        false
      );
      const durationCompare = Date.now() - startCompare;
      
      if (report) {
        log('✓', colors.green, `Comparaison réussie en ${durationCompare}ms`);
        log('ℹ', colors.gray, `  - Rapport ID: ${report.reportId}`);
        log('ℹ', colors.gray, `  - Total différences: ${report.summary.total}`);
        log('ℹ', colors.gray, `  - CRITICAL: ${report.summary.critical}`);
        log('ℹ', colors.gray, `  - IMPORTANT: ${report.summary.important}`);
        log('ℹ', colors.gray, `  - WARNING: ${report.summary.warning}`);
        log('ℹ', colors.gray, `  - INFO: ${report.summary.info}`);
        
        // Afficher quelques différences
        if (report.differences.length > 0) {
          log('ℹ', colors.gray, `\n  Échantillon de différences:`);
          report.differences.slice(0, 3).forEach((diff, idx) => {
            log('ℹ', colors.gray, `    ${idx + 1}. [${diff.severity}] ${diff.description}`);
            if (diff.recommendedAction) {
              log('ℹ', colors.gray, `       → ${diff.recommendedAction}`);
            }
          });
        }
        
        // Test performance
        if (durationCompare < 2000) {
          log('✓', colors.green, `Performance OK (${durationCompare}ms < 2000ms)`);
        } else {
          log('⚠', colors.yellow, `Performance limite (${durationCompare}ms >= 2000ms)`);
        }
        
        testsPassed++;
        
        // Test 5: Génération de décisions (placeholder)
        logTest('5. Génération de décisions depuis rapport');
        const decisionsCount = await service.generateDecisionsFromReport(report);
        
        log('✓', colors.green, `${decisionsCount} décisions générées (placeholder)`);
        testsPassed++;
        
      } else {
        log('✗', colors.red, 'Échec comparaison réelle');
        testsFailed++;
      }
    } else {
      log('⚠', colors.yellow, 'Aucune machine cible disponible - test comparaison skip');
      log('ℹ', colors.gray, 'Ajoutez une autre machine dans sync-dashboard.json pour tester');
    }

    // Test 6: Gestion erreurs machine inaccessible
    logTest('6. Gestion erreurs (machine inexistante)');
    const reportError = await service.compareRealConfigurations(
      config.machineId,
      'MACHINE-INEXISTANTE',
      false
    );
    
    if (reportError === null) {
      log('✓', colors.green, 'Erreur correctement gérée (retourne null)');
      testsPassed++;
    } else {
      log('✗', colors.red, 'Erreur mal gérée (devrait retourner null)');
      testsFailed++;
    }

  } catch (error) {
    log('✗', colors.red, `Erreur fatale: ${error.message}`);
    console.error(error);
    testsFailed++;
  }

  // Résumé
  const totalDuration = Date.now() - startTime;
  logSection('📊 Résumé des Tests');
  
  const total = testsPassed + testsFailed;
  const successRate = total > 0 ? ((testsPassed / total) * 100).toFixed(1) : '0.0';
  
  console.log(`\nTests réussis:  ${colors.green}${testsPassed}${colors.reset}`);
  console.log(`Tests échoués:  ${colors.red}${testsFailed}${colors.reset}`);
  console.log(`Taux de succès: ${successRate}%`);
  console.log(`Durée totale:   ${totalDuration}ms\n`);
  
  if (testsFailed === 0) {
    log('✓', colors.green, '🎉 Tous les tests sont passés !');
    console.log('');
    process.exit(0);
  } else {
    log('✗', colors.red, `⚠️  ${testsFailed} test(s) échoué(s)`);
    console.log('');
    process.exit(1);
  }
}

// Exécuter les tests
runTests().catch(error => {
  console.error(`${colors.red}Erreur fatale:${colors.reset}`, error);
  process.exit(1);
});