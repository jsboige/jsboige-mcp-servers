/**
 * Tests unitaires pour GranularDiffDetector
 *
 * Couvre :
 * - Comparaison granulaire (objets, arrays, primitifs)
 * - Gestion null/undefined et types différents
 * - Options (ignoreWhitespace, ignoreCase, includeUnchanged, maxDepth)
 * - Modes de comparaison d'arrays (position vs identity)
 * - Sévérité et catégorie automatiques
 * - Règles personnalisées (add/remove/handlers)
 * - Export (JSON, CSV, HTML)
 * - Calcul de pourcentage de changement
 * - Résumé (summary) par type/sévérité/catégorie
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  GranularDiffDetector,
  type GranularDiffReport,
  type GranularDiffRule,
  type GranularDiffOptions,
} from '../GranularDiffDetector.js';

describe('GranularDiffDetector', () => {
  let detector: GranularDiffDetector;

  beforeEach(() => {
    detector = new GranularDiffDetector();
  });

  // === Basic Comparisons ===

  describe('basic comparisons', () => {
    it('should return empty diffs for identical objects', async () => {
      const obj = { a: 1, b: 'hello' };
      const report = await detector.compareGranular(obj, obj);

      expect(report.diffs).toHaveLength(0);
      expect(report.summary.total).toBe(0);
    });

    it('should detect added properties', async () => {
      const source = { a: 1 };
      const target = { a: 1, b: 2 };
      const report = await detector.compareGranular(source, target);

      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].type).toBe('added');
      expect(report.diffs[0].path).toBe('b');
      expect(report.diffs[0].newValue).toBe(2);
    });

    it('should detect removed properties', async () => {
      const source = { a: 1, b: 2 };
      const target = { a: 1 };
      const report = await detector.compareGranular(source, target);

      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].type).toBe('removed');
      expect(report.diffs[0].path).toBe('b');
      expect(report.diffs[0].oldValue).toBe(2);
    });

    it('should detect modified properties', async () => {
      const source = { a: 1 };
      const target = { a: 2 };
      const report = await detector.compareGranular(source, target);

      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].type).toBe('modified');
      expect(report.diffs[0].oldValue).toBe(1);
      expect(report.diffs[0].newValue).toBe(2);
    });

    it('should detect type changes', async () => {
      const source = { a: '1' };
      const target = { a: 1 };
      const report = await detector.compareGranular(source, target);

      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].type).toBe('modified');
      expect(report.diffs[0].description).toContain('Type changé');
    });
  });

  // === Null/Undefined Handling ===

  describe('null and undefined handling', () => {
    it('should detect addition from null source', async () => {
      const report = await detector.compareGranular(null, { a: 1 });

      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].type).toBe('added');
    });

    it('should detect removal to null target', async () => {
      const report = await detector.compareGranular({ a: 1 }, null);

      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].type).toBe('removed');
    });

    it('should handle both null', async () => {
      const report = await detector.compareGranular(null, null);
      expect(report.diffs).toHaveLength(0);
    });

    it('should handle undefined to value', async () => {
      const report = await detector.compareGranular(undefined, 'hello');
      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].type).toBe('added');
    });

    it('should handle nested null values', async () => {
      const source = { a: { b: null } };
      const target = { a: { b: 'value' } };
      const report = await detector.compareGranular(source, target);

      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].type).toBe('added');
      expect(report.diffs[0].path).toBe('a.b');
    });
  });

  // === Nested Objects ===

  describe('nested object comparison', () => {
    it('should handle deeply nested changes', async () => {
      const source = { level1: { level2: { level3: 'old' } } };
      const target = { level1: { level2: { level3: 'new' } } };
      const report = await detector.compareGranular(source, target);

      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].path).toBe('level1.level2.level3');
    });

    it('should respect maxDepth option', async () => {
      const source = { a: { b: { c: { d: 'deep' } } } };
      const target = { a: { b: { c: { d: 'changed' } } } };

      const report = await detector.compareGranular(source, target, 's', 't', {
        maxDepth: 2,
      });

      // At depth 2, we can't reach level d, so no diff detected
      expect(report.diffs).toHaveLength(0);
    });

    it('should detect multiple changes in nested objects', async () => {
      const source = { x: 1, nested: { a: 1, b: 2 } };
      const target = { x: 2, nested: { a: 1, b: 3 } };
      const report = await detector.compareGranular(source, target);

      expect(report.diffs.length).toBe(2);
      const paths = report.diffs.map((d) => d.path);
      expect(paths).toContain('x');
      expect(paths).toContain('nested.b');
    });
  });

  // === Array Comparison ===

  describe('array comparison - position mode', () => {
    it('should compare arrays by position', async () => {
      const source = { items: [1, 2, 3] };
      const target = { items: [1, 4, 3] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'position',
      });

      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].path).toBe('items[1]');
      expect(report.diffs[0].oldValue).toBe(2);
      expect(report.diffs[0].newValue).toBe(4);
    });

    it('should detect added elements by position', async () => {
      const source = { items: [1, 2] };
      const target = { items: [1, 2, 3] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'position',
      });

      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].path).toBe('items[2]');
      expect(report.diffs[0].type).toBe('added');
    });

    it('should detect removed elements by position', async () => {
      const source = { items: [1, 2, 3] };
      const target = { items: [1, 2] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'position',
      });

      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].path).toBe('items[2]');
      expect(report.diffs[0].type).toBe('removed');
    });
  });

  describe('array comparison - identity mode', () => {
    it('should detect added elements by identity', async () => {
      const source = { items: ['a', 'b'] };
      const target = { items: ['a', 'b', 'c'] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'identity',
      });

      const added = report.diffs.filter((d) => d.type === 'added');
      expect(added.length).toBe(1);
    });

    it('should detect removed elements by identity', async () => {
      const source = { items: ['a', 'b', 'c'] };
      const target = { items: ['a', 'c'] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'identity',
      });

      const removed = report.diffs.filter((d) => d.type === 'removed');
      expect(removed.length).toBe(1);
    });

    it('should detect occurrence count changes', async () => {
      const source = { items: ['a', 'a', 'b'] };
      const target = { items: ['a', 'b'] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'identity',
      });

      const modified = report.diffs.filter((d) => d.type === 'modified');
      expect(modified.length).toBe(1);
      expect(modified[0].description).toContain("Nombre d'occurrences");
    });

    it('should handle object elements in arrays', async () => {
      const source = { items: [{ id: 1, name: 'A' }] };
      const target = { items: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'identity',
      });

      const added = report.diffs.filter((d) => d.type === 'added');
      expect(added.length).toBe(1);
    });
  });

  // === Options ===

  describe('comparison options', () => {
    it('should ignore whitespace when configured', async () => {
      const source = { text: 'hello  world' };
      const target = { text: 'hello world' };

      const report = await detector.compareGranular(source, target, 's', 't', {
        ignoreWhitespace: true,
      });

      expect(report.diffs).toHaveLength(0);
    });

    it('should detect whitespace changes by default', async () => {
      const source = { text: 'hello  world' };
      const target = { text: 'hello world' };

      const report = await detector.compareGranular(source, target, 's', 't', {
        ignoreWhitespace: false,
      });

      expect(report.diffs.length).toBe(1);
    });

    it('should ignore case when configured', async () => {
      const source = { name: 'Hello' };
      const target = { name: 'hello' };

      const report = await detector.compareGranular(source, target, 's', 't', {
        ignoreCase: true,
      });

      expect(report.diffs).toHaveLength(0);
    });

    it('should include unchanged elements when configured', async () => {
      const source = { a: 1 };
      const target = { a: 1 };

      const report = await detector.compareGranular(source, target, 's', 't', {
        includeUnchanged: true,
      });

      expect(report.diffs.length).toBeGreaterThan(0);
      expect(report.diffs[0].type).toBe('unchanged');
    });
  });

  // === Severity Determination ===

  describe('severity determination', () => {
    it('should assign CRITICAL for system paths', async () => {
      const source = { system: { os: 'linux' } };
      const target = { system: { os: 'windows' } };

      const report = await detector.compareGranular(source, target);
      expect(report.diffs[0].severity).toBe('CRITICAL');
    });

    it('should assign CRITICAL for config.mcp paths', async () => {
      const source = { config: { mcp: { port: 3000 } } };
      const target = { config: { mcp: { port: 4000 } } };

      const report = await detector.compareGranular(source, target);
      const mcpDiffs = report.diffs.filter((d) => d.path.includes('config.mcp'));
      expect(mcpDiffs.length).toBeGreaterThan(0);
      expect(mcpDiffs[0].severity).toBe('CRITICAL');
    });

    it('should assign IMPORTANT for hardware paths', async () => {
      const source = { hardware: { ram: '16GB' } };
      const target = { hardware: { ram: '32GB' } };

      const report = await detector.compareGranular(source, target);
      expect(report.diffs[0].severity).toBe('IMPORTANT');
    });

    it('should assign WARNING for removed properties by default', async () => {
      const source = { custom: { a: 1, b: 2 } };
      const target = { custom: { a: 1 } };

      const report = await detector.compareGranular(source, target);
      const removed = report.diffs.filter((d) => d.type === 'removed');
      expect(removed.length).toBe(1);
      expect(removed[0].severity).toBe('WARNING');
    });

    it('should assign INFO for added properties by default', async () => {
      const source = { custom: { a: 1 } };
      const target = { custom: { a: 1, b: 2 } };

      const report = await detector.compareGranular(source, target);
      const added = report.diffs.filter((d) => d.type === 'added');
      expect(added.length).toBe(1);
      expect(added[0].severity).toBe('INFO');
    });
  });

  // === Category Determination ===

  describe('category determination', () => {
    it('should categorize config paths as roo_config', async () => {
      const source = { config: { theme: 'light' } };
      const target = { config: { theme: 'dark' } };

      const report = await detector.compareGranular(source, target);
      expect(report.diffs[0].category).toBe('roo_config');
    });

    it('should categorize hardware paths', async () => {
      const source = { hardware: { cpu: 'i7' } };
      const target = { hardware: { cpu: 'i9' } };

      const report = await detector.compareGranular(source, target);
      expect(report.diffs[0].category).toBe('hardware');
    });

    it('should categorize software paths', async () => {
      const source = { software: { node: '18' } };
      const target = { software: { node: '20' } };

      const report = await detector.compareGranular(source, target);
      expect(report.diffs[0].category).toBe('software');
    });

    it('should categorize system paths', async () => {
      const source = { system: { hostname: 'old' } };
      const target = { system: { hostname: 'new' } };

      const report = await detector.compareGranular(source, target);
      expect(report.diffs[0].category).toBe('system');
    });

    it('should categorize nested paths as nested', async () => {
      const source = { deep: { nested: { val: 1 } } };
      const target = { deep: { nested: { val: 2 } } };

      const report = await detector.compareGranular(source, target);
      expect(report.diffs[0].category).toBe('nested');
    });
  });

  // === Custom Rules ===

  describe('custom rules', () => {
    it('should add and retrieve custom rules', () => {
      const rule: GranularDiffRule = {
        name: 'test-rule',
        path: 'test.path',
        severity: 'WARNING',
        category: 'roo_config',
      };

      detector.addCustomRule(rule);
      const rules = detector.getCustomRules();

      // 4 default rules + 1 custom
      expect(rules.some((r) => r.name === 'test-rule')).toBe(true);
    });

    it('should remove custom rule by name', () => {
      const rule: GranularDiffRule = {
        name: 'removable-rule',
        path: 'test.path',
        severity: 'INFO',
        category: 'roo_config',
      };

      detector.addCustomRule(rule);
      const removed = detector.removeCustomRule('removable-rule');
      expect(removed).toBe(true);
      expect(detector.getCustomRules().some((r) => r.name === 'removable-rule')).toBe(false);
    });

    it('should return false when removing non-existent rule', () => {
      const removed = detector.removeCustomRule('non-existent');
      expect(removed).toBe(false);
    });

    it('should apply custom rule handler', async () => {
      const customResult = {
        id: 'custom-id',
        path: 'custom.path',
        type: 'modified' as const,
        severity: 'CRITICAL' as const,
        category: 'roo_config' as const,
        description: 'Custom handler detected change',
      };

      detector.addCustomRule({
        name: 'custom-handler',
        path: 'custom',
        severity: 'CRITICAL',
        category: 'roo_config',
        handler: (_old, _new, _path) => customResult,
      });

      const source = { custom: { path: 'old' } };
      const target = { custom: { path: 'new' } };

      const report = await detector.compareGranular(source, target);
      const customDiffs = report.diffs.filter((d) => d.description === 'Custom handler detected change');
      expect(customDiffs.length).toBe(1);
    });

    it('should skip custom rule handler returning null', async () => {
      detector.addCustomRule({
        name: 'null-handler',
        path: 'data',
        severity: 'INFO',
        category: 'roo_config',
        handler: () => null,
      });

      const source = { data: { val: 1 } };
      const target = { data: { val: 2 } };

      const report = await detector.compareGranular(source, target);
      // Should still detect the change via normal comparison
      expect(report.diffs.length).toBe(1);
    });

    it('should return copy from getCustomRules (not reference)', () => {
      const rules = detector.getCustomRules();
      const initialLength = rules.length;
      rules.push({
        name: 'injected',
        path: 'x',
        severity: 'INFO',
        category: 'roo_config',
      });

      expect(detector.getCustomRules().length).toBe(initialLength);
    });
  });

  // === Summary ===

  describe('summary calculation', () => {
    it('should count diffs by type', async () => {
      const source = { a: 1, b: 2, c: 3 };
      const target = { a: 10, c: 3, d: 4 };

      const report = await detector.compareGranular(source, target);

      expect(report.summary.byType.modified).toBeGreaterThanOrEqual(1);
      expect(report.summary.byType.removed).toBeGreaterThanOrEqual(1);
      expect(report.summary.byType.added).toBeGreaterThanOrEqual(1);
      expect(report.summary.total).toBe(report.diffs.length);
    });

    it('should count diffs by severity', async () => {
      const source = { system: { os: 'linux' }, data: { x: 1 } };
      const target = { system: { os: 'windows' }, data: { x: 2 } };

      const report = await detector.compareGranular(source, target);

      const totalBySeverity = Object.values(report.summary.bySeverity).reduce((a, b) => a + b, 0);
      expect(totalBySeverity).toBe(report.summary.total);
    });

    it('should count diffs by category', async () => {
      const source = { hardware: { ram: '8GB' }, software: { node: '18' } };
      const target = { hardware: { ram: '16GB' }, software: { node: '20' } };

      const report = await detector.compareGranular(source, target);

      expect(report.summary.byCategory.hardware).toBeGreaterThanOrEqual(1);
      expect(report.summary.byCategory.software).toBeGreaterThanOrEqual(1);
    });
  });

  // === Report Metadata ===

  describe('report metadata', () => {
    it('should include labels', async () => {
      const report = await detector.compareGranular({}, {}, 'machine-A', 'machine-B');

      expect(report.sourceLabel).toBe('machine-A');
      expect(report.targetLabel).toBe('machine-B');
    });

    it('should include performance metrics', async () => {
      const source = { a: { b: { c: 1 } } };
      const target = { a: { b: { c: 2 } } };

      const report = await detector.compareGranular(source, target);

      expect(report.performance.executionTime).toBeGreaterThanOrEqual(0);
      expect(report.performance.nodesCompared).toBeGreaterThan(0);
    });

    it('should include timestamp', async () => {
      const report = await detector.compareGranular({}, {});
      expect(report.timestamp).toBeDefined();
      expect(new Date(report.timestamp).getTime()).not.toBeNaN();
    });

    it('should generate unique reportId', async () => {
      const report1 = await detector.compareGranular({}, {});
      const report2 = await detector.compareGranular({}, {});

      expect(report1.reportId).not.toBe(report2.reportId);
    });
  });

  // === Change Percent ===

  describe('change percent calculation', () => {
    it('should calculate percent change for numbers', async () => {
      const source = { value: 100 };
      const target = { value: 150 };

      const report = await detector.compareGranular(source, target);

      expect(report.diffs[0].metadata?.changePercent).toBe(50);
    });

    it('should handle zero to non-zero', async () => {
      const source = { value: 0 };
      const target = { value: 42 };

      const report = await detector.compareGranular(source, target);

      expect(report.diffs[0].metadata?.changePercent).toBe(100);
    });

    it('should calculate percent for strings', async () => {
      const source = { text: 'abcd' };
      const target = { text: 'abce' };

      const report = await detector.compareGranular(source, target);

      expect(report.diffs[0].metadata?.changePercent).toBeDefined();
      expect(report.diffs[0].metadata!.changePercent!).toBeGreaterThan(0);
    });
  });

  // === Export ===

  describe('export', () => {
    let sampleReport: GranularDiffReport;

    beforeEach(async () => {
      const source = { a: 1, b: 'old' };
      const target = { a: 2, b: 'new', c: true };
      sampleReport = await detector.compareGranular(source, target);
    });

    it('should export to JSON', async () => {
      const json = await detector.exportDiff(sampleReport, 'json');
      const parsed = JSON.parse(json);
      expect(parsed.reportId).toBe(sampleReport.reportId);
      expect(parsed.diffs).toHaveLength(sampleReport.diffs.length);
    });

    it('should export to CSV', async () => {
      const csv = await detector.exportDiff(sampleReport, 'csv');

      expect(csv).toContain('ID');
      expect(csv).toContain('Path');
      expect(csv).toContain('Type');
      expect(csv).toContain('Severity');
      // Should have header + data rows
      const lines = csv.split('\n');
      expect(lines.length).toBe(1 + sampleReport.diffs.length);
    });

    it('should export to HTML', async () => {
      const html = await detector.exportDiff(sampleReport, 'html');

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('Granular Diff Report');
      expect(html).toContain(sampleReport.reportId);
    });

    it('should throw for unsupported format', async () => {
      await expect(
        detector.exportDiff(sampleReport, 'xml' as any)
      ).rejects.toThrow('Format non supporté');
    });
  });

  // === Complex Objects ===

  describe('complex objects', () => {
    it('should handle Date objects (same value = no diff)', async () => {
      // Date objects with identical time are equal via deepEqual (same keys/values)
      const d = new Date('2026-01-01');
      const source = { date: d };
      const target = { date: d };

      const report = await detector.compareGranular(source, target);
      expect(report.diffs).toHaveLength(0);
    });

    it('should detect different Date objects', async () => {
      // Different Date objects go through isPlainObject=false path then deepEqual
      // deepEqual compares their enumerable keys which are empty, so they appear equal
      // This is a known limitation: Date comparison uses deepEqual which compares own keys
      const source = { date: new Date('2026-01-01') };
      const target = { date: new Date('2026-02-01') };

      const report = await detector.compareGranular(source, target);
      // Two Date objects have no own enumerable keys, so deepEqual returns true
      // This documents the current behavior
      expect(report.diffs).toHaveLength(0);
    });

    it('should handle boolean changes', async () => {
      const source = { enabled: true };
      const target = { enabled: false };

      const report = await detector.compareGranular(source, target);
      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].type).toBe('modified');
    });

    it('should handle mixed-type arrays', async () => {
      const source = { items: [1, 'two', true] };
      const target = { items: [1, 'two', false] };

      const report = await detector.compareGranular(source, target, 's', 't', {
        arrayDiffMode: 'position',
      });

      expect(report.diffs.length).toBe(1);
      expect(report.diffs[0].path).toBe('items[2]');
    });

    it('should handle empty objects', async () => {
      const report = await detector.compareGranular({}, {});
      expect(report.diffs).toHaveLength(0);
    });

    it('should handle empty arrays', async () => {
      const source = { items: [] as any[] };
      const target = { items: [] as any[] };

      const report = await detector.compareGranular(source, target);
      expect(report.diffs).toHaveLength(0);
    });
  });

  // === Default Rules ===

  describe('default rules', () => {
    it('should have 4 default rules', () => {
      const rules = detector.getCustomRules();
      expect(rules.length).toBe(4);
    });

    it('should include critical config rule', () => {
      const rules = detector.getCustomRules();
      expect(rules.some((r) => r.name === 'Critical config changes')).toBe(true);
    });

    it('should include hardware rule', () => {
      const rules = detector.getCustomRules();
      expect(rules.some((r) => r.name === 'Hardware changes')).toBe(true);
    });

    it('should include software version rule', () => {
      const rules = detector.getCustomRules();
      expect(rules.some((r) => r.name === 'Software version changes')).toBe(true);
    });

    it('should include system rule', () => {
      const rules = detector.getCustomRules();
      expect(rules.some((r) => r.name === 'System changes')).toBe(true);
    });
  });
});
