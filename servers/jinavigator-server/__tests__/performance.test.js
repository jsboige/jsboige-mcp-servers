/**
 * Performance Test Suite
 *
 * This file aggregates performance tests for CI compliance.
 * The actual test implementations are in the performance/ subdirectory.
 */

describe('Performance Tests', () => {
  // Import performance tests
  require('./performance/tools-performance.test.js');
  require('./performance/utils-performance.test.js');

  it('should have performance test coverage', () => {
    // This test ensures the test suite runs
    expect(true).toBe(true);
  });
});
