/**
 * Configuration Jest Complète pour QuickFiles MCP Server
 *
 * Cette configuration active l'exécution automatique des tests unitaires,
 * incluant les tests anti-régression critiques et la validation continue.
 *
 * @version 2.0.0
 * @author Roo Code Assistant
 * @date 2025-10-30
 */

module.exports = {
  // Configuration CommonJS pour les fichiers TypeScript et JavaScript
  preset: 'ts-jest',
  
  // Environnement Node.js
  testEnvironment: 'node',
  
  // Pas de traitement spécial ESM - utiliser CommonJS partout
  // extensionsToTreatAsEsm: ['.ts'],
  
  // Mapping des modules pour les imports sans extension
  moduleNameMapper: {
    '^../../build/(.*)$': '<rootDir>/build/$1.js',
  },
  
  // Configuration de transformation - TypeScript uniquement
  transform: {
    '^.+\\.(ts|tsx?)$': 'ts-jest',
  },
  
  // Patterns de fichiers de test
  testMatch: [
    '**/__tests__/**/*.test.js',
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).[jt]s?(x)'
  ],
  
  // Fichiers à exclure
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/legacy-tests/',
    '/test-temp/'
  ],
  
  // Configuration de la couverture de code
  collectCoverageFrom: [
    'build/**/*.js',
    '!build/**/*.d.ts',
    '!build/**/*.test.js',
    '!build/index.js'
  ],
  
  // Seuils de couverture minimum - ajustés pour CI
  coverageThreshold: {
    global: {
      branches: 55,
      functions: 70,
      lines: 70,
      statements: 70
    }
  },
  
  // Répertoire de sortie pour la couverture
  coverageDirectory: 'coverage',
  
  // Formats de rapport de couverture
  coverageReporters: [
    'text',
    'text-summary',
    'html',
    'lcov'
  ],
  
  // Timeout pour les tests (10 secondes)
  testTimeout: 10000,
  
  // Afficher les tests individuels
  verbose: true,
  
  // Configuration des globals pour ts-jest
  globals: {
    'ts-jest': {
      useESM: true,
    }
  },
  
  // Setup files à exécuter avant les tests
  setupFilesAfterEnv: ['<rootDir>/__tests__/global-setup.js'],
  
  // Fichiers de configuration globaux pour Jest
  globalSetup: '<rootDir>/__tests__/global-setup.js',
  globalTeardown: '<rootDir>/__tests__/global-teardown.js',
  
  // Rapports de test étendus
  reporters: [
    'default'
  ],
  
  // Configuration maximale pour la détection des problèmes
  maxWorkers: '50%',
  maxConcurrency: 5,
  
  // Options de cache pour les performances
  cache: true,
  cacheDirectory: '<rootDir>/.jest-cache',
  
  // Transformation des modules pour éviter les problèmes ESM
  transformIgnorePatterns: [
    'node_modules/(?!(quickfiles-server))/'
  ],
};