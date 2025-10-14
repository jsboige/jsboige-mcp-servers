#!/usr/bin/env node

/**
 * Script pour installer tous les serveurs MCP
 * Ce script parcourt tous les répertoires de serveurs et exécute `npm install` dans chacun
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const chalk = require('chalk');

// Répertoire racine des serveurs
const serversRoot = path.join(__dirname, '..', 'servers');

// Catégories de serveurs
const categories = ['api-connectors', 'dev-tools', 'system-utils'];

console.log(chalk.blue('🚀 Installation de tous les serveurs MCP...'));

// Parcourir chaque catégorie
categories.forEach(category => {
  const categoryPath = path.join(serversRoot, category);
  
  if (!fs.existsSync(categoryPath)) {
    console.log(chalk.yellow(`⚠️ Catégorie ${category} non trouvée, création...`));
    fs.mkdirSync(categoryPath, { recursive: true });
    return;
  }
  
  // Lire tous les serveurs dans cette catégorie
  const servers = fs.readdirSync(categoryPath, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
  
  if (servers.length === 0) {
    console.log(chalk.yellow(`ℹ️ Aucun serveur trouvé dans la catégorie ${category}`));
    return;
  }
  
  console.log(chalk.green(`📁 Installation des serveurs dans la catégorie ${category}...`));
  
  // Installer chaque serveur
  servers.forEach(server => {
    const serverPath = path.join(categoryPath, server);
    const packageJsonPath = path.join(serverPath, 'package.json');
    
    if (!fs.existsSync(packageJsonPath)) {
      console.log(chalk.yellow(`⚠️ Pas de package.json trouvé pour ${server}, ignoré.`));
      return;
    }
    
    console.log(chalk.cyan(`📦 Installation de ${server}...`));
    
    try {
      execSync('npm install', { cwd: serverPath, stdio: 'inherit' });
      console.log(chalk.green(`✅ ${server} installé avec succès!`));
    } catch (error) {
      console.error(chalk.red(`❌ Erreur lors de l'installation de ${server}:`), error.message);
    }
  });
});

console.log(chalk.blue('🎉 Installation terminée!'));