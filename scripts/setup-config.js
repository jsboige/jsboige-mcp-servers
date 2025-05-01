#!/usr/bin/env node

/**
 * Script pour configurer les serveurs MCP
 * Ce script copie les fichiers de configuration d'exemple et aide à les personnaliser
 */

const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer');
const chalk = require('chalk');

// Répertoire racine des serveurs
const serversRoot = path.join(__dirname, '..', 'servers');
const configDir = path.join(__dirname, '..', 'config');

// Catégories de serveurs
const categories = ['api-connectors', 'dev-tools', 'system-utils'];

console.log(chalk.blue('🔧 Configuration des serveurs MCP...'));

// Vérifier si le répertoire de configuration existe
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// Fonction pour configurer un serveur
async function configureServer(serverPath, serverName) {
  const configExamplePath = path.join(serverPath, 'config.example.json');
  const configDestPath = path.join(serverPath, 'config.json');
  
  // Vérifier si le fichier de configuration d'exemple existe
  if (!fs.existsSync(configExamplePath)) {
    console.log(chalk.yellow(`⚠️ Pas de fichier config.example.json trouvé pour ${serverName}, ignoré.`));
    return;
  }
  
  // Si la configuration existe déjà, demander si on veut la remplacer
  if (fs.existsSync(configDestPath)) {
    const { overwrite } = await inquirer.prompt([{
      type: 'confirm',
      name: 'overwrite',
      message: `La configuration pour ${serverName} existe déjà. Voulez-vous la reconfigurer?`,
      default: false
    }]);
    
    if (!overwrite) {
      console.log(chalk.cyan(`ℹ️ Configuration de ${serverName} conservée.`));
      return;
    }
  }
  
  // Lire le fichier de configuration d'exemple
  const configExample = JSON.parse(fs.readFileSync(configExamplePath, 'utf8'));
  let config = { ...configExample };
  
  // Pour chaque clé dans la configuration, demander une valeur
  const questions = Object.keys(configExample).map(key => ({
    type: typeof configExample[key] === 'boolean' ? 'confirm' : 'input',
    name: key,
    message: `Entrez la valeur pour ${key}:`,
    default: configExample[key]
  }));
  
  if (questions.length > 0) {
    const answers = await inquirer.prompt(questions);
    config = { ...config, ...answers };
  }
  
  // Écrire la configuration
  fs.writeFileSync(configDestPath, JSON.stringify(config, null, 2), 'utf8');
  
  // Copier également la configuration dans le répertoire global de configuration
  const globalConfigPath = path.join(configDir, `${serverName}.json`);
  fs.writeFileSync(globalConfigPath, JSON.stringify(config, null, 2), 'utf8');
  
  console.log(chalk.green(`✅ Configuration de ${serverName} terminée!`));
}

// Fonction principale
async function main() {
  // Parcourir chaque catégorie
  for (const category of categories) {
    const categoryPath = path.join(serversRoot, category);
    
    if (!fs.existsSync(categoryPath)) {
      console.log(chalk.yellow(`⚠️ Catégorie ${category} non trouvée, ignorée.`));
      continue;
    }
    
    // Lire tous les serveurs dans cette catégorie
    const servers = fs.readdirSync(categoryPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    if (servers.length === 0) {
      console.log(chalk.yellow(`ℹ️ Aucun serveur trouvé dans la catégorie ${category}`));
      continue;
    }
    
    console.log(chalk.green(`📁 Configuration des serveurs dans la catégorie ${category}...`));
    
    // Configurer chaque serveur
    for (const server of servers) {
      const serverPath = path.join(categoryPath, server);
      console.log(chalk.cyan(`⚙️ Configuration de ${server}...`));
      await configureServer(serverPath, server);
    }
  }
  
  console.log(chalk.blue('🎉 Configuration terminée!'));
  
  // Créer un fichier de configuration global d'exemple
  const globalExampleConfig = {
    "global": {
      "logLevel": "info",
      "port": 3000,
      "enableSecurity": true
    },
    "servers": {
      "enabled": ["server1", "server2"],
      "disabled": []
    }
  };
  
  fs.writeFileSync(
    path.join(configDir, 'mcp_settings_example.json'),
    JSON.stringify(globalExampleConfig, null, 2),
    'utf8'
  );
  
  console.log(chalk.green('✅ Fichier de configuration global d\'exemple créé!'));
}

main().catch(error => {
  console.error(chalk.red('❌ Erreur lors de la configuration:'), error);
  process.exit(1);
});