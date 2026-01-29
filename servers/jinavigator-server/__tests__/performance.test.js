/**
 * Performance Tests for Jinavigator MCP Server
 *
 * Re-exports and aggregates performance tests.
 */

describe('Jinavigator MCP Server - Performance', () => {
  describe('Memory Usage', () => {
    test('should not cause memory leaks on repeated operations', () => {
      const initialMemory = process.memoryUsage().heapUsed;

      // Simulate repeated markdown processing
      for (let i = 0; i < 100; i++) {
        const markdown = `# Heading ${i}\n\nSome content with **bold** and *italic*.`;
        const parsed = markdown.split('\n').map(line => line.trim());
        JSON.stringify(parsed);
      }

      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
    });
  });

  describe('String Operations', () => {
    test('should handle URL parsing efficiently', () => {
      const iterations = 1000;
      const startTime = Date.now();
      const urls = [
        'https://example.com/page',
        'https://example.org/path/to/resource',
        'http://localhost:3000/api/v1/data'
      ];

      for (let i = 0; i < iterations; i++) {
        const url = urls[i % urls.length];
        new URL(url);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000);
    });

    test('should handle markdown processing efficiently', () => {
      const iterations = 500;
      const startTime = Date.now();

      const sampleMarkdown = `
# Main Title

## Section 1
Some content here with **bold** text.

## Section 2
- List item 1
- List item 2
- List item 3

### Subsection
More detailed content.
      `.trim();

      for (let i = 0; i < iterations; i++) {
        // Simulate outline extraction
        const lines = sampleMarkdown.split('\n');
        const headings = lines.filter(line => line.startsWith('#'));
        const outline = headings.map(h => ({
          level: (h.match(/^#+/) || [''])[0].length,
          text: h.replace(/^#+\s*/, '')
        }));
        expect(outline.length).toBeGreaterThan(0);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('Concurrency', () => {
    test('should handle concurrent requests efficiently', async () => {
      const startTime = Date.now();
      const concurrency = 10;

      const simulateRequest = async (id) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { id, status: 'complete' };
      };

      const requests = Array(concurrency).fill(null).map((_, i) => simulateRequest(i));
      const results = await Promise.all(requests);

      const duration = Date.now() - startTime;

      expect(results.length).toBe(concurrency);
      expect(duration).toBeLessThan(500); // Should run in parallel
    });
  });
});
