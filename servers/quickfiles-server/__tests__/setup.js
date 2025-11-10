/**
 * Jest Setup File for QuickFiles MCP Server Tests
 * 
 * This file is executed before each test file and sets up the test environment.
 * It provides global utilities and configurations needed for testing.
 * 
 * @version 1.0.0
 * @author Roo Code Assistant
 * @date 2025-11-02
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

// Global test utilities
global.testUtils = {
  /**
   * Create a mock file system structure for testing
   */
  createMockFileSystem: () => {
    return {
      'test-file.txt': 'Hello World',
      'test-dir': {
        'nested-file.md': '# Test Markdown'
      }
    };
  },

  /**
   * Create mock MCP request
   */
  createMockRequest: (toolName, args = {}) => {
    return {
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    };
  },

  /**
   * Wait for async operations
   */
  wait: (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
};

// Mock console methods to reduce noise in tests
const originalConsole = global.console;

beforeEach(() => {
  global.console = {
    ...originalConsole,
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
  };
});

afterEach(() => {
  global.console = originalConsole;
});

// Increase timeout for async operations
jest.setTimeout(30000);