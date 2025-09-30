export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  
  // Utiliser un seul worker pour éviter les problèmes de mémoire
  maxWorkers: 1,
  
  // Limite mémoire pour éviter heap overflow
  workerIdleMemoryLimit: "1GB",
  
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true
    }]
  },
  
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },

  // Racines explicites pour éviter les résolutions ESM ambiguës
  roots: ['<rootDir>/src', '<rootDir>/tests'],

  testMatch: [
    '**/tests/**/*.test.ts'
  ],

  testPathIgnorePatterns: [
    '/node_modules/',
    '/build/'
  ],

  // Setup Jest ESM globals et .env.test
  setupFilesAfterEnv: ['./tests/setup-env.ts'],

  // Provision de l'environnement ROO_STORAGE_PATH avant tests + nettoyage après
  globalSetup: '<rootDir>/tests/config/globalSetup.ts',
  globalTeardown: '<rootDir>/tests/config/globalTeardown.ts',

  testTimeout: 30000,

  clearMocks: true,
  restoreMocks: true,
  resetMocks: true
};