/**
 * DiffDetector coverage complement — cold branches of the private helpers
 * `determineSeverity` and `generateRecommendation` (#833 Epic C3).
 *
 * The base DiffDetector.test.ts (58 tests) covers the public compare paths and
 * the headline severity thresholds (system/config CRITICAL, hardware CPU 30% /
 * RAM 20%). What stays uncovered (L711-734) is the tail of `determineSeverity`
 * — the `software` → WARNING arm and the fallthrough → INFO — plus the whole
 * `generateRecommendation` switch (config/system/hardware/software/default).
 *
 * Both helpers are `private`; we reach them via `(detector as any)` (the same
 * seam po-2024 used for RooSyncService private fields). They are pure functions
 * over their args, so no mocks are needed — just input/output assertions.
 */

import { describe, it, expect } from 'vitest';
import { DiffDetector } from '../DiffDetector.js';
import type { BaselineDifference } from '../../types/baseline.js';

describe('DiffDetector — determineSeverity / generateRecommendation cold arms (#833 C3)', () => {
  const detector = new DiffDetector() as unknown as {
    determineSeverity(category: string, type: string, path: string, diffPercent: number): string;
    generateRecommendation(diff: BaselineDifference): string;
  };

  describe('determineSeverity — software + default arms', () => {
    it('software category → WARNING (regardless of path/diffPercent)', () => {
      expect(detector.determineSeverity('software', 'modified', 'apps/node', 5)).toBe('WARNING');
      expect(detector.determineSeverity('software', 'added', 'python', 99)).toBe('WARNING');
    });

    it('unknown category → INFO (default fallthrough)', () => {
      expect(detector.determineSeverity('network', 'modified', 'iface', 50)).toBe('INFO');
      expect(detector.determineSeverity('other', 'added', 'x', 0)).toBe('INFO');
    });
  });

  describe('generateRecommendation — all switch arms', () => {
    const baseDiff = {
      path: 'p',
      type: 'modified',
      description: 'd',
      baselineValue: 'a',
      actualValue: 'b',
      recommendedAction: 'act',
    } as const;

    it('config → synchroniser la configuration Roo', () => {
      const r = detector.generateRecommendation({ ...baseDiff, category: 'config' } as BaselineDifference);
      expect(r).toMatch(/Synchroniser la configuration Roo avec la baseline/i);
    });

    it('system → revue manuelle requise (critique)', () => {
      const r = detector.generateRecommendation({ ...baseDiff, category: 'system' } as BaselineDifference);
      expect(r).toMatch(/Revue manuelle/i);
    });

    it('hardware → vérifier la compatibilité matérielle', () => {
      const r = detector.generateRecommendation({ ...baseDiff, category: 'hardware' } as BaselineDifference);
      expect(r).toMatch(/compatibilité matérielle/i);
    });

    it('software → mettre à jour les logiciels', () => {
      const r = detector.generateRecommendation({ ...baseDiff, category: 'software' } as BaselineDifference);
      expect(r).toMatch(/Mettre à jour les logiciels/i);
    });

    it('default (unknown category) → synchroniser avec la baseline', () => {
      // Cast: the switch default is exercised by a category outside the 4 known
      // values; BaselineDifference.category is a closed union so we bypass TS here
      // to reach the default arm (the runtime guard it represents).
      const r = detector.generateRecommendation({ ...baseDiff, category: 'mystery' } as BaselineDifference);
      expect(r).toMatch(/Synchroniser avec la baseline/i);
    });
  });
});
