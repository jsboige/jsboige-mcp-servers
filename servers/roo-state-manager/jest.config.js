/**
 * Configuration Jest pour roo-state-manager
 * Adaptée pour être compatible avec Vitest
 */

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/tests/setup/jest.setup.js'],
  
  // Résolution des modules
  moduleNameMapping: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/tests/$1'
  },
  
  // Patterns de tests
  testMatch: [
    '<rootDir>/tests/unit/**/*.test.ts',
    '<rootDir>/tests/unit/**/*.test.js',
    '<rootDir>/tests/integration/**/*.test.ts',
    '<rootDir>/tests/integration/**/*.test.js',
    '<rootDir>/tests/e2e/**/*.test.ts',
    '<rootDir>/tests/e2e/**/*.test.js'
  ],
  
  // Exclusions
  testPathIgnorePatterns: [
    '/node_modules/',
    '/build/',
    '/dist/',
    'tests/unit/parent-child-validation.test.ts'
  ],
  
  // Configuration de la couverture
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts'
  ],
  
  // Seuils de couverture
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  
  // Configuration des workers
  maxWorkers: 1,
  
  // Timeouts
  testTimeout: 15000,
  
  // Mocks
  clearMocks: true,
  restoreMocks: true,
  
  // Transformation
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  
  // Extensions
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  
  // Variables d'environnement
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json'
    }
  }
};