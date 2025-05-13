/**
 * Script pour résoudre le problème "Connection closed" du MCP Jupyter
 * 
 * Ce script:
 * 1. Démarre le serveur Jupyter s'il n'est pas déjà en cours d'exécution
 * 2. Configure le MCP Jupyter en mode connecté
 * 3. Démarre le MCP Jupyter avec la nouvelle configuration
 * 4. Teste la connexion pour vérifier que le problème est résolu
 */

import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';

// Obtenir le chemin du répertoire actuel en ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const config = {
  mcpServerPath: path.join(__dirname, '..', 'servers', 'jupyter-mcp-server'),
  mcpConfigPath: path.join(__dirname, '..', 'servers', 'jupyter-mcp-server', 'config.json'),
  rooConfigPath: path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
  jupyterDefaultUrl: 'http://localhost:8888',
  jupyterToken: 'test_token',
  connectionTimeout: 5000,
  requestTimeout: 5000,
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
 * Vérifie si le port est en écoute
 */
function checkPortListening(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    
    socket.setTimeout(1000);
    
    socket.on('connect', () => {
      socket.destroy();
      resolve({ listening: true });
    });
    
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ listening: false, reason: 'timeout' });
    });
    
    socket.on('error', (error) => {
      resolve({ listening: false, reason: error.code });
    });
    
    socket.connect(port, 'localhost');
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
 * Teste la connexion au serveur Jupyter
 */
async function testJupyterConnection(baseUrl, token) {
  try {
    log(`Test de connexion à ${baseUrl} avec token: ${token ? '✓' : '✗'}`, 'info');
    
    // Créer une URL pour l'API Jupyter
    const apiUrl = `${baseUrl}/api/kernels`;
    const url = token ? `${apiUrl}?token=${token}` : apiUrl;
    
    return new Promise((resolve) => {
      // Déterminer le module HTTP à utiliser (http ou https)
      const httpModule = baseUrl.startsWith('https') ? https : http;
      
      // Configurer les options de requête
      const options = {
        timeout: config.requestTimeout,
        headers: {}
      };
      
      // Ajouter le token dans l'en-tête si disponible
      if (token) {
        options.headers['Authorization'] = `token ${token}`;
      }
      
      const req = httpModule.get(url, options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode === 200) {
            log(`Connexion réussie au serveur Jupyter (${res.statusCode})`, 'success');
            
            let jsonData = null;
            try {
              jsonData = JSON.parse(data);
            } catch (e) {
              log(`Erreur lors de l'analyse de la réponse JSON: ${e.message}`, 'warning');
            }
            
            resolve({ 
              success: true, 
              status: res.statusCode,
              data: jsonData
            });
          } else {
            log(`Échec de la connexion au serveur Jupyter: Code ${res.statusCode}`, 'error');
            resolve({ 
              success: false, 
              status: res.statusCode,
              error: res.statusMessage,
              data
            });
          }
        });
      });
      
      req.on('error', (error) => {
        log(`Erreur lors du test de connexion: ${error.message}`, 'error');
        resolve({ 
          success: false, 
          error: error.message,
          code: error.code
        });
      });
      
      req.on('timeout', () => {
        req.destroy();
        log('Délai d\'attente dépassé lors de la tentative de connexion', 'error');
        resolve({ 
          success: false, 
          error: 'Timeout',
          code: 'ETIMEDOUT'
        });
      });
      
      req.end();
    });
  } catch (error) {
    log(`Erreur lors du test de connexion: ${error.message}`, 'error');
    
    return { 
      success: false, 
      error: error.message,
      code: error.code
    };
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
 * Configure le MCP Jupyter pour le mode connecté
 */
function configureMcpJupyter() {
  log('Configuration du MCP Jupyter pour le mode connecté...', 'info');
  
  // Lire la configuration actuelle
  const mcpConfig = readJsonConfig(config.mcpConfigPath) || {
    jupyterServer: {
      baseUrl: config.jupyterDefaultUrl,
      token: config.jupyterToken
    }
  };
  
  // Mettre à jour la configuration
  mcpConfig.jupyterServer = {
    ...mcpConfig.jupyterServer,
    baseUrl: config.jupyterDefaultUrl,
    token: config.jupyterToken,
    offline: false
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
 * Configure Roo pour le mode connecté
 */
function configureRooMcp() {
  log('Configuration de Roo pour le mode connecté...', 'info');
  
  // Lire la configuration actuelle
  const rooConfig = readJsonConfig(config.rooConfigPath);
  
  if (!rooConfig || !rooConfig.mcpServers || !rooConfig.mcpServers.jupyter) {
    log('Configuration Roo non trouvée ou incomplète', 'error');
    return false;
  }
  
  // Mettre à jour la configuration
  if (rooConfig.mcpServers.jupyter.config) {
    rooConfig.mcpServers.jupyter.config.offlineMode = false;
    
    if (rooConfig.mcpServers.jupyter.config.jupyterServer) {
      rooConfig.mcpServers.jupyter.config.jupyterServer.token = config.jupyterToken;
    }
  } else {
    rooConfig.mcpServers.jupyter.config = {
      offlineMode: false,
      jupyterServer: {
        baseUrl: config.jupyterDefaultUrl,
        token: config.jupyterToken
      }
    };
  }
  
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
 * Démarre le serveur Jupyter
 */
async function startJupyterServer() {
  log('Vérification du serveur Jupyter...', 'info');
  
  // Vérifier si le port 8888 est déjà en écoute
  const port8888 = await checkPortListening(8888);
  
  if (port8888.listening) {
    log('Le port 8888 est déjà en écoute, vérification de la connexion...', 'info');
    
    // Tester la connexion au serveur existant
    const connectionTest = await testJupyterConnection(config.jupyterDefaultUrl, '');
    
    if (connectionTest.success) {
      log('Un serveur Jupyter est déjà en cours d\'exécution et accessible', 'success');
      return true;
    } else {
      log('Le port 8888 est en écoute mais le serveur Jupyter n\'est pas accessible', 'warning');
      log('Tentative d\'arrêt du processus sur le port 8888...', 'info');
      
      // Tenter de libérer le port 8888 (Windows uniquement)
      if (process.platform === 'win32') {
        try {
          exec('for /f "tokens=5" %a in (\'netstat -aon ^| find ":8888" ^| find "LISTENING"\') do taskkill /f /pid %a', (error, stdout, stderr) => {
            if (error) {
              log(`Erreur lors de la libération du port 8888: ${error.message}`, 'error');
            } else {
              log('Port 8888 libéré avec succès', 'success');
            }
          });
          
          // Attendre un peu pour que le port soit libéré
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (e) {
          log(`Erreur lors de la tentative de libération du port 8888: ${e.message}`, 'error');
        }
      }
    }
  }
  
  // Démarrer le serveur Jupyter en utilisant le script existant
  log('Démarrage du serveur Jupyter en utilisant le script existant...', 'info');
  
  const jupyterProcess = startProcess(
    'cmd',
    ['/c', path.join(__dirname, 'mcp-starters', 'start-jupyter-server.bat')],
    'Jupyter Server',
    {
      detached: true // Permet au serveur de continuer à s'exécuter même si ce script se termine
    }
  );
  
  // Attendre que le serveur soit prêt
  log(`Attente de ${config.startupDelay / 1000} secondes pour le démarrage du serveur...`, 'info');
  await new Promise(resolve => setTimeout(resolve, config.startupDelay));
  
  // Vérifier que le serveur est bien démarré
  const jupyterRunning = await checkProcessRunning('jupyter');
  const port8888After = await checkPortListening(8888);
  
  if (jupyterRunning.running && port8888After.listening) {
    log('Serveur Jupyter démarré avec succès', 'success');
    return true;
  } else {
    log('Échec du démarrage du serveur Jupyter', 'error');
    return false;
  }
}

/**
 * Démarre le MCP Jupyter
 */
async function startMcpJupyter() {
  log('Démarrage du MCP Jupyter...', 'info');
  
  const mcpProcess = startProcess(
    'node',
    ['dist/index.js'],
    'MCP Jupyter Server',
    {
      cwd: config.mcpServerPath,
      detached: true // Permet au serveur de continuer à s'exécuter même si ce script se termine
    }
  );
  
  // Attendre que le serveur soit prêt
  log(`Attente de ${config.startupDelay / 1000} secondes pour le démarrage du serveur...`, 'info');
  await new Promise(resolve => setTimeout(resolve, config.startupDelay));
  
  // Vérifier que le serveur est bien démarré
  const nodeRunning = await checkProcessRunning('node.exe');
  
  if (nodeRunning.running) {
    log('MCP Jupyter démarré avec succès', 'success');
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
  log('RÉSOLUTION DU PROBLÈME "CONNECTION CLOSED" DU MCP JUPYTER', 'header');
  
  // Étape 1: Configurer le MCP Jupyter pour le mode connecté
  log('CONFIGURATION DU MCP JUPYTER', 'header');
  const mcpConfigured = configureMcpJupyter();
  
  if (!mcpConfigured) {
    log('Échec de la configuration du MCP Jupyter, arrêt du script', 'error');
    process.exit(1);
  }
  
  // Étape 2: Configurer Roo pour le mode connecté
  log('CONFIGURATION DE ROO', 'header');
  const rooConfigured = configureRooMcp();
  
  if (!rooConfigured) {
    log('Échec de la configuration de Roo, mais on continue...', 'warning');
  }
  
  // Étape 3: Démarrer le serveur Jupyter
  log('DÉMARRAGE DU SERVEUR JUPYTER', 'header');
  const jupyterStarted = await startJupyterServer();
  
  if (!jupyterStarted) {
    log('Échec du démarrage du serveur Jupyter, arrêt du script', 'error');
    process.exit(1);
  }
  
  // Étape 4: Démarrer le MCP Jupyter
  log('DÉMARRAGE DU MCP JUPYTER', 'header');
  const mcpStarted = await startMcpJupyter();
  
  if (!mcpStarted) {
    log('Échec du démarrage du MCP Jupyter, arrêt du script', 'error');
    process.exit(1);
  }
  
  // Étape 5: Tester la connexion
  log('TEST DE CONNEXION', 'header');
  const connectionTest = await testJupyterConnection(config.jupyterDefaultUrl, config.jupyterToken);
  
  if (connectionTest.success) {
    log('Connexion au serveur Jupyter réussie!', 'success');
    log('Le problème "Connection closed" a été résolu avec succès', 'success');
  } else {
    log('Échec de la connexion au serveur Jupyter', 'error');
    log('Le problème "Connection closed" n\'a pas été résolu', 'error');
    process.exit(1);
  }
  
  log('RÉSUMÉ', 'header');
  log('1. Configuration du MCP Jupyter: OK', 'success');
  log('2. Configuration de Roo: ' + (rooConfigured ? 'OK' : 'Échec'), rooConfigured ? 'success' : 'warning');
  log('3. Démarrage du serveur Jupyter: OK', 'success');
  log('4. Démarrage du MCP Jupyter: OK', 'success');
  log('5. Test de connexion: OK', 'success');
  
  log('Le MCP Jupyter est maintenant correctement configuré et connecté au serveur Jupyter', 'success');
  log('Vous pouvez utiliser Roo avec le MCP Jupyter sans problème de "Connection closed"', 'success');
}

// Exécuter la fonction principale
main().catch(error => {
  log(`Erreur lors de l'exécution du script: ${error.message}`, 'error');
  console.error(error);
  process.exit(1);
});