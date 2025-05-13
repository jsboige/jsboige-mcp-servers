/**
 * Script de configuration du MCP Jupyter pour Roo
 * 
 * Ce script configure le MCP Jupyter pour se connecter à un serveur Jupyter existant
 * en mettant à jour le fichier de configuration global de VSCode.
 * 
 * Usage:
 *   node scripts/configure-jupyter-mcp.js --url <url> --token <token>
 * 
 * Exemple:
 *   node scripts/configure-jupyter-mcp.js --url http://localhost:8888 --token roo_test_token_12345
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Fonction pour analyser les arguments de la ligne de commande
function parseArgs() {
  const args = process.argv.slice(2);
  const params = {};
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && i + 1 < args.length) {
      params.url = args[i + 1];
      i++;
    } else if (args[i] === '--token' && i + 1 < args.length) {
      params.token = args[i + 1];
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      showHelp();
      process.exit(0);
    }
  }
  
  return params;
}

// Fonction pour afficher l'aide
function showHelp() {
  console.log(`
Configuration du MCP Jupyter pour Roo

Usage:
  node scripts/configure-jupyter-mcp.js --url <url> --token <token>

Options:
  --url <url>      URL du serveur Jupyter (ex: http://localhost:8888)
  --token <token>  Token d'authentification du serveur Jupyter
  --help, -h       Afficher cette aide

Exemple:
  node scripts/configure-jupyter-mcp.js --url http://localhost:8888 --token roo_test_token_12345
  `);
}

// Fonction pour obtenir le chemin du fichier de configuration global de VSCode
function getVSCodeSettingsPath() {
  const homeDir = os.homedir();
  let settingsPath;
  
  if (process.platform === 'win32') {
    settingsPath = path.join(homeDir, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
  } else if (process.platform === 'darwin') {
    settingsPath = path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
  } else {
    settingsPath = path.join(homeDir, '.config', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
  }
  
  return settingsPath;
}

// Fonction principale
async function main() {
  // Analyser les arguments
  const params = parseArgs();
  
  // Vérifier si les paramètres requis sont présents
  if (!params.url || !params.token) {
    console.error('Erreur: Les paramètres --url et --token sont requis.');
    showHelp();
    process.exit(1);
  }
  
  // Obtenir le chemin du fichier de configuration
  const settingsPath = getVSCodeSettingsPath();
  
  // Vérifier si le fichier existe
  if (!fs.existsSync(settingsPath)) {
    console.error(`Erreur: Le fichier de configuration n'existe pas: ${settingsPath}`);
    console.error('Assurez-vous que Roo est installé et a été exécuté au moins une fois.');
    process.exit(1);
  }
  
  try {
    // Lire le fichier de configuration
    console.log(`Lecture du fichier de configuration: ${settingsPath}`);
    const settingsContent = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(settingsContent);
    
    // Vérifier si la configuration du MCP Jupyter existe
    if (!settings.mcpServers || !settings.mcpServers.jupyter) {
      console.error('Erreur: La configuration du MCP Jupyter n\'existe pas dans le fichier de configuration.');
      console.error('Assurez-vous que le MCP Jupyter est correctement installé.');
      process.exit(1);
    }
    
    // Mettre à jour la configuration
    console.log(`Configuration du MCP Jupyter avec URL: ${params.url} et Token: ${params.token}`);
    
    // Créer la configuration si elle n'existe pas
    if (!settings.mcpServers.jupyter.config) {
      settings.mcpServers.jupyter.config = {};
    }
    
    if (!settings.mcpServers.jupyter.config.jupyterServer) {
      settings.mcpServers.jupyter.config.jupyterServer = {};
    }
    
    // Mettre à jour les paramètres
    settings.mcpServers.jupyter.config.jupyterServer.baseUrl = params.url;
    settings.mcpServers.jupyter.config.jupyterServer.token = params.token;
    settings.mcpServers.jupyter.config.jupyterServer.skipConnectionCheck = false;
    settings.mcpServers.jupyter.config.jupyterServer.offlineMode = false;
    settings.mcpServers.jupyter.config.offlineMode = false;
    settings.mcpServers.jupyter.config.skipConnectionCheck = false;
    
    // Désactiver le mode hors ligne
    settings.mcpServers.jupyter.disabled = false;
    
    // Écrire le fichier de configuration mis à jour
    console.log('Mise à jour du fichier de configuration...');
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    
    console.log('Configuration du MCP Jupyter terminée avec succès!');
    console.log('\nPour vérifier la configuration, exécutez:');
    console.log('  node tests/test-jupyter-connection.js');
    console.log('\nPour utiliser le MCP Jupyter avec Roo, redémarrez le serveur MCP Jupyter:');
    console.log('  scripts/mcp-starters/start-jupyter-mcp.bat');
    
  } catch (error) {
    console.error('Erreur lors de la mise à jour de la configuration:', error);
    process.exit(1);
  }
}

// Exécuter la fonction principale
main().catch(error => {
  console.error('Erreur non gérée:', error);
  process.exit(1);
});