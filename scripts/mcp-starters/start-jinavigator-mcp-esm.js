/**
 * Script de démarrage pour le serveur MCP JinaNavigator (version ESM)
 * Ce script démarre le serveur JinaNavigator MCP
 * Compatible avec Windows, macOS et Linux
 */

import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Obtenir le chemin du répertoire actuel en ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const config = {
  mcpServerPath: path.join(__dirname, 'servers', 'jinavigator-server'),
  mcpServerCommand: 'node',
  mcpServerArgs: ['dist/index.js']
};

// Fonction pour vérifier si une commande est disponible
function commandExists(command) {
  try {
    const isWindows = process.platform === 'win32';
    const checkCommand = isWindows ? 'where' : 'which';
    execSync(`${checkCommand} ${command}`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// Fonction pour démarrer un processus
function startProcess(command, args, name, options = {}) {
  console.log(`Démarrage de ${name}...`);
  
  const proc = spawn(command, args, {
    ...options,
    stdio: 'pipe',
    shell: true
  });
  
  proc.stdout.on('data', (data) => {
    console.log(`[${name}] ${data.toString().trim()}`);
  });
  
  proc.stderr.on('data', (data) => {
    console.error(`[${name}] ${data.toString().trim()}`);
  });
  
  proc.on('close', (code) => {
    if (code !== 0) {
      console.error(`${name} s'est arrêté avec le code ${code}`);
    } else {
      console.log(`${name} s'est arrêté normalement`);
    }
  });
  
  return proc;
}

// Fonction principale
async function main() {
  console.log('===== Démarrage du serveur MCP JinaNavigator =====');
  
  // Vérifier si le serveur MCP JinaNavigator est compilé
  const mcpServerJsPath = path.join(config.mcpServerPath, 'dist', 'index.js');
  if (!fs.existsSync(mcpServerJsPath)) {
    console.log('Compilation du serveur MCP JinaNavigator...');
    try {
      execSync('npm run build', {
        cwd: config.mcpServerPath,
        stdio: 'inherit'
      });
    } catch (e) {
      console.error('Échec de la compilation du serveur MCP JinaNavigator.');
      process.exit(1);
    }
  }
  
  // Démarrer le serveur MCP JinaNavigator
  const mcpProcess = startProcess(
    config.mcpServerCommand,
    config.mcpServerArgs,
    'MCP JinaNavigator Server',
    { cwd: config.mcpServerPath }
  );
  
  console.log('===== Le serveur a été démarré avec succès =====');
  console.log('Le serveur MCP JinaNavigator est maintenant disponible pour Roo');
  
  // Gérer l'arrêt propre des processus
  process.on('SIGINT', () => {
    console.log('Arrêt du serveur...');
    mcpProcess.kill();
    process.exit(0);
  });
}

// Exécuter la fonction principale
main().catch(err => {
  console.error('Erreur lors du démarrage du serveur:', err);
  process.exit(1);
});