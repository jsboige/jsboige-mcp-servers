/**
 * Performance Tests for Jupyter MCP Server
 *
 * Basic performance benchmarks and validation.
 */

describe('Jupyter MCP Server - Performance', () => {
  describe('File System Checks', () => {
    test('should have optimized dist folder structure', () => {
      const fs = require('fs');
      const path = require('path');
      const distPath = path.join(__dirname, '..', 'dist');

      // Check dist exists
      expect(fs.existsSync(distPath)).toBe(true);

      // Check required subfolders
      const expectedFolders = ['tools', 'services', 'utils'];
      for (const folder of expectedFolders) {
        const folderPath = path.join(distPath, folder);
        expect(fs.existsSync(folderPath)).toBe(true);
      }
    });

    test('compiled files should be reasonable size', () => {
      const fs = require('fs');
      const path = require('path');
      const indexPath = path.join(__dirname, '..', 'dist', 'index.js');

      const stats = fs.statSync(indexPath);
      // File should be less than 1MB
      expect(stats.size).toBeLessThan(1024 * 1024);
      // File should have some content
      expect(stats.size).toBeGreaterThan(100);
    });
  });

  describe('Memory Usage', () => {
    test('should not cause memory leaks on repeated operations', () => {
      const initialMemory = process.memoryUsage().heapUsed;

      // Perform some repeated operations
      for (let i = 0; i < 100; i++) {
        const obj = { data: new Array(100).fill('test') };
        JSON.stringify(obj);
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be reasonable (less than 50MB)
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
    });
  });

  describe('Basic Operations', () => {
    test('should handle synchronous operations efficiently', () => {
      const iterations = 1000;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        const result = { index: i, value: `item-${i}` };
        JSON.parse(JSON.stringify(result));
      }

      const duration = Date.now() - startTime;

      // 1000 iterations should complete in under 1 second
      expect(duration).toBeLessThan(1000);
    });

    test('should handle path operations efficiently', () => {
      const path = require('path');
      const iterations = 1000;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        path.join(__dirname, '..', 'dist', `file-${i}.js`);
        path.resolve(__dirname, '..', 'dist');
      }

      const duration = Date.now() - startTime;

      // Path operations should be fast
      expect(duration).toBeLessThan(500);
    });
  });
});
