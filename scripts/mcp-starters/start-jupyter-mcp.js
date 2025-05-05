/**
 * Script de démarrage pour les serveurs Jupyter et MCP Jupyter
 * Ce script démarre à la fois le serveur Jupyter Notebook et le serveur MCP Jupyter
 * Compatible avec Windows, macOS et Linux
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configuration
const config = {
  jupyterCommand: 'jupyter',
  jupyterArgs: ['notebook', '--no-browser'],
  mcpServerPath: path.join(__dirname, 'servers', 'jupyter-mcp-server'),
  mcpServerCommand: 'node',
  mcpServerArgs: ['dist/index.js'],
  startupDelay: 5000 // Délai en ms pour attendre que Jupyter démarre
};

// Fonction pour vérifier si une commande est disponible
function commandExists(command) {
  try {
    const isWindows = process.platform === 'win32';
    const checkCommand = isWindows ? 'where' : 'which';
    require('child_process').execSync(`${checkCommand} ${command}`, { stdio: 'ignore' });
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
  console.log('===== Démarrage des serveurs Jupyter et MCP Jupyter =====');
  
  // Vérifier si Jupyter est installé
  if (!commandExists(config.jupyterCommand)) {
    console.error(`${config.jupyterCommand} n'est pas installé ou n'est pas dans le PATH.`);
    console.error('Veuillez installer Jupyter avec: pip install jupyter');
    process.exit(1);
  }
  
  // Vérifier si le serveur MCP Jupyter est compilé
  const mcpServerJsPath = path.join(config.mcpServerPath, 'dist', 'index.js');
  if (!fs.existsSync(mcpServerJsPath)) {
    console.log('Compilation du serveur MCP Jupyter...');
    try {
      require('child_process').execSync('npm run build', {
        cwd: config.mcpServerPath,
        stdio: 'inherit'
      });
    } catch (e) {
      console.error('Échec de la compilation du serveur MCP Jupyter.');
      process.exit(1);
    }
  }
  
  // Démarrer Jupyter Notebook
  const jupyterProcess = startProcess(
    config.jupyterCommand,
    config.jupyterArgs,
    'Jupyter Notebook'
  );
  
  // Attendre que Jupyter Notebook soit prêt
  console.log(`Attente du démarrage de Jupyter Notebook (${config.startupDelay / 1000} secondes)...`);
  await new Promise(resolve => setTimeout(resolve, config.startupDelay));
  
  // Démarrer le serveur MCP Jupyter
  const mcpProcess = startProcess(
    config.mcpServerCommand,
    config.mcpServerArgs,
    'MCP Jupyter Server',
    { cwd: config.mcpServerPath }
  );
  
  console.log('===== Les deux serveurs ont été démarrés avec succès =====');
  console.log('Jupyter Notebook est accessible à l\'adresse: http://localhost:8888');
  console.log('Le serveur MCP Jupyter est maintenant disponible pour Roo');
  
  // Gérer l'arrêt propre des processus
  process.on('SIGINT', () => {
    console.log('Arrêt des serveurs...');
    jupyterProcess.kill();
    mcpProcess.kill();
    process.exit(0);
  });
}

// Exécuter la fonction principale
main().catch(err => {
  console.error('Erreur lors du démarrage des serveurs:', err);
  process.exit(1);
});