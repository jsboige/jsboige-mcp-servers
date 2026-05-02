/**
 * Tests unitaires pour ConfigDiffService
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigDiffService } from '../../../src/services/ConfigDiffService.js';
import type { ConfigChange, DiffResult } from '../../../src/types/config-sharing.js';

describe('ConfigDiffService', () => {
  let configDiffService: ConfigDiffService;

  beforeEach(() => {
    configDiffService = new ConfigDiffService();
  });

  describe('compare', () => {
    it('should detect additions', () => {
      const baseline = { a: 1, b: 2 };
      const current = { a: 1, b: 2, c: 3 };

      const result = configDiffService.compare(baseline, current);

      expect(result.summary.added).toBe(1);
      expect(result.summary.modified).toBe(0);
      expect(result.summary.deleted).toBe(0);

      const addedChange = result.changes.find(c => c.type === 'add');
      expect(addedChange?.path).toEqual(['c']);
      expect(addedChange?.newValue).toBe(3);
    });

    it('should detect deletions', () => {
      const baseline = { a: 1, b: 2, c: 3 };
      const current = { a: 1, b: 2 };

      const result = configDiffService.compare(baseline, current);

      expect(result.summary.added).toBe(0);
      expect(result.summary.modified).toBe(0);
      expect(result.summary.deleted).toBe(1);

      const deletedChange = result.changes.find(c => c.type === 'delete');
      expect(deletedChange?.path).toEqual(['c']);
      expect(deletedChange?.oldValue).toBe(3);
    });

    it('should detect modifications', () => {
      const baseline = { a: 1, b: 2 };
      const current = { a: 10, b: 2 };

      const result = configDiffService.compare(baseline, current);

      expect(result.summary.added).toBe(0);
      expect(result.summary.modified).toBe(1);
      expect(result.summary.deleted).toBe(0);

      const modifiedChange = result.changes.find(c => c.type === 'modify');
      expect(modifiedChange?.path).toEqual(['a']);
      expect(modifiedChange?.oldValue).toBe(1);
      expect(modifiedChange?.newValue).toBe(10);
    });

    it('should handle array additions', () => {
      const baseline = { items: [1, 2] };
      const current = { items: [1, 2, 3] };

      const result = configDiffService.compare(baseline, current);

      expect(result.summary.added).toBe(1);
      const addedChange = result.changes.find(c => c.path.toString() === 'items,2');
      expect(addedChange?.newValue).toBe(3);
    });

    it('should handle array deletions', () => {
      const baseline = { items: [1, 2, 3] };
      const current = { items: [1, 3] };

      const result = configDiffService.compare(baseline, current);

      expect(result.summary.deleted).toBe(1);
      const deletedChange = result.changes.find(c => c.path.toString() === 'items,1');
      expect(deletedChange?.oldValue).toBe(2);
    });

    it('should handle nested object changes', () => {
      const baseline = {
        user: {
          name: 'John',
          age: 30,
          address: {
            city: 'Paris',
            country: 'France'
          }
        }
      };

      const current = {
        user: {
          name: 'John',
          age: 31,
          address: {
            city: 'Lyon',
            country: 'France'
          }
        }
      };

      const result = configDiffService.compare(baseline, current);

      expect(result.summary.modified).toBe(2);

      const ageChange = result.changes.find(c => c.path.toString() === 'user,age');
      expect(ageChange?.oldValue).toBe(30);
      expect(ageChange?.newValue).toBe(31);

      const cityChange = result.changes.find(c => c.path.toString() === 'user,address,city');
      expect(cityChange?.oldValue).toBe('Paris');
      expect(cityChange?.newValue).toBe('Lyon');
    });

    it('should handle completely different objects', () => {
      const baseline = { old: true };
      const current = { new: false };

      const result = configDiffService.compare(baseline, current);

      expect(result.summary.added).toBe(1);
      expect(result.summary.deleted).toBe(1);
      expect(result.summary.modified).toBe(0);
    });

    it('should include versions in result', () => {
      const baseline = { a: 1 };
      const current = { a: 2 };
      const sourceVersion = 'local-v1';
      const targetVersion = 'baseline-v1';

      const result = configDiffService.compare(baseline, current, sourceVersion, targetVersion);

      expect(result.sourceVersion).toBe(sourceVersion);
      expect(result.targetVersion).toBe(targetVersion);
      expect(result.timestamp).toBeDefined();
    });

    it('should use default versions when not provided', () => {
      const baseline = { a: 1 };
      const current = { a: 2 };

      const result = configDiffService.compare(baseline, current);

      expect(result.sourceVersion).toBe('local');
      expect(result.targetVersion).toBe('baseline');
    });

    it('should handle empty objects', () => {
      const baseline = {};
      const current = {};

      const result = configDiffService.compare(baseline, current);

      expect(result.summary.added).toBe(0);
      expect(result.summary.modified).toBe(0);
      expect(result.summary.deleted).toBe(0);
      expect(result.changes).toHaveLength(0);
    });

    it('should handle null and undefined', () => {
      const baseline = null;
      const current = { a: 1 };

      const result = configDiffService.compare(baseline, current);

      expect(result.summary.modified).toBe(1);
    });
  });

  describe('severity calculation', () => {
    it('should mark sensitive keys as critical', () => {
      const testCases = [
        { key: 'api_key', expected: 'critical' },
        { key: 'secret', expected: 'critical' },
        { key: 'password', expected: 'critical' },
        { key: 'auth_token', expected: 'critical' },
        { key: 'credentials', expected: 'critical' },
        { key: 'normal_setting', expected: 'info' },
        { key: 'name', expected: 'info' }
      ];

      testCases.forEach(({ key, expected }) => {
        const baseline = { [key]: 'old' };
        const current = { [key]: 'new' };

        const result = configDiffService.compare(baseline, current);
        const change = result.changes.find(c => c.path[0] === key);

        expect(change?.severity).toBe(expected);
      });
    });

    it('should handle nested sensitive keys', () => {
      const baseline = { config: { api_key: 'old' } };
      const current = { config: { api_key: 'new' } };

      const result = configDiffService.compare(baseline, current);
      const change = result.changes.find(c => c.path.toString() === 'config,api_key');

      expect(change?.severity).toBe('critical');
    });
  });

  describe('edge cases', () => {
    it('should handle arrays with different order', () => {
      const baseline = { items: [1, 2, 3] };
      const current = { items: [3, 2, 1] };

      const result = configDiffService.compare(baseline, current);

      expect(result.summary.modified).toBe(2); // Only indices 0 and 2 are modified, index 1 is same
    });

    it('should handle arrays of objects', () => {
      const baseline = { items: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] };
      const current = { items: [{ id: 1, name: 'a' }, { id: 2, name: 'c' }] };

      const result = configDiffService.compare(baseline, current);

      expect(result.summary.modified).toBe(1);
      const modifiedChange = result.changes.find(c => c.path.toString() === 'items,1,name');
      expect(modifiedChange?.oldValue).toBe('b');
      expect(modifiedChange?.newValue).toBe('c');
    });

    it('should handle mixed types', () => {
      const baseline = { value: 'string' };
      const current = { value: 123 };

      const result = configDiffService.compare(baseline, current);

      expect(result.summary.modified).toBe(1);
    });
  });

  describe('performance', () => {
    it('should handle large objects efficiently', () => {
      const largeObject: Record<string, any> = {};
      for (let i = 0; i < 1000; i++) {
        largeObject[`key_${i}`] = `value_${i}`;
      }

      const baseline = { ...largeObject };
      const current = { ...largeObject, new_key: 'new_value' };

      const startTime = Date.now();
      const result = configDiffService.compare(baseline, current);
      const endTime = Date.now();

      expect(result.summary.added).toBe(1);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete in under 1 second
    });
  });
});