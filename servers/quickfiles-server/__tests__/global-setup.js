/**
 * GLOBAL SETUP JEST POUR QUICKFILES MCP SERVER
 * 
 * Ce fichier est exécuté une fois avant tous les tests
 * Il configure l'environnement de test global
 */

const mockFs = require('mock-fs');
const path = require('path');

// Configuration globale pour les tests
global.testConfig = {
  mockFileSystem: true,
  testTimeout: 10000,
  verboseLogging: false
};

// Mock du filesystem pour tous les tests
beforeAll(() => {
  // Créer un système de fichiers de test par défaut
  mockFs({
    'C:/temp/test': {
      'test-file.txt': 'Contenu de test initial',
      'test-file-2.txt': 'Autre contenu de test',
      'subdir': {
        'nested-file.txt': 'Fichier imbriqué pour tests'
      }
    },
    'C:/temp/destination': {
      'existing.txt': 'Fichier existant pour tests de copie/déplacement'
    }
  });
  
  // Configuration des variables d'environnement pour les tests
  process.env.NODE_ENV = 'test';
  process.env.MCP_TEST_MODE = 'true';
  process.env.QUIET_MODE = 'true';
  
  console.log('🔧 Global Jest Setup completed');
});

// Nettoyage après tous les tests
afterAll(() => {
  // Restaurer le filesystem réel
  if (mockFs.restore) {
    mockFs.restore();
  }
  
  // Nettoyer les variables d'environnement
  delete process.env.NODE_ENV;
  delete process.env.MCP_TEST_MODE;
  delete process.env.QUIET_MODE;
  
  console.log('🧹 Global Jest Teardown completed');
});

// Export pour utilisation dans les tests
module.exports = {
  getTestConfig: () => global.testConfig,
  setTestConfig: (config) => { global.testConfig = { ...global.testConfig, ...config }; }
};