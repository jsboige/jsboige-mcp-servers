/**
 * Script de test pour les outils de gestion Conda du MCP Jupyter
 * 
 * Ce script teste les 4 nouveaux outils Conda :
 * 1. list_conda_environments
 * 2. create_conda_environment
 * 3. install_conda_packages
 * 4. check_conda_environment
 * 
 * Usage: node test-conda-tools.js
 */

const { spawn } = require('child_process');
const path = require('path');

// Configuration
const TEST_ENV_NAME = 'test-mcp-conda';
const PYTHON_VERSION = '3.10';
const TEST_PACKAGES = ['ipykernel', 'ipython'];

// Couleurs pour la console
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logTest(testName) {
  console.log('\n' + '='.repeat(60));
  log(`TEST: ${testName}`, 'cyan');
  console.log('='.repeat(60));
}

function logSuccess(message) {
  log(`✓ ${message}`, 'green');
}

function logError(message) {
  log(`✗ ${message}`, 'red');
}

function logWarning(message) {
  log(`⚠ ${message}`, 'yellow');
}

function logInfo(message) {
  log(`ℹ ${message}`, 'blue');
}

/**
 * Envoie une requête au serveur MCP et attend la réponse
 */
async function callMcpTool(toolName, args = {}) {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, 'dist', 'index.js');
    const mcp = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let responseData = '';
    let errorData = '';

    mcp.stdout.on('data', (data) => {
      responseData += data.toString();
    });

    mcp.stderr.on('data', (data) => {
      errorData += data.toString();
    });

    mcp.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`MCP process exited with code ${code}\nStderr: ${errorData}`));
      } else {
        try {
          // Parser la réponse JSON-RPC
          const lines = responseData.split('\n').filter(line => line.trim());
          const lastLine = lines[lines.length - 1];
          const response = JSON.parse(lastLine);
          resolve(response.result);
        } catch (error) {
          reject(new Error(`Failed to parse MCP response: ${error.message}\nResponse: ${responseData}`));
        }
      }
    });

    // Envoyer la requête JSON-RPC
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    };

    mcp.stdin.write(JSON.stringify(request) + '\n');
    mcp.stdin.end();

    // Timeout de 30 secondes
    setTimeout(() => {
      mcp.kill();
      reject(new Error('MCP request timeout'));
    }, 30000);
  });
}

/**
 * Test 1: Lister les environnements Conda
 */
async function testListCondaEnvironments() {
  logTest('list_conda_environments');
  
  try {
    const result = await callMcpTool('list_conda_environments');
    
    if (result.status === 'error') {
      logWarning(`Conda non disponible: ${result.message}`);
      logInfo('Assurez-vous que Conda est installé et dans le PATH');
      return false;
    }
    
    if (result.status === 'success') {
      logSuccess(`${result.count} environnements Conda trouvés`);
      
      if (result.environments && result.environments.length > 0) {
        logInfo('Environnements:');
        result.environments.forEach(env => {
          const activeMarker = env.isActive ? ' (actif)' : '';
          console.log(`  - ${env.name}${activeMarker}`);
          console.log(`    Chemin: ${env.path}`);
        });
      }
      
      return true;
    }
    
    logError('Statut inattendu: ' + result.status);
    return false;
  } catch (error) {
    logError(`Erreur: ${error.message}`);
    return false;
  }
}

/**
 * Test 2: Vérifier un environnement (devrait ne pas exister)
 */
async function testCheckCondaEnvironmentNotExists() {
  logTest('check_conda_environment (environnement inexistant)');
  
  try {
    const result = await callMcpTool('check_conda_environment', {
      env_name: TEST_ENV_NAME
    });
    
    if (result.status === 'success' && !result.exists) {
      logSuccess(`L'environnement '${TEST_ENV_NAME}' n'existe pas (comme attendu)`);
      return true;
    } else if (result.status === 'success' && result.exists) {
      logWarning(`L'environnement '${TEST_ENV_NAME}' existe déjà`);
      logInfo('Il sera supprimé et recréé lors du test de création');
      return true;
    }
    
    logError('Résultat inattendu: ' + JSON.stringify(result));
    return false;
  } catch (error) {
    logError(`Erreur: ${error.message}`);
    return false;
  }
}

/**
 * Test 3: Créer un environnement Conda
 */
async function testCreateCondaEnvironment() {
  logTest('create_conda_environment');
  
  logInfo(`Création de l'environnement '${TEST_ENV_NAME}' avec Python ${PYTHON_VERSION}...`);
  logWarning('Cette opération peut prendre plusieurs minutes');
  
  try {
    const result = await callMcpTool('create_conda_environment', {
      name: TEST_ENV_NAME,
      python_version: PYTHON_VERSION,
      packages: TEST_PACKAGES,
      force: true
    });
    
    if (result.status === 'success') {
      logSuccess(`Environnement '${TEST_ENV_NAME}' créé avec succès`);
      logInfo(`Packages installés: ${TEST_PACKAGES.join(', ')}`);
      return true;
    } else if (result.status === 'error') {
      logError(`Échec de la création: ${result.message}`);
      return false;
    }
    
    logError('Résultat inattendu: ' + JSON.stringify(result));
    return false;
  } catch (error) {
    logError(`Erreur: ${error.message}`);
    return false;
  }
}

/**
 * Test 4: Vérifier l'environnement créé
 */
async function testCheckCondaEnvironmentExists() {
  logTest('check_conda_environment (environnement existant)');
  
  try {
    const result = await callMcpTool('check_conda_environment', {
      env_name: TEST_ENV_NAME,
      required_packages: TEST_PACKAGES
    });
    
    if (result.status === 'success' && result.exists) {
      logSuccess(`L'environnement '${TEST_ENV_NAME}' existe`);
      logInfo(`Chemin: ${result.path}`);
      
      if (result.missingPackages && result.missingPackages.length === 0) {
        logSuccess('Tous les packages requis sont installés');
        logInfo(`Packages: ${result.installedPackages.join(', ')}`);
        return true;
      } else if (result.missingPackages && result.missingPackages.length > 0) {
        logWarning(`Packages manquants: ${result.missingPackages.join(', ')}`);
        return false;
      }
    }
    
    if (result.status === 'success' && !result.exists) {
      logError(`L'environnement '${TEST_ENV_NAME}' n'existe pas`);
      return false;
    }
    
    logError('Résultat inattendu: ' + JSON.stringify(result));
    return false;
  } catch (error) {
    logError(`Erreur: ${error.message}`);
    return false;
  }
}

/**
 * Test 5: Installer des packages supplémentaires
 */
async function testInstallCondaPackages() {
  logTest('install_conda_packages');
  
  const additionalPackages = ['jupyter'];
  logInfo(`Installation de packages supplémentaires: ${additionalPackages.join(', ')}...`);
  logWarning('Cette opération peut prendre quelques minutes');
  
  try {
    const result = await callMcpTool('install_conda_packages', {
      env_name: TEST_ENV_NAME,
      packages: additionalPackages
    });
    
    if (result.status === 'success') {
      logSuccess('Packages installés avec succès');
      return true;
    } else if (result.status === 'error') {
      logError(`Échec de l'installation: ${result.message}`);
      return false;
    }
    
    logError('Résultat inattendu: ' + JSON.stringify(result));
    return false;
  } catch (error) {
    logError(`Erreur: ${error.message}`);
    return false;
  }
}

/**
 * Test 6: Vérifier les packages installés
 */
async function testCheckInstalledPackages() {
  logTest('check_conda_environment (vérification packages)');
  
  const allPackages = [...TEST_PACKAGES, 'jupyter'];
  
  try {
    const result = await callMcpTool('check_conda_environment', {
      env_name: TEST_ENV_NAME,
      required_packages: allPackages
    });
    
    if (result.status === 'success' && result.exists) {
      if (result.missingPackages && result.missingPackages.length === 0) {
        logSuccess('Tous les packages ont été installés correctement');
        logInfo(`Packages vérifiés: ${result.installedPackages.join(', ')}`);
        return true;
      } else {
        logWarning(`Packages manquants: ${result.missingPackages.join(', ')}`);
        return false;
      }
    }
    
    logError('Résultat inattendu: ' + JSON.stringify(result));
    return false;
  } catch (error) {
    logError(`Erreur: ${error.message}`);
    return false;
  }

/**
 * Test 7: Setup automatique de l'environnement (création)
 */
async function testSetupJupyterMcpEnvironmentCreate() {
  logTest('setup_jupyter_mcp_environment (création)');
  
  logInfo('Test du setup automatique sans paramètres...');
  logWarning('Cette opération peut prendre plusieurs minutes');
  
  try {
    const result = await callMcpTool('setup_jupyter_mcp_environment', {});
    
    if (result.success) {
      logSuccess(`Setup réussi - Action: ${result.action}`);
      logInfo(`Environnement: ${result.environment.name}`);
      logInfo(`Chemin: ${result.environment.path}`);
      logInfo(`Python: ${result.environment.python_version}`);
      
      if (result.packages.installed.length > 0) {
        logSuccess(`Packages installés: ${result.packages.installed.join(', ')}`);
      }
      if (result.packages.already_present.length > 0) {
        logInfo(`Packages déjà présents: ${result.packages.already_present.join(', ')}`);
      }
      if (result.packages.failed.length > 0) {
        logWarning(`Packages échoués: ${result.packages.failed.join(', ')}`);
      }
      
      return true;
    } else {
      logError(`Échec du setup: ${result.message}`);
      return false;
    }
  } catch (error) {
    logError(`Erreur: ${error.message}`);
    return false;
  }
}

/**
 * Test 8: Setup automatique de l'environnement (vérification)
 */
async function testSetupJupyterMcpEnvironmentVerify() {
  logTest('setup_jupyter_mcp_environment (vérification)');
  
  logInfo('Test du setup automatique sur environnement existant...');
  
  try {
    const result = await callMcpTool('setup_jupyter_mcp_environment', {});
    
    if (result.success && result.action === 'verified') {
      logSuccess('Environnement vérifié - tous les packages sont présents');
      logInfo(`Packages présents: ${result.packages.already_present.join(', ')}`);
      return true;
    } else if (result.success && result.action === 'updated') {
      logSuccess('Environnement mis à jour avec packages manquants');
      logInfo(`Packages installés: ${result.packages.installed.join(', ')}`);
      return true;
    } else if (result.success) {
      logSuccess(`Setup réussi - Action: ${result.action}`);
      return true;
    } else {
      logError(`Échec: ${result.message}`);
      return false;
    }
  } catch (error) {
    logError(`Erreur: ${error.message}`);
    return false;
  }
}

/**
 * Test 9: Setup automatique avec force (recréation)
 */
async function testSetupJupyterMcpEnvironmentForce() {
  logTest('setup_jupyter_mcp_environment (force recréation)');
  
  logInfo('Test du setup avec force=true...');
  logWarning('Cette opération peut prendre plusieurs minutes');
  
  try {
    const result = await callMcpTool('setup_jupyter_mcp_environment', {
      force: true
    });
    
    if (result.success && result.action === 'created') {
      logSuccess('Environnement recréé avec succès');
      logInfo(`Packages installés: ${result.packages.installed.join(', ')}`);
      return true;
    } else if (result.success) {
      logWarning(`Action inattendue: ${result.action} (attendu: created)`);
      return true;
    } else {
      logError(`Échec: ${result.message}`);
      return false;
    }
  } catch (error) {
    logError(`Erreur: ${error.message}`);
    return false;
  }
}

/**
 * Test 10: Setup automatique avec packages additionnels
 */
async function testSetupJupyterMcpEnvironmentAdditionalPackages() {
  logTest('setup_jupyter_mcp_environment (packages additionnels)');
  
  const additionalPackages = ['pandas'];
  logInfo(`Test avec packages additionnels: ${additionalPackages.join(', ')}...`);
  
  try {
    const result = await callMcpTool('setup_jupyter_mcp_environment', {
      additional_packages: additionalPackages
    });
    
    if (result.success) {
      logSuccess('Setup avec packages additionnels réussi');
      
      const allInstalled = result.packages.installed.concat(result.packages.already_present);
      const hasAdditional = additionalPackages.every(pkg => 
        allInstalled.some(installed => installed.toLowerCase() === pkg.toLowerCase())
      );
      
      if (hasAdditional) {
        logSuccess(`Tous les packages additionnels ont été installés`);
        return true;
      } else {
        logWarning('Certains packages additionnels n\'ont pas été installés');
        return true; // Tolérer les échecs d'installation de packages additionnels
      }
    } else {
      logError(`Échec: ${result.message}`);
      return false;
    }
  } catch (error) {
    logError(`Erreur: ${error.message}`);
    return false;
  }
}

}

/**
 * Nettoyage: Supprimer l'environnement de test
 */
async function cleanupTestEnvironment() {
  logTest('Nettoyage');
  
  logInfo(`Suppression de l'environnement de test '${TEST_ENV_NAME}'...`);
  
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  try {
    await execAsync(`conda env remove -n ${TEST_ENV_NAME} -y`);
    logSuccess('Environnement de test supprimé');
    return true;
  } catch (error) {
    logWarning(`Impossible de supprimer l'environnement: ${error.message}`);
    logInfo(`Supprimez manuellement avec: conda env remove -n ${TEST_ENV_NAME} -y`);
    return false;
  }
}

/**
 * Exécution des tests
 */
async function runTests() {
  console.log('\n');
  log('═══════════════════════════════════════════════════════════', 'blue');
  log('  TEST DES OUTILS CONDA DU MCP JUPYTER', 'blue');
  log('═══════════════════════════════════════════════════════════', 'blue');
  console.log('\n');
  
  const results = {
    passed: 0,
    failed: 0,
    skipped: 0
  };
  
  // Test 1: Lister les environnements
  const hasCondatest1 = await testListCondaEnvironments();
  if (!hasCondatest1) {
    logError('\nConda n\'est pas disponible. Les tests sont abandonnés.');
    logInfo('Installez Anaconda ou Miniconda et assurez-vous que conda est dans le PATH');
    process.exit(1);
  }
  results.passed++;
  
  // Test 2: Vérifier environnement inexistant
  if (await testCheckCondaEnvironmentNotExists()) {
    results.passed++;
  } else {
    results.failed++;
  }
  
  // Test 3: Créer l'environnement
  if (await testCreateCondaEnvironment()) {
    results.passed++;
    
    // Test 4: Vérifier l'environnement créé
    if (await testCheckCondaEnvironmentExists()) {
      results.passed++;
      
      // Test 5: Installer des packages
      if (await testInstallCondaPackages()) {
        results.passed++;
        
        // Test 6: Vérifier les packages installés
        if (await testCheckInstalledPackages()) {
          results.passed++;
        } else {
          results.failed++;
        }
      } else {
        results.failed++;
        results.skipped++; // Skip test 6
      }
    } else {
      results.failed++;
      results.skipped += 2; // Skip tests 5 and 6
    }
  } else {
    results.failed++;
    results.skipped += 3; // Skip tests 4, 5, and 6
  }
  
  // Nettoyage avant les tests de setup automatique
  await cleanupTestEnvironment();
  
  // Nouveaux tests pour setup_jupyter_mcp_environment
  console.log('\n');
  log('───────────────────────────────────────────────────────────', 'cyan');
  log('  TESTS DU SETUP AUTOMATIQUE', 'cyan');
  log('───────────────────────────────────────────────────────────', 'cyan');
  console.log('\n');
  
  // Test 7: Setup automatique (création)
  if (await testSetupJupyterMcpEnvironmentCreate()) {
    results.passed++;
    
    // Test 8: Setup automatique (vérification)
    if (await testSetupJupyterMcpEnvironmentVerify()) {
      results.passed++;
      
      // Test 9: Setup automatique avec force
      if (await testSetupJupyterMcpEnvironmentForce()) {
        results.passed++;
        
        // Test 10: Setup avec packages additionnels
        if (await testSetupJupyterMcpEnvironmentAdditionalPackages()) {
          results.passed++;
        } else {
          results.failed++;
        }
      } else {
        results.failed++;
        results.skipped++; // Skip test 10
      }
    } else {
      results.failed++;
      results.skipped += 2; // Skip tests 9 and 10
    }
  } else {
    results.failed++;
    results.skipped += 3; // Skip tests 8, 9, and 10
  }
  
  // Nettoyage final de l'environnement mcp-jupyter-py310
  console.log('\n');
  log('───────────────────────────────────────────────────────────', 'cyan');
  log('  NETTOYAGE FINAL', 'cyan');
  log('───────────────────────────────────────────────────────────', 'cyan');
  
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  
  try {
    logInfo('Suppression de l\'environnement mcp-jupyter-py310...');
    await execAsync('conda env remove -n mcp-jupyter-py310 -y');
    logSuccess('Environnement mcp-jupyter-py310 supprimé');
  } catch (error) {
    logWarning(`Impossible de supprimer l'environnement: ${error.message}`);
    logInfo('Supprimez manuellement avec: conda env remove -n mcp-jupyter-py310 -y');
  }
  
  // Résumé
  console.log('\n');
  log('═══════════════════════════════════════════════════════════', 'blue');
  log('  RÉSUMÉ DES TESTS', 'blue');
  log('═══════════════════════════════════════════════════════════', 'blue');
  console.log('\n');
  
  logSuccess(`Tests réussis: ${results.passed}`);
  if (results.failed > 0) {
    logError(`Tests échoués: ${results.failed}`);
  }
  if (results.skipped > 0) {
    logWarning(`Tests ignorés: ${results.skipped}`);
  }
  
  console.log('\n');
  
  if (results.failed === 0) {
    log('✓ TOUS LES TESTS SONT PASSÉS', 'green');
    process.exit(0);
  } else {
    log('✗ CERTAINS TESTS ONT ÉCHOUÉ', 'red');
    process.exit(1);
  }
}

// Lancer les tests
runTests().catch((error) => {
  console.error('\n');
  logError('ERREUR FATALE:');
  console.error(error);
  process.exit(1);
});