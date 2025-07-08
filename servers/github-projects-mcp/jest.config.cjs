module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@modelcontextprotocol/sdk$': '<rootDir>/node_modules/@modelcontextprotocol/sdk/dist/cjs/server/index.js'
  },
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
};