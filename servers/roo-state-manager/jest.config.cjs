/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  // Indique à Jest que les fichiers .ts sont des modules ES
  extensionsToTreatAsEsm: ['.ts'],
  testEnvironment: 'node',
  // globalSetup: '<rootDir>/tests/global-setup.ts',
  // globalTeardown: '<rootDir>/tests/global-teardown.ts',
  setupFilesAfterEnv: ['<rootDir>/tests/setup-env.ts'],
  
  // Configuration du transformateur ts-jest
  transform: {
    // Utilise ts-jest pour tous les fichiers .ts et .tsx
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        // Indique à ts-jest qu'on utilise des modules ES
        useESM: true,
        // Options de compilation TypeScript
        tsconfig: 'tsconfig.json',
      },
    ],
  },
  
  // Mappe les importations .js vers les fichiers source .ts
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  
  // Ne pas ignorer les modules ES dans node_modules qui doivent être transformés
  transformIgnorePatterns: [
    '/node_modules/(?!(@qdrant/js-client-rest|glob|openai)/)',
  ],
  
  // Pattern pour trouver les fichiers de test
  testMatch: ['**/src/**/*.test.ts', '**/tests/**/*.test.ts'],
};