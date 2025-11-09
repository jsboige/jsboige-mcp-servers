/**
 * GLOBAL SETUP JEST POUR QUICKFILES MCP SERVER
 * 
 * Ce fichier est exécuté une fois avant tous les tests
 * Il configure l'environnement de test global
 */

// Configuration globale pour les tests
global.testConfig = {
  mockFileSystem: false, // Désactiver le mock filesystem pour éviter les conflits
  testTimeout: 10000,
  verboseLogging: false
};

// Setup global pour tous les tests
module.exports = async () => {
  // Configuration des variables d'environnement pour les tests
  process.env.NODE_ENV = 'test';
  process.env.MCP_TEST_MODE = 'true';
  process.env.QUIET_MODE = 'true';
  
  console.log('🔧 Global Jest Setup completed');
};

// Nettoyage après tous les tests
module.exports.teardown = async () => {
  // Nettoyer les variables d'environnement
  delete process.env.NODE_ENV;
  delete process.env.MCP_TEST_MODE;
  delete process.env.QUIET_MODE;
  
  console.log('🧹 Global Jest Teardown completed');
};

// Export pour utilisation dans les tests
module.exports.getTestConfig = () => global.testConfig;
module.exports.setTestConfig = (config) => { global.testConfig = { ...global.testConfig, ...config }; };