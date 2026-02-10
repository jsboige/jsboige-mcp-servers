/**
 * Tests unitaires pour TruncationEngine
 *
 * Couvre :
 * - truncateToolParameters : troncature paramètres (string, objet, structure)
 * - truncateToolResult : troncature résultats (lignes, simple)
 * - generateTruncationToggle : HTML toggle
 * - generateExpandableContent : HTML expandable
 * - truncateObjectIntelligently : troncature objet (indirecte)
 */
import { describe, it, expect } from 'vitest';
import { TruncationEngine } from '../TruncationEngine.js';

describe('TruncationEngine', () => {
  // === truncateToolParameters ===

  describe('truncateToolParameters', () => {
    it('should return "N/A" for null params', () => {
      const result = TruncationEngine.truncateToolParameters(null);
      expect(result.content).toBe('N/A');
      expect(result.wasTruncated).toBe(false);
    });

    it('should return "N/A" for undefined params', () => {
      const result = TruncationEngine.truncateToolParameters(undefined);
      expect(result.content).toBe('N/A');
      expect(result.wasTruncated).toBe(false);
    });

    it('should not truncate short string params', () => {
      const result = TruncationEngine.truncateToolParameters('short param');
      expect(result.content).toBe('short param');
      expect(result.wasTruncated).toBe(false);
    });

    it('should not truncate short object params', () => {
      const params = { key: 'value', num: 42 };
      const result = TruncationEngine.truncateToolParameters(params);
      expect(result.wasTruncated).toBe(false);
      expect(JSON.parse(result.content)).toEqual(params);
    });

    it('should truncate long string params', () => {
      const longString = 'x'.repeat(1000);
      const result = TruncationEngine.truncateToolParameters(longString, { maxParameterLength: 100 });
      expect(result.wasTruncated).toBe(true);
      expect(result.content.length).toBeLessThanOrEqual(110); // 100 + "..."
    });

    it('should truncate large objects with preserveStructure', () => {
      const params = {
        a: 'x'.repeat(100),
        b: 'y'.repeat(100),
        c: 'z'.repeat(100),
        d: 'w'.repeat(100),
        e: 'v'.repeat(100),
      };
      const result = TruncationEngine.truncateToolParameters(params, {
        maxParameterLength: 200,
        preserveStructure: true,
      });
      expect(result.wasTruncated).toBe(true);
      // Should contain "..." key for truncated properties
      const parsed = JSON.parse(result.content);
      expect(parsed['...']).toBeDefined();
    });

    it('should truncate large objects without preserveStructure', () => {
      const longString = 'x'.repeat(1000);
      const result = TruncationEngine.truncateToolParameters(longString, {
        maxParameterLength: 200,
        preserveStructure: false,
      });
      expect(result.wasTruncated).toBe(true);
      expect(result.content).toContain('...');
    });

    it('should use default maxLength of 500', () => {
      const params = 'x'.repeat(600);
      const result = TruncationEngine.truncateToolParameters(params);
      expect(result.wasTruncated).toBe(true);
    });

    it('should not truncate params exactly at max length', () => {
      const params = 'x'.repeat(500);
      const result = TruncationEngine.truncateToolParameters(params);
      expect(result.wasTruncated).toBe(false);
    });
  });

  // === truncateToolResult ===

  describe('truncateToolResult', () => {
    it('should return "N/A" for null result', () => {
      const result = TruncationEngine.truncateToolResult(null);
      expect(result.content).toBe('N/A');
      expect(result.wasTruncated).toBe(false);
    });

    it('should return "N/A" for undefined result', () => {
      const result = TruncationEngine.truncateToolResult(undefined);
      expect(result.content).toBe('N/A');
      expect(result.wasTruncated).toBe(false);
    });

    it('should not truncate short result', () => {
      const result = TruncationEngine.truncateToolResult('short result');
      expect(result.content).toBe('short result');
      expect(result.wasTruncated).toBe(false);
    });

    it('should truncate long result with many lines (preserve first/last)', () => {
      const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: content here`);
      const longResult = lines.join('\n');
      const result = TruncationEngine.truncateToolResult(longResult, { maxResultLength: 100 });
      expect(result.wasTruncated).toBe(true);
      expect(result.content).toContain('Line 1');
      expect(result.content).toContain('lignes tronquées');
    });

    it('should truncate long single-line result', () => {
      const longResult = 'x'.repeat(2000);
      const result = TruncationEngine.truncateToolResult(longResult, { maxResultLength: 500 });
      expect(result.wasTruncated).toBe(true);
      expect(result.content).toContain('...');
    });

    it('should use default maxLength of 1000', () => {
      const longResult = 'x'.repeat(1500);
      const result = TruncationEngine.truncateToolResult(longResult);
      expect(result.wasTruncated).toBe(true);
    });

    it('should handle object results', () => {
      const obj = { key: 'x'.repeat(2000) };
      const result = TruncationEngine.truncateToolResult(obj, { maxResultLength: 500 });
      expect(result.wasTruncated).toBe(true);
    });

    it('should preserve context with first 5 and last 3 lines', () => {
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`);
      const longResult = lines.join('\n');
      const result = TruncationEngine.truncateToolResult(longResult, { maxResultLength: 50 });
      expect(result.wasTruncated).toBe(true);
      // First 5 lines preserved
      expect(result.content).toContain('Line 1');
      expect(result.content).toContain('Line 5');
      // Last 3 lines preserved
      expect(result.content).toContain('Line 18');
      expect(result.content).toContain('Line 20');
    });
  });

  // === generateTruncationToggle ===

  describe('generateTruncationToggle', () => {
    it('should generate HTML with toggle button', () => {
      const html = TruncationEngine.generateTruncationToggle('full content', 'truncated...', 'elem-1');
      expect(html).toContain('truncation-container');
      expect(html).toContain('truncated-elem-1');
      expect(html).toContain('full-elem-1');
      expect(html).toContain('full content');
      expect(html).toContain('truncated...');
      expect(html).toContain('toggleTruncation');
    });

    it('should include expand and collapse buttons', () => {
      const html = TruncationEngine.generateTruncationToggle('full', 'short', 'test-id');
      expect(html).toContain('expand-button');
      expect(html).toContain('collapse-button');
      expect(html).toContain('Voir le contenu complet');
      expect(html).toContain('Réduire');
    });

    it('should use element ID for onclick handlers', () => {
      const html = TruncationEngine.generateTruncationToggle('a', 'b', 'my-element');
      expect(html).toContain("toggleTruncation('my-element')");
    });
  });

  // === generateExpandableContent ===

  describe('generateExpandableContent', () => {
    it('should generate expandable HTML', () => {
      const html = TruncationEngine.generateExpandableContent('<p>details</p>', 'Summary text', 'exp-1');
      expect(html).toContain('expandable-container');
      expect(html).toContain('content-summary');
      expect(html).toContain('Summary text');
      expect(html).toContain('<p>details</p>');
      expect(html).toContain('expandable-exp-1');
    });

    it('should include toggle button', () => {
      const html = TruncationEngine.generateExpandableContent('content', 'sum', 'id');
      expect(html).toContain('expand-toggle');
      expect(html).toContain('toggleExpandable');
      expect(html).toContain('Développer');
    });
  });
});
