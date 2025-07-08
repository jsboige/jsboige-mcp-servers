const { Server } = require('@modelcontextprotocol/sdk');

describe('Simple Server SDK Import Test', () => {
  it('should import and instantiate Server', () => {
    // If this passes, the moduleNameMapper in jest.config.js is working correctly
    const server = new Server({
      name: 'test-server',
      displayName: 'Test Server',
      description: 'A test server',
      author: 'Roo',
      tools: []
    });
    expect(server).toBeDefined();
  });
});