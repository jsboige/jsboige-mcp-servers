/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 30000, // Augmenter le timeout pour les tests E2E
  moduleNameMapper: {
    // Forcer la résolution des imports .js vers les fichiers .ts correspondants
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};