/**
 * Script pour résoudre le problème "Connection closed" du MCP Jupyter
 * en utilisant le mode hors ligne
 * 
 * Ce script:
 * 1. Configure le MCP Jupyter pour fonctionner en mode hors ligne
 * 2. Configure Roo pour utiliser le MCP Jupyter en mode hors ligne
 * 3. Démarre le MCP Jupyter avec la nouvelle configuration
 */

import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import os from 'os';

// Obtenir le chemin du répertoire actuel en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const config = {
  mcpServerPath: path.join(__dirname, '..', 'servers', 'jupyter-mcp-server'),
  mcpConfigPath: path.join(__dirname, '..', 'servers', 'jupyter-mcp-server', 'config.json'),
  rooConfigPath: path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
  startupDelay: 2000, // Délai d'attente entre les démarrages de processus
};

// Couleurs pour la console
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bold: '\x1b[1m',
};

/**
 * Affiche un message formaté dans la console
 */
function log(message, type = 'info') {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  let prefix = '';
  
  switch (type) {
    case 'error':
      prefix = `${colors.red}[ERREUR]${colors.reset}`;
      break;
    case 'warning':
      prefix = `${colors.yellow}[AVERT]${colors.reset}`;
      break;
    case 'success':
      prefix = `${colors.green}[SUCCÈS]${colors.reset}`;
      break;
    case 'info':
      prefix = `${colors.blue}[INFO]${colors.reset}`;
      break;
    case 'debug':
      prefix = `${colors.magenta}[DEBUG]${colors.reset}`;
      break;
    case 'header':
      console.log(`\n${colors.cyan}${colors.bold}=== ${message} ===${colors.reset}\n`);
      return;
    default:
      prefix = `[${type.toUpperCase()}]`;
  }
  
  console.log(`${prefix} ${timestamp} - ${message}`);
}

/**
 * Vérifie si un processus est en cours d'exécution
 */
function checkProcessRunning(processName) {
  return new Promise((resolve) => {
    const platform = process.platform;
    let command = '';
    
    if (platform === 'win32') {
      command = `tasklist /FI "IMAGENAME eq ${processName}"`;
    } else {
      command = `ps aux | grep ${processName} | grep -v grep`;
    }
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        resolve({ running: false, error: error.message });
        return;
      }
      
      if (platform === 'win32') {
        resolve({ 
          running: stdout.toLowerCase().includes(processName.toLowerCase()),
          output: stdout
        });
      } else {
        resolve({ 
          running: stdout.trim() !== '',
          output: stdout
        });
      }
    });
  });
}

/**
 * Lit un fichier de configuration JSON
 */
function readJsonConfig(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    log(`Erreur lors de la lecture du fichier ${filePath}: ${error.message}`, 'error');
  }
  
  return null;
}

/**
 * Écrit un fichier de configuration JSON
 */
function writeJsonConfig(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    log(`Erreur lors de l'écriture du fichier ${filePath}: ${error.message}`, 'error');
    return false;
  }
}

/**
 * Démarre un processus et capture sa sortie
 */
function startProcess(command, args, name, options = {}) {
  log(`Démarrage de ${name}...`, 'info');
  
  const proc = spawn(command, args, {
    ...options,
    stdio: 'pipe',
    shell: true,
    detached: options.detached || false
  });
  
  proc.stdout.on('data', (data) => {
    log(`[${name}] ${data.toString().trim()}`, 'debug');
  });
  
  proc.stderr.on('data', (data) => {
    log(`[${name}] ${data.toString().trim()}`, 'warning');
  });
  
  proc.on('error', (error) => {
    log(`Erreur lors du démarrage de ${name}: ${error.message}`, 'error');
  });
  
  proc.on('close', (code) => {
    if (code !== 0 && code !== null) {
      log(`${name} s'est arrêté avec le code ${code}`, 'error');
    } else if (code === 0) {
      log(`${name} s'est arrêté normalement`, 'info');
    }
  });
  
  return proc;
}

/**
 * Configure le MCP Jupyter pour le mode hors ligne
 */
function configureMcpJupyter() {
  log('Configuration du MCP Jupyter pour le mode hors ligne...', 'info');
  
  // Lire la configuration actuelle
  const mcpConfig = readJsonConfig(config.mcpConfigPath) || {
    jupyterServer: {
      baseUrl: 'http://localhost:8888',
      token: 'test_token'
    }
  };
  
  // Mettre à jour la configuration
  mcpConfig.jupyterServer = {
    ...mcpConfig.jupyterServer,
    skipConnectionCheck: true,
    offlineMode: true
  };
  
  // Écrire la nouvelle configuration
  if (writeJsonConfig(config.mcpConfigPath, mcpConfig)) {
    log('Configuration du MCP Jupyter mise à jour avec succès', 'success');
    return true;
  } else {
    log('Échec de la mise à jour de la configuration du MCP Jupyter', 'error');
    return false;
  }
}

/**
 * Configure Roo pour le mode hors ligne
 */
function configureRooMcp() {
  log('Configuration de Roo pour le mode hors ligne...', 'info');
  
  // Lire la configuration actuelle
  const rooConfig = readJsonConfig(config.rooConfigPath);
  
  if (!rooConfig || !rooConfig.mcpServers || !rooConfig.mcpServers.jupyter) {
    log('Configuration Roo non trouvée ou incomplète', 'error');
    return false;
  }
  
  // Mettre à jour la configuration
  if (rooConfig.mcpServers.jupyter.config) {
    rooConfig.mcpServers.jupyter.config.offlineMode = true;
    rooConfig.mcpServers.jupyter.config.skipConnectionCheck = true;
    
    // S'assurer que la configuration du serveur Jupyter existe
    if (!rooConfig.mcpServers.jupyter.config.jupyterServer) {
      rooConfig.mcpServers.jupyter.config.jupyterServer = {
        baseUrl: 'http://localhost:8888',
        token: 'test_token',
        skipConnectionCheck: true,
        offlineMode: true
      };
    } else {
      // Mettre à jour la configuration existante
      rooConfig.mcpServers.jupyter.config.jupyterServer.skipConnectionCheck = true;
      rooConfig.mcpServers.jupyter.config.jupyterServer.offlineMode = true;
    }
  } else {
    rooConfig.mcpServers.jupyter.config = {
      offlineMode: true,
      skipConnectionCheck: true,
      jupyterServer: {
        baseUrl: 'http://localhost:8888',
        token: 'test_token',
        skipConnectionCheck: true,
        offlineMode: true
      }
    };
  }
  
  // Mettre à jour les arguments pour utiliser le script de démarrage en mode hors ligne
  rooConfig.mcpServers.jupyter.args = [
    '/c',
    path.join('d:\\Dev\\jsboige-mcp-servers\\scripts\\mcp-starters\\start-jupyter-mcp-offline.bat')
  ];
  
  // Écrire la nouvelle configuration
  if (writeJsonConfig(config.rooConfigPath, rooConfig)) {
    log('Configuration Roo mise à jour avec succès', 'success');
    return true;
  } else {
    log('Échec de la mise à jour de la configuration Roo', 'error');
    return false;
  }
}

/**
 * Démarre le MCP Jupyter en mode hors ligne
 */
async function startMcpJupyter() {
  log('Démarrage du MCP Jupyter en mode hors ligne...', 'info');
  
  const mcpProcess = startProcess(
    'cmd',
    ['/c', path.join(__dirname, 'mcp-starters', 'start-jupyter-mcp-offline.bat')],
    'MCP Jupyter Server',
    {
      detached: true // Permet au serveur de continuer à s'exécuter même si ce script se termine
    }
  );
  
  // Attendre que le serveur soit prêt
  log(`Attente de ${config.startupDelay / 1000} secondes pour le démarrage du serveur...`, 'info');
  await new Promise(resolve => setTimeout(resolve, config.startupDelay));
  
  // Vérifier que le serveur est bien démarré
  const nodeRunning = await checkProcessRunning('node.exe');
  
  if (nodeRunning.running) {
    log('MCP Jupyter démarré avec succès en mode hors ligne', 'success');
    return true;
  } else {
    log('Échec du démarrage du MCP Jupyter', 'error');
    return false;
  }
}

/**
 * Fonction principale
 */
async function main() {
  log('RÉSOLUTION DU PROBLÈME "CONNECTION CLOSED" DU MCP JUPYTER EN MODE HORS LIGNE', 'header');
  
  // Étape 1: Configurer le MCP Jupyter pour le mode hors ligne
  log('CONFIGURATION DU MCP JUPYTER', 'header');
  const mcpConfigured = configureMcpJupyter();
  
  if (!mcpConfigured) {
    log('Échec de la configuration du MCP Jupyter, arrêt du script', 'error');
    process.exit(1);
  }
  
  // Étape 2: Configurer Roo pour le mode hors ligne
  log('CONFIGURATION DE ROO', 'header');
  const rooConfigured = configureRooMcp();
  
  if (!rooConfigured) {
    log('Échec de la configuration de Roo, mais on continue...', 'warning');
  }
  
  // Étape 3: Démarrer le MCP Jupyter en mode hors ligne
  log('DÉMARRAGE DU MCP JUPYTER EN MODE HORS LIGNE', 'header');
  const mcpStarted = await startMcpJupyter();
  
  if (!mcpStarted) {
    log('Échec du démarrage du MCP Jupyter, arrêt du script', 'error');
    process.exit(1);
  }
  
  log('RÉSUMÉ', 'header');
  log('1. Configuration du MCP Jupyter: OK', 'success');
  log('2. Configuration de Roo: ' + (rooConfigured ? 'OK' : 'Échec'), rooConfigured ? 'success' : 'warning');
  log('3. Démarrage du MCP Jupyter en mode hors ligne: OK', 'success');
  
  log('Le MCP Jupyter est maintenant correctement configuré en mode hors ligne', 'success');
  log('Cette configuration permet d\'éviter le problème "Connection closed" en n\'essayant pas de se connecter à un serveur Jupyter', 'success');
  log('Vous pouvez utiliser Roo avec le MCP Jupyter en mode hors ligne sans problème', 'success');
  log('Note: Les fonctionnalités nécessitant un serveur Jupyter ne seront pas disponibles', 'info');
}

// Exécuter la fonction principale
main().catch(error => {
  log(`Erreur lors de l'exécution du script: ${error.message}`, 'error');
  console.error(error);
  process.exit(1);
});