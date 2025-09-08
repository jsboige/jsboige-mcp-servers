export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  
  // Utiliser un seul worker pour éviter les problèmes de mémoire
  maxWorkers: 1,
  
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true
    }]
  },
  
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  
  testMatch: [
    '**/tests/**/*.test.ts'
  ],
  
  testPathIgnorePatterns: [
    '/node_modules/',
    '/build/'
  ],
  
  setupFilesAfterEnv: ['./tests/setup-env.ts'],
  
  testTimeout: 30000,
  
  clearMocks: true,
  restoreMocks: true,
  resetMocks: true
};