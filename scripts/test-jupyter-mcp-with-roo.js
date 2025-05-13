/**
 * Script de test du MCP Jupyter avec Roo
 * 
 * Ce script guide l'utilisateur à travers les étapes de test du MCP Jupyter avec Roo,
 * en mode connecté et en mode hors ligne.
 * 
 * Usage:
 *   node scripts/test-jupyter-mcp-with-roo.js
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

// Obtenir le chemin du répertoire actuel en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Couleurs pour la console
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',
  
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m'
};

// Fonction pour afficher un titre
function printTitle(title) {
  console.log('\n' + colors.bright + colors.cyan + '='.repeat(80) + colors.reset);
  console.log(colors.bright + colors.cyan + ' ' + title + colors.reset);
  console.log(colors.bright + colors.cyan + '='.repeat(80) + colors.reset + '\n');
}

// Fonction pour afficher une étape
function printStep(step, description) {
  console.log(colors.bright + colors.yellow + `[Étape ${step}]` + colors.reset + ' ' + description);
}

// Fonction pour afficher une commande
function printCommand(command) {
  console.log(colors.bright + colors.green + '  > ' + colors.reset + command);
}

// Fonction pour afficher une note
function printNote(note) {
  console.log(colors.dim + colors.white + '  Note: ' + note + colors.reset);
}

// Fonction pour afficher un exemple
function printExample(title, content) {
  console.log(colors.bright + colors.magenta + '  ' + title + ':' + colors.reset);
  console.log(colors.white + '  ```' + colors.reset);
  console.log(content.split('\n').map(line => '  ' + line).join('\n'));
  console.log(colors.white + '  ```' + colors.reset);
}

// Fonction pour afficher un avertissement
function printWarning(warning) {
  console.log(colors.bright + colors.red + '  ⚠️ ' + warning + colors.reset);
}

// Fonction pour afficher un succès
function printSuccess(message) {
  console.log(colors.bright + colors.green + '  ✓ ' + message + colors.reset);
}
// Fonction pour vérifier si Jupyter est installé
function checkJupyterInstalled() {
  try {
    execSync('jupyter --version', { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

// Fonction pour vérifier si un serveur Jupyter est en cours d'exécution
function checkJupyterRunning() {
  try {
    execSync('powershell -Command "Get-Process | Where-Object { $_.ProcessName -eq \'jupyter-notebook\' -or $_.ProcessName -eq \'jupyter\' }"', { stdio: 'pipe' });
    return true;
  } catch (error) {
    return false;
  }
}

// Fonction pour vérifier si le MCP Jupyter est en cours d'exécution
function checkJupyterMCPRunning() {
  try {
    const result = execSync('powershell -Command "Get-Process | Where-Object { $_.CommandLine -like \'*jupyter-mcp-server*\' }"', { stdio: 'pipe' });
    return result.toString().trim() !== '';
  } catch (error) {
    return false;
  }
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

// Fonction pour vérifier si le MCP Jupyter est correctement configuré
function checkJupyterMCPConfig() {
  const settingsPath = getVSCodeSettingsPath();
  
  if (!fs.existsSync(settingsPath)) {
    return {
      configured: false,
      error: `Le fichier de configuration n'existe pas: ${settingsPath}`
    };
  }
  
  try {
    const settingsContent = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(settingsContent);
    
    if (!settings.mcpServers || !settings.mcpServers.jupyter) {
      return {
        configured: false,
        error: 'La configuration du MCP Jupyter n\'existe pas dans le fichier de configuration.'
      };
    }
    
    const jupyterConfig = settings.mcpServers.jupyter;
    
    return {
      configured: true,
      offlineMode: jupyterConfig.config?.offlineMode || jupyterConfig.config?.jupyterServer?.offlineMode,
      baseUrl: jupyterConfig.config?.jupyterServer?.baseUrl,
      token: jupyterConfig.config?.jupyterServer?.token,
      skipConnectionCheck: jupyterConfig.config?.skipConnectionCheck || jupyterConfig.config?.jupyterServer?.skipConnectionCheck,
      disabled: jupyterConfig.disabled
    };
  } catch (error) {
    return {
      configured: false,
      error: `Erreur lors de la lecture du fichier de configuration: ${error.message}`
    };
  }
}

// Fonction pour mettre à jour la configuration du MCP Jupyter
function updateJupyterMCPConfig(config) {
  const settingsPath = getVSCodeSettingsPath();
  
  if (!fs.existsSync(settingsPath)) {
    throw new Error(`Le fichier de configuration n'existe pas: ${settingsPath}`);
  }
  
  try {
    const settingsContent = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(settingsContent);
    
    if (!settings.mcpServers || !settings.mcpServers.jupyter) {
      throw new Error('La configuration du MCP Jupyter n\'existe pas dans le fichier de configuration.');
    }
    
    // Créer la configuration si elle n'existe pas
    if (!settings.mcpServers.jupyter.config) {
      settings.mcpServers.jupyter.config = {};
    }
    
    if (!settings.mcpServers.jupyter.config.jupyterServer) {
      settings.mcpServers.jupyter.config.jupyterServer = {};
    }
    
    // Mettre à jour les paramètres
    if (config.offlineMode !== undefined) {
      settings.mcpServers.jupyter.config.offlineMode = config.offlineMode;
      settings.mcpServers.jupyter.config.jupyterServer.offlineMode = config.offlineMode;
    }
    
    if (config.baseUrl) {
      settings.mcpServers.jupyter.config.jupyterServer.baseUrl = config.baseUrl;
    }
    
    if (config.token) {
      settings.mcpServers.jupyter.config.jupyterServer.token = config.token;
    }
    
    if (config.skipConnectionCheck !== undefined) {
      settings.mcpServers.jupyter.config.skipConnectionCheck = config.skipConnectionCheck;
      settings.mcpServers.jupyter.config.jupyterServer.skipConnectionCheck = config.skipConnectionCheck;
    }
    
    if (config.disabled !== undefined) {
      settings.mcpServers.jupyter.disabled = config.disabled;
    }
    
    // Écrire le fichier de configuration mis à jour
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    
    return true;
  } catch (error) {
    throw new Error(`Erreur lors de la mise à jour de la configuration: ${error.message}`);
  }
}
// Fonction principale
async function main() {
  printTitle('Test du MCP Jupyter avec Roo');
  
  console.log('Ce script va vous guider à travers les étapes de test du MCP Jupyter avec Roo,');
  console.log('en mode connecté et en mode hors ligne.\n');
  
  // Vérifier si Jupyter est installé
  printStep(1, 'Vérification de l\'installation de Jupyter');
  
  if (!checkJupyterInstalled()) {
    printWarning('Jupyter n\'est pas installé ou n\'est pas dans le PATH.');
    printNote('Veuillez installer Jupyter avec: pip install jupyter');
    process.exit(1);
  }
  
  printSuccess('Jupyter est installé.');
  
  // Vérifier si un serveur Jupyter est en cours d'exécution
  printStep(2, 'Vérification du serveur Jupyter');
  
  const jupyterRunning = checkJupyterRunning();
  
  if (jupyterRunning) {
    printSuccess('Un serveur Jupyter est déjà en cours d\'exécution.');
    printNote('Si vous souhaitez utiliser un nouveau serveur, veuillez arrêter celui en cours d\'exécution.');
  } else {
    printNote('Aucun serveur Jupyter n\'est en cours d\'exécution.');
    printNote('Nous allons démarrer un serveur Jupyter pour les tests.');
    
    printCommand('scripts\\start-jupyter-for-test.bat');
    printNote('Suivez les instructions affichées par le script pour configurer le MCP Jupyter.');
    printNote('Une fois le serveur démarré, notez l\'URL et le token d\'authentification.');
    printNote('Appuyez sur Entrée pour continuer...');
    
    // Attendre que l'utilisateur appuie sur Entrée
    await new Promise(resolve => {
      process.stdin.once('data', () => {
        resolve();
      });
    });
  }
  
  // Vérifier la configuration du MCP Jupyter
  printStep(3, 'Vérification de la configuration du MCP Jupyter');
  
  const mcpConfig = checkJupyterMCPConfig();
  
  if (!mcpConfig.configured) {
    printWarning(`La configuration du MCP Jupyter n'est pas correcte: ${mcpConfig.error}`);
    printNote('Veuillez configurer le MCP Jupyter avec le script configure-jupyter-mcp.js.');
    printCommand('node scripts/configure-jupyter-mcp.js --url <url> --token <token>');
    printNote('Remplacez <url> et <token> par les valeurs affichées par le script start-jupyter-for-test.bat.');
    printNote('Appuyez sur Entrée pour continuer...');
    
    // Attendre que l'utilisateur appuie sur Entrée
    await new Promise(resolve => {
      process.stdin.once('data', () => {
        resolve();
      });
    });
  } else {
    printSuccess('La configuration du MCP Jupyter est correcte.');
    printNote(`Mode hors ligne: ${mcpConfig.offlineMode ? 'Activé' : 'Désactivé'}`);
    printNote(`URL du serveur: ${mcpConfig.baseUrl}`);
    printNote(`Token d'authentification: ${mcpConfig.token}`);
    printNote(`Vérification de connexion ignorée: ${mcpConfig.skipConnectionCheck ? 'Oui' : 'Non'}`);
    printNote(`Serveur désactivé: ${mcpConfig.disabled ? 'Oui' : 'Non'}`);
  }
  
  // Vérifier si le MCP Jupyter est en cours d'exécution
  printStep(4, 'Vérification du MCP Jupyter');
  
  const mcpRunning = checkJupyterMCPRunning();
  
  if (mcpRunning) {
    printSuccess('Le MCP Jupyter est déjà en cours d\'exécution.');
    printNote('Si vous souhaitez redémarrer le MCP Jupyter, veuillez d\'abord l\'arrêter.');
  } else {
    printNote('Le MCP Jupyter n\'est pas en cours d\'exécution.');
    printNote('Nous allons démarrer le MCP Jupyter pour les tests.');
    
    printCommand('scripts\\mcp-starters\\start-jupyter-mcp.bat');
    printNote('Appuyez sur Entrée pour continuer...');
    
    // Attendre que l'utilisateur appuie sur Entrée
    await new Promise(resolve => {
      process.stdin.once('data', () => {
        resolve();
      });
    });
  }
  
  // Tests en mode connecté
  printTitle('Tests en mode connecté');
  
  // Vérifier si le mode hors ligne est activé
  if (mcpConfig.offlineMode) {
    printWarning('Le mode hors ligne est actuellement activé.');
    printNote('Nous allons désactiver le mode hors ligne pour les tests en mode connecté.');
    
    try {
      updateJupyterMCPConfig({
        offlineMode: false,
        skipConnectionCheck: false
      });
      
      printSuccess('Mode hors ligne désactivé.');
      printNote('Veuillez redémarrer le MCP Jupyter pour appliquer les changements.');
      printCommand('scripts\\mcp-starters\\start-jupyter-mcp.bat');
      printNote('Appuyez sur Entrée pour continuer...');
      
      // Attendre que l'utilisateur appuie sur Entrée
      await new Promise(resolve => {
        process.stdin.once('data', () => {
          resolve();
        });
      });
    } catch (error) {
      printWarning(`Erreur lors de la mise à jour de la configuration: ${error.message}`);
      printNote('Veuillez mettre à jour manuellement la configuration du MCP Jupyter.');
      printNote('Appuyez sur Entrée pour continuer...');
      
      // Attendre que l'utilisateur appuie sur Entrée
      await new Promise(resolve => {
        process.stdin.once('data', () => {
          resolve();
        });
      });
    }
  }
  
  printStep(5, 'Tests des fonctionnalités en mode connecté');
  
  printNote('Ouvrez une conversation avec Roo et utilisez les commandes suivantes pour tester le MCP Jupyter:');
  
  // Vérifier le mode hors ligne
  printExample('Vérifier le mode hors ligne', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>get_offline_status</tool_name>
<arguments>
{}
</arguments>
</use_mcp_tool>`);
  
  // Lister les kernels disponibles
  printExample('Lister les kernels disponibles', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>list_kernels</tool_name>
<arguments>
{}
</arguments>
</use_mcp_tool>`);
  
  // Démarrer un nouveau kernel
  printExample('Démarrer un nouveau kernel', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>start_kernel</tool_name>
<arguments>
{
  "kernel_name": "python3"
}
</arguments>
</use_mcp_tool>`);
  
  printNote('Notez l\'ID du kernel retourné par la commande précédente.');
  printNote('Vous aurez besoin de cet ID pour les commandes suivantes.');
  
  // Créer un nouveau notebook
  printExample('Créer un nouveau notebook', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>create_notebook</tool_name>
<arguments>
{
  "path": "tests/test_notebook_roo.ipynb",
  "kernel": "python3"
}
</arguments>
</use_mcp_tool>`);
  
  // Ajouter une cellule au notebook
  printExample('Ajouter une cellule au notebook', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>add_cell</tool_name>
<arguments>
{
  "path": "tests/test_notebook_roo.ipynb",
  "cell_type": "code",
  "source": "print('Hello from Jupyter MCP!')"
}
</arguments>
</use_mcp_tool>`);
  
  // Exécuter une cellule de code
  printExample('Exécuter une cellule de code', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>execute_cell</tool_name>
<arguments>
{
  "kernel_id": "KERNEL_ID",
  "code": "import sys\\nprint(f'Python version: {sys.version}')\\nprint('Hello from Jupyter!')"
}
</arguments>
</use_mcp_tool>`);
  
  printNote('Remplacez KERNEL_ID par l\'ID du kernel noté précédemment.');
  
  // Redémarrer un kernel
  printExample('Redémarrer un kernel', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>restart_kernel</tool_name>
<arguments>
{
  "kernel_id": "KERNEL_ID"
}
</arguments>
</use_mcp_tool>`);
  
  // Arrêter un kernel
  printExample('Arrêter un kernel', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>stop_kernel</tool_name>
<arguments>
{
  "kernel_id": "KERNEL_ID"
}
</arguments>
</use_mcp_tool>`);
  
  printNote('Appuyez sur Entrée pour continuer avec les tests en mode hors ligne...');
  
  // Attendre que l'utilisateur appuie sur Entrée
  await new Promise(resolve => {
    process.stdin.once('data', () => {
      resolve();
    });
  });
  
  // Tests en mode hors ligne
  printTitle('Tests en mode hors ligne');
  
  printStep(6, 'Passage en mode hors ligne');
  
  printNote('Nous allons activer le mode hors ligne pour les tests.');
  
  try {
    updateJupyterMCPConfig({
      offlineMode: true,
      skipConnectionCheck: true
    });
    
    printSuccess('Mode hors ligne activé.');
    printNote('Veuillez redémarrer le MCP Jupyter pour appliquer les changements.');
    printCommand('scripts\\mcp-starters\\start-jupyter-mcp.bat');
    printNote('Appuyez sur Entrée pour continuer...');
    
    // Attendre que l'utilisateur appuie sur Entrée
    await new Promise(resolve => {
      process.stdin.once('data', () => {
        resolve();
      });
    });
  } catch (error) {
    printWarning(`Erreur lors de la mise à jour de la configuration: ${error.message}`);
    printNote('Veuillez mettre à jour manuellement la configuration du MCP Jupyter.');
    printNote('Appuyez sur Entrée pour continuer...');
    
    // Attendre que l'utilisateur appuie sur Entrée
    await new Promise(resolve => {
      process.stdin.once('data', () => {
        resolve();
      });
    });
  }
  
  printStep(7, 'Tests des fonctionnalités en mode hors ligne');
  
  printNote('Ouvrez une conversation avec Roo et utilisez les commandes suivantes pour tester le MCP Jupyter en mode hors ligne:');
  
  // Vérifier le mode hors ligne
  printExample('Vérifier le mode hors ligne', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>get_offline_status</tool_name>
<arguments>
{}
</arguments>
</use_mcp_tool>`);
  
  // Tenter de lister les kernels
  printExample('Tenter de lister les kernels', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>list_kernels</tool_name>
<arguments>
{}
</arguments>
</use_mcp_tool>`);
  
  // Créer un nouveau notebook en mode hors ligne
  printExample('Créer un nouveau notebook en mode hors ligne', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>create_notebook</tool_name>
<arguments>
{
  "path": "tests/test_notebook_offline.ipynb",
  "kernel": "python3"
}
</arguments>
</use_mcp_tool>`);
  
  // Ajouter une cellule au notebook en mode hors ligne
  printExample('Ajouter une cellule au notebook en mode hors ligne', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>add_cell</tool_name>
<arguments>
{
  "path": "tests/test_notebook_offline.ipynb",
  "cell_type": "code",
  "source": "print('This is an offline test')"
}
</arguments>
</use_mcp_tool>`);
  
  // Tenter d'exécuter du code en mode hors ligne
  printExample('Tenter d\'exécuter du code en mode hors ligne', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>execute_cell</tool_name>
<arguments>
{
  "kernel_id": "simulated-kernel",
  "code": "print('Hello from offline mode')"
}
</arguments>
</use_mcp_tool>`);
  
  printNote('Appuyez sur Entrée pour continuer avec les tests de changement de mode...');
  
  // Attendre que l'utilisateur appuie sur Entrée
  await new Promise(resolve => {
    process.stdin.once('data', () => {
      resolve();
    });
  });
  
  // Tests de changement de mode
  printTitle('Tests de changement de mode');
  
  printStep(8, 'Passage dynamique entre les modes');
  
  printNote('Vous pouvez changer dynamiquement entre le mode connecté et le mode hors ligne en utilisant la commande suivante:');
  
  // Désactiver le mode hors ligne via l'outil MCP
  printExample('Désactiver le mode hors ligne via l\'outil MCP', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>set_offline_mode</tool_name>
<arguments>
{
  "enabled": false
}
</arguments>
</use_mcp_tool>`);
  
  // Vérifier que le mode hors ligne est désactivé
  printExample('Vérifier que le mode hors ligne est désactivé', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>get_offline_status</tool_name>
<arguments>
{}
</arguments>
</use_mcp_tool>`);
  
  // Tester une fonctionnalité qui nécessite une connexion
  printExample('Tester une fonctionnalité qui nécessite une connexion', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>list_kernels</tool_name>
<arguments>
{}
</arguments>
</use_mcp_tool>`);
  
  // Réactiver le mode hors ligne
  printExample('Réactiver le mode hors ligne', `<use_mcp_tool>
<server_name>jupyter</server_name>
<tool_name>set_offline_mode</tool_name>
<arguments>
{
  "enabled": true
}
</arguments>
</use_mcp_tool>`);
  
  printNote('Appuyez sur Entrée pour continuer avec la vérification finale...');
  
  // Attendre que l'utilisateur appuie sur Entrée
  await new Promise(resolve => {
    process.stdin.once('data', () => {
      resolve();
    });
  });
  
  // Vérification finale
  printTitle('Vérification finale');
  
  printStep(9, 'Vérification du comportement au démarrage');
  
  printNote('Nous allons vérifier que le MCP Jupyter ne lance pas d\'invite de commande au démarrage en mode hors ligne.');
  printNote('Veuillez suivre ces étapes:');
  printNote('1. Arrêtez le MCP Jupyter s\'il est en cours d\'exécution (Ctrl+C dans le terminal).');
  printNote('2. Assurez-vous que le mode hors ligne est activé dans la configuration.');
  printNote('3. Démarrez le MCP Jupyter avec la commande suivante:');
  printCommand('scripts\\mcp-starters\\start-jupyter-mcp.bat');
  printNote('4. Vérifiez qu\'aucune fenêtre de terminal supplémentaire n\'est ouverte.');
  printNote('5. Vérifiez qu\'aucune tentative de connexion n\'est effectuée au démarrage.');
  
  printNote('Appuyez sur Entrée pour continuer...');
  
  // Attendre que l'utilisateur appuie sur Entrée
  await new Promise(resolve => {
    process.stdin.once('data', () => {
      resolve();
    });
  });
  
  // Tableau récapitulatif
  printTitle('Tableau récapitulatif des fonctionnalités testées');
  
  console.log('| Fonctionnalité | Mode hors ligne | Mode connecté |');
  console.log('|----------------|-----------------|---------------|');
  console.log('| Démarrage du serveur | ✓ | ✓ |');
  console.log('| `get_offline_status` | ✓ | ✓ |');
  console.log('| `set_offline_mode` | ✓ | ✓ |');
  console.log('| `list_kernels` | ✗ | ✓ |');
  console.log('| `start_kernel` | ✗ | ✓ |');
  console.log('| `restart_kernel` | ✗ | ✓ |');
  console.log('| `stop_kernel` | ✗ | ✓ |');
  console.log('| `create_notebook` | ✓ | ✓ |');
  console.log('| `read_notebook` | ✓ | ✓ |');
  console.log('| `write_notebook` | ✓ | ✓ |');
  console.log('| `add_cell` | ✓ | ✓ |');
  console.log('| `execute_cell` | ✗ | ✓ |');
  console.log('| `execute_notebook` | ✗ | ✓ |');
  console.log('| Changement de mode | ✓ | ✓ |');
  
  printNote('Veuillez remplir ce tableau avec les résultats de vos tests.');
  printNote('Pour chaque fonctionnalité, indiquez si elle fonctionne (✓), ne fonctionne pas (✗) ou fonctionne partiellement (?).');
  
  // Conclusion
  printTitle('Conclusion');
  
  printNote('Vous avez terminé les tests du MCP Jupyter avec Roo.');
  printNote('Veuillez documenter les résultats de vos tests dans un rapport de validation.');
  printNote('Vous pouvez créer un fichier docs/jupyter-mcp-validation-report.md pour cela.');
  
  printExample('Format recommandé pour le rapport', `# Rapport de validation du MCP Jupyter avec Roo

## Environnement de test
- Date : [date]
- Version de Roo : [version]
- Version de Jupyter : [version]
- Système d'exploitation : [OS]

## Résultats des tests

### 1. Tests en mode connecté
- [Résultats]

### 2. Tests en mode hors ligne
- [Résultats]

### 3. Tests de changement de configuration
- [Résultats]

## Problèmes rencontrés
- [Liste des problèmes]

## Conclusion
- [Conclusion générale]`);
}

// Exécuter la fonction principale
main().catch(error => {
  console.error('Erreur non gérée:', error);
  process.exit(1);
});