module.exports = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            useESM: true,
        }, ],
    },
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    testMatch: [
        '**/tests/suite/**/*.test.ts',
        '**/tests/*.test.ts',
    ],
    moduleFileExtensions: ['ts', 'js', 'json', 'node'],
};