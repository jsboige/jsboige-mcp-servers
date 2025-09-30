/**
 * Configuration Jest pour QuickFiles MCP Server
 * 
 * Cette configuration active l'exécution automatique des tests unitaires,
 * incluant les tests anti-régression critiques.
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
  // setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
  
  // Rapports de test
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: './test-results',
      outputName: 'junit.xml',
      classNameTemplate: '{classname}',
      titleTemplate: '{title}',
      ancestorSeparator: ' › ',
      usePathForSuiteName: true
    }]
  ]
};