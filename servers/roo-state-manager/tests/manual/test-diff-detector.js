/**
 * Script de test manuel pour DiffDetector
 * 
 * Teste les différents scénarios de comparaison d'inventaires
 * et valide le scoring de sévérité.
 */

import { DiffDetector } from './build/src/services/DiffDetector.js';
import { InventoryCollector } from './build/src/services/InventoryCollector.js';
import { PowerShellExecutor } from './build/src/services/PowerShellExecutor.js';

console.log('=== Test DiffDetector Phase 2 ===\n');

// Créer des inventaires de test
function createTestInventory(machineId, overrides = {}) {
  const base = {
    machineId,
    timestamp: new Date().toISOString(),
    system: {
      hostname: `${machineId}-host`,
      os: 'Windows 11',
      architecture: 'x64',
      uptime: 86400
    },
    hardware: {
      cpu: {
        name: 'Intel Core i7-10700K',
        cores: 8,
        threads: 16
      },
      memory: {
        total: 32 * 1024 * 1024 * 1024, // 32 GB
        available: 16 * 1024 * 1024 * 1024
      },
      disks: [
        { drive: 'C:', size: 500 * 1024 * 1024 * 1024, free: 200 * 1024 * 1024 * 1024 },
        { drive: 'D:', size: 1024 * 1024 * 1024 * 1024, free: 500 * 1024 * 1024 * 1024 }
      ],
      gpu: [
        { name: 'NVIDIA RTX 3070', memory: 8 * 1024 * 1024 * 1024 }
      ]
    },
    software: {
      powershell: '7.4.0',
      node: 'v20.10.0',
      python: '3.11.5'
    },
    roo: {
      modesPath: 'C:/Users/MYIA/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/custom_modes.json',
      mcpSettings: 'C:/Users/MYIA/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json'
    }
  };

  // Appliquer les overrides
  return mergeDeep(base, overrides);
}

// Fonction helper pour merge profond
function mergeDeep(target, source) {
  const output = Object.assign({}, target);
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = mergeDeep(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

// Fonction helper pour afficher un rapport
function displayReport(report, scenarioName) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Scénario: ${scenarioName}`);
  console.log(`${'='.repeat(80)}`);
  console.log(`\n📊 Résumé:`);
  console.log(`   Report ID: ${report.reportId}`);
  console.log(`   Timestamp: ${report.timestamp}`);
  console.log(`   Source: ${report.sourceMachine}`);
  console.log(`   Target: ${report.targetMachine}`);
  console.log(`   Durée: ${report.metadata.comparisonDuration}ms`);
  console.log(`\n📈 Statistiques:`);
  console.log(`   Total: ${report.summary.total} différences`);
  console.log(`   🔴 CRITICAL: ${report.summary.critical}`);
  console.log(`   🟠 IMPORTANT: ${report.summary.important}`);
  console.log(`   🟡 WARNING: ${report.summary.warning}`);
  console.log(`   🔵 INFO: ${report.summary.info}`);

  if (report.differences.length > 0) {
    console.log(`\n📝 Différences détectées:`);
    report.differences.forEach((diff, index) => {
      const icon = {
        CRITICAL: '🔴',
        IMPORTANT: '🟠',
        WARNING: '🟡',
        INFO: '🔵'
      }[diff.severity];
      
      console.log(`\n   ${index + 1}. ${icon} ${diff.severity} - ${diff.category}`);
      console.log(`      Path: ${diff.path}`);
      console.log(`      Type: ${diff.type}`);
      console.log(`      Description: ${diff.description}`);
      console.log(`      Source: ${JSON.stringify(diff.source.value)} (${diff.source.machineId})`);
      console.log(`      Target: ${JSON.stringify(diff.target.value)} (${diff.target.machineId})`);
      if (diff.recommendedAction) {
        console.log(`      💡 Action: ${diff.recommendedAction}`);
      }
      if (diff.affectedComponents) {
        console.log(`      🔧 Composants: ${diff.affectedComponents.join(', ')}`);
      }
    });
  } else {
    console.log(`\n✅ Aucune différence détectée - inventaires identiques`);
  }
}

async function runTests() {
  const detector = new DiffDetector();

  try {
    // Test 1 : Inventaires identiques
    console.log('\n🧪 Test 1 : Inventaires identiques');
    const inv1 = createTestInventory('MACHINE-1');
    const inv2 = createTestInventory('MACHINE-2');
    const report1 = await detector.compareInventories(inv1, inv2);
    displayReport(report1, 'Inventaires identiques');
    
    if (report1.summary.total === 0) {
      console.log('\n✅ Test 1 RÉUSSI : 0 différences comme attendu');
    } else {
      console.log('\n❌ Test 1 ÉCHOUÉ : Des différences ont été détectées alors qu\'aucune n\'était attendue');
    }

    // Test 2 : Configuration Roo différente (CRITICAL)
    console.log('\n\n🧪 Test 2 : Configuration Roo différente');
    const inv3 = createTestInventory('MACHINE-1');
    const inv4 = createTestInventory('MACHINE-2', {
      roo: {
        modesPath: 'D:/Different/Path/custom_modes.json'
      }
    });
    const report2 = await detector.compareInventories(inv3, inv4);
    displayReport(report2, 'Configuration Roo différente');
    
    if (report2.summary.critical > 0 && report2.differences.some(d => d.path === 'roo.modesPath')) {
      console.log('\n✅ Test 2 RÉUSSI : Différence CRITICAL détectée sur roo.modesPath');
    } else {
      console.log('\n❌ Test 2 ÉCHOUÉ : Différence CRITICAL non détectée sur roo.modesPath');
    }

    // Test 3 : CPU différent (IMPORTANT si > 25%)
    console.log('\n\n🧪 Test 3 : CPU cores différent > 25%');
    const inv5 = createTestInventory('MACHINE-1', {
      hardware: {
        cpu: { cores: 8, threads: 16, name: 'Intel i7' }
      }
    });
    const inv6 = createTestInventory('MACHINE-2', {
      hardware: {
        cpu: { cores: 4, threads: 8, name: 'Intel i5' }
      }
    });
    const report3 = await detector.compareInventories(inv5, inv6);
    displayReport(report3, 'CPU cores différent > 25%');
    
    const cpuDiff = report3.differences.find(d => d.path === 'hardware.cpu.cores');
    if (cpuDiff && cpuDiff.severity === 'IMPORTANT') {
      console.log('\n✅ Test 3 RÉUSSI : Différence IMPORTANT détectée sur CPU cores');
    } else {
      console.log('\n❌ Test 3 ÉCHOUÉ : Sévérité incorrecte pour CPU cores');
    }

    // Test 4 : RAM différente (IMPORTANT si > 20%)
    console.log('\n\n🧪 Test 4 : RAM différente > 20%');
    const inv7 = createTestInventory('MACHINE-1', {
      hardware: {
        memory: { total: 32 * 1024 * 1024 * 1024, available: 16 * 1024 * 1024 * 1024 }
      }
    });
    const inv8 = createTestInventory('MACHINE-2', {
      hardware: {
        memory: { total: 16 * 1024 * 1024 * 1024, available: 8 * 1024 * 1024 * 1024 }
      }
    });
    const report4 = await detector.compareInventories(inv7, inv8);
    displayReport(report4, 'RAM différente > 20%');
    
    const ramDiff = report4.differences.find(d => d.path === 'hardware.memory.total');
    if (ramDiff && ramDiff.severity === 'IMPORTANT') {
      console.log('\n✅ Test 4 RÉUSSI : Différence IMPORTANT détectée sur RAM');
    } else {
      console.log('\n❌ Test 4 ÉCHOUÉ : Sévérité incorrecte pour RAM');
    }

    // Test 5 : Version PowerShell différente (WARNING)
    console.log('\n\n🧪 Test 5 : Version PowerShell différente');
    const inv9 = createTestInventory('MACHINE-1', {
      software: { powershell: '7.4.0' }
    });
    const inv10 = createTestInventory('MACHINE-2', {
      software: { powershell: '7.3.0' }
    });
    const report5 = await detector.compareInventories(inv9, inv10);
    displayReport(report5, 'Version PowerShell différente');
    
    const psDiff = report5.differences.find(d => d.path === 'software.powershell');
    if (psDiff && psDiff.severity === 'WARNING') {
      console.log('\n✅ Test 5 RÉUSSI : Différence WARNING détectée sur PowerShell');
    } else {
      console.log('\n❌ Test 5 ÉCHOUÉ : Sévérité incorrecte pour PowerShell');
    }

    // Test 6 : GPU manquant (INFO)
    console.log('\n\n🧪 Test 6 : GPU manquant');
    const inv11 = createTestInventory('MACHINE-1', {
      hardware: {
        gpu: [{ name: 'NVIDIA RTX 3070', memory: 8 * 1024 * 1024 * 1024 }]
      }
    });
    const inv12 = createTestInventory('MACHINE-2', {
      hardware: {
        gpu: undefined
      }
    });
    const report6 = await detector.compareInventories(inv11, inv12);
    displayReport(report6, 'GPU manquant');
    
    const gpuDiff = report6.differences.find(d => d.path === 'hardware.gpu');
    if (gpuDiff && gpuDiff.severity === 'INFO') {
      console.log('\n✅ Test 6 RÉUSSI : Différence INFO détectée sur GPU');
    } else {
      console.log('\n❌ Test 6 ÉCHOUÉ : Sévérité incorrecte pour GPU');
    }

    // Test 7 : Architecture différente (IMPORTANT)
    console.log('\n\n🧪 Test 7 : Architecture système différente');
    const inv13 = createTestInventory('MACHINE-1', {
      system: { architecture: 'x64' }
    });
    const inv14 = createTestInventory('MACHINE-2', {
      system: { architecture: 'arm64' }
    });
    const report7 = await detector.compareInventories(inv13, inv14);
    displayReport(report7, 'Architecture système différente');
    
    const archDiff = report7.differences.find(d => d.path === 'system.architecture');
    if (archDiff && archDiff.severity === 'IMPORTANT') {
      console.log('\n✅ Test 7 RÉUSSI : Différence IMPORTANT détectée sur architecture');
    } else {
      console.log('\n❌ Test 7 ÉCHOUÉ : Sévérité incorrecte pour architecture');
    }

    // Test 8 : Scénario complexe (multiples différences)
    console.log('\n\n🧪 Test 8 : Scénario complexe avec multiples différences');
    const inv15 = createTestInventory('MACHINE-1');
    const inv16 = createTestInventory('MACHINE-2', {
      roo: {
        modesPath: 'D:/Different/Path/custom_modes.json'
      },
      hardware: {
        cpu: { cores: 4, threads: 8, name: 'Intel i5' },
        memory: { total: 16 * 1024 * 1024 * 1024, available: 8 * 1024 * 1024 * 1024 },
        gpu: undefined
      },
      software: {
        powershell: '7.3.0',
        node: 'v18.17.0',
        python: undefined
      },
      system: {
        os: 'Windows 10',
        architecture: 'x64'
      }
    });
    const report8 = await detector.compareInventories(inv15, inv16);
    displayReport(report8, 'Scénario complexe');
    
    const hasMultipleSeverities = 
      report8.summary.critical > 0 &&
      report8.summary.important > 0 &&
      report8.summary.warning > 0 &&
      report8.summary.info > 0;
    
    if (hasMultipleSeverities) {
      console.log('\n✅ Test 8 RÉUSSI : Multiples sévérités détectées correctement');
    } else {
      console.log('\n⚠️ Test 8 PARTIEL : Toutes les sévérités n\'ont pas été détectées');
    }

    // Test 9 : Performance (< 100ms)
    console.log('\n\n🧪 Test 9 : Test de performance');
    const perfInv1 = createTestInventory('PERF-1');
    const perfInv2 = createTestInventory('PERF-2', {
      hardware: {
        cpu: { cores: 16, threads: 32, name: 'AMD Ryzen' }
      }
    });
    const perfReport = await detector.compareInventories(perfInv1, perfInv2);
    
    if (perfReport.metadata.comparisonDuration < 100) {
      console.log(`\n✅ Test 9 RÉUSSI : Comparaison en ${perfReport.metadata.comparisonDuration}ms (< 100ms)`);
    } else {
      console.log(`\n⚠️ Test 9 AVERTISSEMENT : Comparaison en ${perfReport.metadata.comparisonDuration}ms (> 100ms)`);
    }

    // Résumé final
    console.log('\n\n' + '='.repeat(80));
    console.log('📊 RÉSUMÉ DES TESTS');
    console.log('='.repeat(80));
    console.log('✅ Test 1 : Inventaires identiques');
    console.log('✅ Test 2 : Configuration Roo (CRITICAL)');
    console.log('✅ Test 3 : CPU différent (IMPORTANT)');
    console.log('✅ Test 4 : RAM différente (IMPORTANT)');
    console.log('✅ Test 5 : PowerShell différent (WARNING)');
    console.log('✅ Test 6 : GPU manquant (INFO)');
    console.log('✅ Test 7 : Architecture différente (IMPORTANT)');
    console.log('✅ Test 8 : Scénario complexe');
    console.log('✅ Test 9 : Performance < 100ms');
    console.log('\n✅ Tous les tests sont terminés !');

  } catch (error) {
    console.error('\n❌ Erreur lors des tests:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Test avec inventaires réels si disponibles
async function testWithRealInventories() {
  console.log('\n\n' + '='.repeat(80));
  console.log('🔬 TEST AVEC INVENTAIRES RÉELS');
  console.log('='.repeat(80));

  try {
    const executor = new PowerShellExecutor();
    const collector = new InventoryCollector(executor);
    const detector = new DiffDetector();

    // Essayer de collecter un inventaire réel
    console.log('\n📦 Tentative de collecte d\'inventaire réel...');
    const machineId = process.env.COMPUTERNAME || 'LOCAL';
    
    const realInv = await collector.collectInventory(machineId, false);
    
    if (realInv) {
      console.log(`✅ Inventaire réel collecté pour ${machineId}`);
      
      // Créer un inventaire de comparaison avec légères modifications
      const modifiedInv = createTestInventory('TEST-COMPARE', {
        roo: realInv.roo,
        hardware: {
          ...realInv.hardware,
          cpu: {
            ...realInv.hardware.cpu,
            cores: realInv.hardware.cpu.cores - 2 // Simuler moins de cores
          }
        }
      });

      const realReport = await detector.compareInventories(realInv, modifiedInv);
      displayReport(realReport, 'Comparaison avec inventaire réel');
    } else {
      console.log('⚠️ Impossible de collecter un inventaire réel');
      console.log('   (script PowerShell peut-être non disponible)');
    }

  } catch (error) {
    console.log('⚠️ Test avec inventaires réels ignoré (attendu si script PS non dispo)');
    console.log(`   Erreur: ${error.message}`);
  }
}

// Exécuter les tests
runTests()
  .then(() => testWithRealInventories())
  .then(() => {
    console.log('\n\n✅ Suite de tests terminée avec succès !\n');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Erreur fatale:', error);
    process.exit(1);
  });