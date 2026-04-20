import { describe, it, expect, beforeEach } from 'vitest';
import { GranularDiffDetector } from '../../../src/services/GranularDiffDetector.js';

describe('GranularDiffDetector', () => {
  let detector: GranularDiffDetector;

  beforeEach(() => {
    detector = new GranularDiffDetector();
  });

  describe('compareGranular', () => {
    it('detects no diff between identical objects', async () => {
      const report = await detector.compareGranular({ a: 1, b: 'hello' }, { a: 1, b: 'hello' });
      expect(report.summary.total).toBe(0);
      expect(report.diffs).toHaveLength(0);
    });

    it('detects added property', async () => {
      const report = await detector.compareGranular({ a: 1 }, { a: 1, b: 2 });
      expect(report.diffs).toHaveLength(1);
      expect(report.diffs[0].type).toBe('added');
      expect(report.diffs[0].newValue).toBe(2);
    });

    it('detects removed property', async () => {
      const report = await detector.compareGranular({ a: 1, b: 2 }, { a: 1 });
      expect(report.diffs).toHaveLength(1);
      expect(report.diffs[0].type).toBe('removed');
      expect(report.diffs[0].oldValue).toBe(2);
    });

    it('detects modified value', async () => {
      const report = await detector.compareGranular({ a: 1 }, { a: 2 });
      expect(report.diffs).toHaveLength(1);
      expect(report.diffs[0].type).toBe('modified');
      expect(report.diffs[0].oldValue).toBe(1);
      expect(report.diffs[0].newValue).toBe(2);
    });

    it('detects type change', async () => {
      const report = await detector.compareGranular({ a: 1 }, { a: '1' });
      expect(report.diffs).toHaveLength(1);
      expect(report.diffs[0].type).toBe('modified');
      expect(report.diffs[0].description).toContain('Type changé');
    });

    it('detects nested object diff', async () => {
      const report = await detector.compareGranular(
        { config: { mcp: { servers: ['a'] } } },
        { config: { mcp: { servers: ['a', 'b'] } } }
      );
      expect(report.summary.total).toBeGreaterThan(0);
    });

    it('detects null to value as added', async () => {
      const report = await detector.compareGranular({ a: null }, { a: 'value' });
      expect(report.diffs).toHaveLength(1);
      expect(report.diffs[0].type).toBe('added');
    });

    it('detects value to null as removed', async () => {
      const report = await detector.compareGranular({ a: 'value' }, { a: null });
      expect(report.diffs).toHaveLength(1);
      expect(report.diffs[0].type).toBe('removed');
    });

    it('handles empty objects', async () => {
      const report = await detector.compareGranular({}, {});
      expect(report.summary.total).toBe(0);
    });

    it('handles undefined source', async () => {
      const report = await detector.compareGranular(undefined, { a: 1 });
      expect(report.summary.total).toBeGreaterThan(0);
    });

    it('includes unchanged when requested', async () => {
      const report = await detector.compareGranular(
        { a: 1 }, { a: 1 },
        'source', 'target',
        { includeUnchanged: true }
      );
      expect(report.summary.byType.unchanged).toBeGreaterThan(0);
    });

    it('respects maxDepth option', async () => {
      const deep = { level1: { level2: { level3: { level4: 'deep' } } } };
      const deep2 = { level1: { level2: { level3: { level4: 'changed' } } } };
      const report = await detector.compareGranular(deep, deep2, 's', 't', { maxDepth: 1 });
      expect(report.summary.total).toBe(0); // depth exceeded, no diff
    });

    it('generates unique report IDs', async () => {
      const r1 = await detector.compareGranular({ a: 1 }, { a: 2 });
      const r2 = await detector.compareGranular({ a: 1 }, { a: 2 });
      expect(r1.reportId).not.toBe(r2.reportId);
    });

    it('includes performance metrics', async () => {
      const report = await detector.compareGranular({ a: 1 }, { a: 2 });
      expect(report.performance.executionTime).toBeGreaterThanOrEqual(0);
      expect(report.performance.nodesCompared).toBeGreaterThan(0);
    });

    it('includes labels in report', async () => {
      const report = await detector.compareGranular({ a: 1 }, { a: 2 }, 'machine-A', 'machine-B');
      expect(report.sourceLabel).toBe('machine-A');
      expect(report.targetLabel).toBe('machine-B');
    });
  });

  describe('array comparison', () => {
    it('detects added array element (identity mode)', async () => {
      const report = await detector.compareGranular(
        { items: [1, 2] },
        { items: [1, 2, 3] }
      );
      expect(report.summary.total).toBeGreaterThan(0);
    });

    it('detects removed array element (identity mode)', async () => {
      const report = await detector.compareGranular(
        { items: [1, 2, 3] },
        { items: [1, 2] }
      );
      expect(report.summary.total).toBeGreaterThan(0);
    });

    it('compares arrays by position', async () => {
      const report = await detector.compareGranular(
        { items: ['a', 'b'] },
        { items: ['a', 'c'] },
        's', 't',
        { arrayDiffMode: 'position' }
      );
      expect(report.summary.total).toBeGreaterThan(0);
    });

    it('handles named array elements', async () => {
      const src = { servers: [{ name: 'a', port: 80 }] };
      const tgt = { servers: [{ name: 'b', port: 443 }] };
      const report = await detector.compareGranular(src, tgt);
      expect(report.summary.total).toBeGreaterThan(0);
    });
  });

  describe('severity', () => {
    it('classifies system.* paths as CRITICAL', async () => {
      const report = await detector.compareGranular(
        { 'system.os': 'linux' },
        { 'system.os': 'windows' }
      );
      expect(report.diffs.some(d => d.severity === 'CRITICAL')).toBe(true);
    });

    it('classifies hardware.* paths as IMPORTANT', async () => {
      const report = await detector.compareGranular(
        { 'hardware.cpu': 'i7' },
        { 'hardware.cpu': 'i9' }
      );
      expect(report.diffs.some(d => d.severity === 'IMPORTANT')).toBe(true);
    });

    it('classifies removed items as WARNING by default', async () => {
      const report = await detector.compareGranular(
        { misc: 'value' },
        {}
      );
      expect(report.diffs[0].severity).toBe('WARNING');
    });

    it('classifies added items as INFO by default', async () => {
      const report = await detector.compareGranular(
        {},
        { misc: 'value' }
      );
      expect(report.diffs[0].severity).toBe('INFO');
    });
  });

  describe('category', () => {
    it('classifies config.* as roo_config', async () => {
      const report = await detector.compareGranular(
        { 'config.mode': 'code' },
        { 'config.mode': 'debug' }
      );
      expect(report.diffs[0].category).toBe('roo_config');
    });

    it('classifies software.* paths as software', async () => {
      const report = await detector.compareGranular(
        { 'software.node.version': '18' },
        { 'software.node.version': '20' }
      );
      expect(report.diffs[0].category).toBe('software');
    });

    it('classifies paths with brackets as array', async () => {
      const report = await detector.compareGranular(
        { 'items[0]': 'old' },
        { 'items[0]': 'new' }
      );
      expect(report.diffs[0].category).toBe('array');
    });
  });

  describe('custom rules', () => {
    it('addCustomRule adds a rule', () => {
      detector.addCustomRule({
        name: 'test-rule',
        path: /^custom\./,
        severity: 'CRITICAL',
        category: 'roo_config'
      });
      const rules = detector.getCustomRules();
      expect(rules.some(r => r.name === 'test-rule')).toBe(true);
    });

    it('removeCustomRule removes a rule', () => {
      detector.addCustomRule({
        name: 'to-remove',
        path: /^test\./,
        severity: 'INFO',
        category: 'software'
      });
      const removed = detector.removeCustomRule('to-remove');
      expect(removed).toBe(true);
      expect(detector.getCustomRules().some(r => r.name === 'to-remove')).toBe(false);
    });

    it('removeCustomRule returns false for unknown rule', () => {
      expect(detector.removeCustomRule('nonexistent')).toBe(false);
    });

    it('custom rule handler is invoked', async () => {
      detector.addCustomRule({
        name: 'custom-handler',
        path: /^special\.value/,
        severity: 'CRITICAL',
        category: 'roo_config',
        handler: (oldVal, newVal, path) => ({
          id: `custom-${Date.now()}`,
          path,
          type: 'modified' as const,
          severity: 'CRITICAL' as const,
          category: 'roo_config' as const,
          description: `Custom: ${oldVal} → ${newVal}`,
          oldValue: oldVal,
          newValue: newVal
        })
      });
      const report = await detector.compareGranular(
        { 'special.value': 'old' },
        { 'special.value': 'new' }
      );
      expect(report.diffs.some(d => d.description.startsWith('Custom:'))).toBe(true);
    });

    it('getCustomRules returns a copy', () => {
      const rules1 = detector.getCustomRules();
      const rules2 = detector.getCustomRules();
      expect(rules1).not.toBe(rules2);
      expect(rules1.length).toBe(rules2.length);
    });
  });

  describe('exportDiff', () => {
    it('exports to JSON', async () => {
      const report = await detector.compareGranular({ a: 1 }, { a: 2 });
      const exported = await detector.exportDiff(report, 'json');
      const parsed = JSON.parse(exported);
      expect(parsed.reportId).toBe(report.reportId);
    });

    it('exports to CSV', async () => {
      const report = await detector.compareGranular({ a: 1 }, { a: 2 });
      const csv = await detector.exportDiff(report, 'csv');
      expect(csv).toContain('Path');
      expect(csv).toContain('Type');
    });

    it('exports to HTML', async () => {
      const report = await detector.compareGranular({ a: 1 }, { a: 2 });
      const html = await detector.exportDiff(report, 'html');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain(report.reportId);
    });
  });

  describe('changePercent', () => {
    it('calculates percent change for numbers', async () => {
      const report = await detector.compareGranular({ val: 100 }, { val: 150 });
      expect(report.diffs[0].metadata?.changePercent).toBe(50);
    });

    it('handles zero old value', async () => {
      const report = await detector.compareGranular({ val: 0 }, { val: 5 });
      expect(report.diffs[0].metadata?.changePercent).toBe(100);
    });
  });

  describe('summary', () => {
    it('summarizes diffs by type, severity, and category', async () => {
      const report = await detector.compareGranular(
        { a: 1, b: 'hello', 'config.x': 'old' },
        { a: 2, c: 'new', 'config.x': 'new' }
      );
      expect(report.summary.total).toBeGreaterThan(0);
      expect(report.summary.byType.modified).toBeGreaterThan(0);
      expect(report.summary.byType.added).toBeGreaterThan(0);
      // All counts should be non-negative
      for (const count of Object.values(report.summary.byType)) {
        expect(count).toBeGreaterThanOrEqual(0);
      }
      for (const count of Object.values(report.summary.bySeverity)) {
        expect(count).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
