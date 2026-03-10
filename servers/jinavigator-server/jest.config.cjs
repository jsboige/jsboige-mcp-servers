/**
 * Configuration Jest pour les tests du serveur JinaNavigator MCP
 * 
 * Configuration optimisée pour atteindre 95-100% de couverture avec
 * une architecture modulaire de tests organisés par catégorie.
 */

module.exports = {
  // Environnement de test Node.js
  testEnvironment: 'node',
  
  // Configuration de transformation pour les modules ES6 et TypeScript
  transform: {
    '^.+\\.(js|ts)$': ['babel-jest', {
      presets: [
        ['@babel/preset-env', {
          targets: {
            node: 'current'
          },
          modules: 'commonjs'
        }],
        '@babel/preset-typescript'
      ]
    }]
  },
  
  // Mapping des modules pour gérer les imports .js vers .ts
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  
  // Patterns pour trouver les fichiers de test par catégorie
  testMatch: [
    '**/__tests__/unit/**/*.test.(js|ts)',
    '**/__tests__/integration/**/*.test.(js|ts)',
    '**/__tests__/performance/**/*.test.(js|ts)',
    '**/__tests__/anti-regression/**/*.test.(js|ts)',
    '**/__tests__/**/*.test.(js|ts)' // Garder compatibilité avec tests existants
  ],
  
  // Fichiers à ignorer
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/'
  ],
  
  // Collecte de la couverture de code
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/index.ts',
    '!src/index-old.ts',
    '!src/server.ts',
    '!src/types/**/*.ts',
    '!src/**/index.ts'
  ],
  
  // Répertoire pour les rapports de couverture
  coverageDirectory: 'coverage',
  
  // Formats des rapports de couverture
  coverageReporters: [
    'text',
    'text-summary',
    'lcov',
    'html',
    'json',
    'json-summary'
  ],
  
  // Seuils de couverture - ajustés pour CI (branches 90%)
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 95,
      lines: 95,
      statements: 95
    },
    './src/tools/': {
      branches: 90,
      functions: 95,
      lines: 95,
      statements: 95
    },
    './src/utils/': {
      branches: 90,
      functions: 95,
      lines: 95,
      statements: 95
    }
  },
  
  // Afficher un résumé de la couverture après les tests
  verbose: true,
  
  // Setup pour les modules ES6
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  
  // Rapporteurs personnalisés
  reporters: [
    'default'
  ],
  
  // Configuration pour le cache
  cacheDirectory: '<rootDir>/.jest-cache',
  
  // Configuration pour la surveillance des fichiers
  watchPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/dist/',
    '<rootDir>/coverage/'
  ],
  
  // Configuration pour la collecte de métriques
  collectCoverage: false, // Par défaut, activer avec --coverage
  
  // Configuration pour l'exécution en parallèle
  maxWorkers: '50%',
  
  // Configuration pour la détection de fuites
  detectOpenHandles: false,
  forceExit: true
};