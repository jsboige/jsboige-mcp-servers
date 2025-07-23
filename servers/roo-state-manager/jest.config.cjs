module.exports = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            useESM: true,
            tsconfig: '<rootDir>/tests/tsconfig.json'
        }, ],
    },
    moduleNameMapper: {
    },
    testMatch: [
        '**/tests/suite/**/*.test.ts',
        '**/tests/*.test.ts',
        '**/src/**/*.test.ts',
    ],
    moduleNameMapper: {
        '^\\./(.*)\\.js$': '<rootDir>/src/$1.ts',
    },
    moduleFileExtensions: ['ts', 'js', 'json', 'node'],
};