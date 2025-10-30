/**
 * GLOBAL TEARDOWN JEST POUR QUICKFILES MCP SERVER
 * 
 * Ce fichier est exécuté une fois après tous les tests
 * Il nettoie l'environnement de test global
 */

const mockFs = require('mock-fs');

// Nettoyage global après tous les tests
afterAll(() => {
  // S'assurer que le mock filesystem est restauré
  if (mockFs.restore) {
    try {
      mockFs.restore();
      console.log('🧹 Mock filesystem restored');
    } catch (error) {
      console.error('❌ Error restoring mock filesystem:', error.message);
    }
  }
  
  // Nettoyer les ressources temporaires
  const tempDirs = [
    'C:/temp/test',
    'C:/temp/destination',
    'C:/temp/mcp-test'
  ];
  
  tempDirs.forEach(dir => {
    try {
      const fs = require('fs');
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`🗑️  Cleaned temp directory: ${dir}`);
      }
    } catch (error) {
      console.error(`❌ Error cleaning ${dir}:`, error.message);
    }
  });
  
  // Réinitialiser la configuration de test
  if (global.testConfig) {
    delete global.testConfig;
  }
  
  // Nettoyer les variables d'environnement de test
  const testEnvVars = [
    'NODE_ENV',
    'MCP_TEST_MODE', 
    'QUIET_MODE',
    'JEST_WORKER_ID',
    'JEST_WORKER_TYPE'
  ];
  
  testEnvVars.forEach(varName => {
    if (process.env[varName]) {
      delete process.env[varName];
    }
  });
  
  console.log('🧹 Global Jest Teardown completed');
  console.log('📊 Test environment cleaned up');
});

// Export pour utilisation dans les tests
module.exports = {
  cleanupTempFiles: () => {
    const tempDirs = ['C:/temp/test', 'C:/temp/destination'];
    const fs = require('fs');
    
    tempDirs.forEach(dir => {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
};