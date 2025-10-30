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

export default {
  // Utiliser ts-jest pour les fichiers TypeScript avec support ESM
  preset: 'ts-jest/presets/default-esm',
  
  // Environnement Node.js
  testEnvironment: 'node',
  
  // Support des modules ES
  extensionsToTreatAsEsm: ['.ts'],
  
  // Mapping des modules pour résoudre les imports .js vers .ts
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  
  // Configuration de transformation
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
    }],
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
    '/build/',
    '/dist/',
    '/legacy-tests/',
    '/test-temp/'
  ],
  
  // Configuration de la couverture de code
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/types.ts'
  ],
  
  // Seuils de couverture minimum
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80
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
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
  
  // Fichiers de configuration globaux pour Jest
  globalSetup: '<rootDir>/__tests__/global-setup.js',
  globalTeardown: '<rootDir>/__tests__/global-teardown.js',
  
  // Rapports de test étendus
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: './test-results',
      outputName: 'junit.xml',
      classNameTemplate: '{classname}',
      titleTemplate: '{title}',
      ancestorSeparator: ' › ',
      usePathForSuiteName: true
    }],
    // Rapport de couverture en HTML détaillé
    ['html', {
      outputPath: './coverage/html',
      filename: 'coverage-report.html'
    }],
    // Rapport JSON pour l'intégration CI/CD
    ['json', {
      outputDirectory: './test-results',
      filename: 'test-results.json'
    }]
  ],
  
  // Configuration maximale pour la détection des problèmes
  maxWorkers: '50%',
  maxConcurrency: 5,
  
  // Options de cache pour les performances
  cache: true,
  cacheDirectory: '<rootDir>/.jest-cache',
  
  // Transformation des modules pour éviter les problèmes ESM
  transformIgnorePatterns: [
    'node_modules/(?!(quickfiles-server)/'
  ],
};