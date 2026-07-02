/**
 * #833 Sprint C3 — ConfigComparator branch coverage (po-2026 lane `src/services/roosync/**`)
 *
 * The existing `ConfigComparator.test.ts` (20 tests) covers the main paths but
 * leaves a handful of defensive / mapping branches unexercised. This add-only
 * file targets those residual branches:
 *
 * - `listDiffs` OUTER catch (L265-271): `loadBaseline()` rejection → throws
 *   `DIFF_LISTING_FAILED`. The existing "handles comparison error" test only
 *   rejects `compareWithBaseline` (per-machine inner catch L247-250), never the
 *   outer catch.
 * - `listDiffs` filter typeMap arms (L213-217): only `'config'` is exercised
 *   by the base suite; `'files'` → hardware and `'settings'` → software are
 *   uncovered.
 * - `listDiffs` dedup `machines.push` across DISTINCT machines (L233-234): the
 *   base dedup test runs a single machine, so the accumulate branch is never
 *   explicitly asserted.
 * - `compareRealConfigurations` summary `warning` severity count (L320):
 *   computed but never asserted (critical/important/info only).
 * - `compareWithProfiles` hardware-cpu exact match (L51 stringify-equal): the
 *   mirror of the roo-core match test, for the hardware-cpu extraction arm.
 *
 * NOTE (FINDING, not fixed — anti-churn #1936): the base test mocks
 * `RooSyncServiceError` from `'../../../services/RooSyncService.js'`, but the
 * source imports it from `'../../types/errors.js'` (L15) → that mock is a
 * silent no-op; the REAL class is used. This file relies on the real class
 * (asserts on message strings, robust to the stale mock) and does not modify
 * the existing test.
 *
 * Every assertion is anchored on a source line of `ConfigComparator.ts`.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ConfigComparator } from '../ConfigComparator.js';

const mockConfig = {
  machineId: 'test-machine',
  sharedPath: '/shared/path',
};

const mockBaselineService = {
  loadBaseline: vi.fn(),
  compareWithBaseline: vi.fn(),
};

describe('ConfigComparator — branch coverage (#833 C3, source-grounded)', () => {
  let comparator: ConfigComparator;

  beforeEach(() => {
    vi.clearAllMocks();
    comparator = new ConfigComparator(mockConfig as any, mockBaselineService as any);
  });

  // ── listDiffs: OUTER catch → DIFF_LISTING_FAILED (source L265-271) ──

  test('listDiffs throws DIFF_LISTING_FAILED when loadBaseline rejects (outer catch L265-271)', async () => {
    // loadBaseline rejection escapes the per-machine loop and hits the OUTER catch,
    // which re-wraps into a RooSyncServiceError with code DIFF_LISTING_FAILED.
    mockBaselineService.loadBaseline.mockRejectedValue(new Error('baseline disk read failed'));

    await expect(comparator.listDiffs()).rejects.toThrow('Erreur liste diff');
    // Sanity: the per-machine compareWithBaseline is never reached when load fails.
    expect(mockBaselineService.compareWithBaseline).not.toHaveBeenCalled();
  });

  // ── listDiffs: filter 'files' → hardware category (source L214 typeMap arm) ──

  test('listDiffs filter "files" maps to the hardware category (L214 typeMap)', async () => {
    mockBaselineService.loadBaseline.mockResolvedValue({ machineId: 'baseline-machine' });
    mockBaselineService.compareWithBaseline.mockResolvedValue({
      differences: [
        { category: 'hardware', path: '/hw/disk', description: 'hw diff', severity: 'INFO' },
        { category: 'config', path: '/cfg/mode', description: 'cfg diff', severity: 'WARNING' },
      ],
    });

    const result = await comparator.listDiffs('files');
    // typeMap['files'] === 'hardware' → only the hardware diff survives the filter.
    expect(result.totalDiffs).toBe(1);
    expect(result.diffs[0].type).toBe('hardware');
  });

  // ── listDiffs: filter 'settings' → software category (source L215 typeMap arm) ──

  test('listDiffs filter "settings" maps to the software category (L215 typeMap)', async () => {
    mockBaselineService.loadBaseline.mockResolvedValue({ machineId: 'baseline-machine' });
    mockBaselineService.compareWithBaseline.mockResolvedValue({
      differences: [
        { category: 'software', path: '/sw/node', description: 'sw diff', severity: 'WARNING' },
        { category: 'config', path: '/cfg/mode', description: 'cfg diff', severity: 'WARNING' },
      ],
    });

    const result = await comparator.listDiffs('settings');
    // typeMap['settings'] === 'software' → only the software diff survives.
    expect(result.totalDiffs).toBe(1);
    expect(result.diffs[0].type).toBe('software');
  });

  // ── listDiffs: dedup accumulates machines across DISTINCT machines (source L233-234) ──

  test('listDiffs dedup pushes the 2nd machine onto an existing diff (L233-234)', async () => {
    // baseline.machineId !== config.machineId → allMachines has TWO entries.
    // Both resolve to the SAME diff (category+path) → 2nd iteration finds existingDiff
    // and pushes its machineId onto existingDiff.machines.
    mockBaselineService.loadBaseline.mockResolvedValue({ machineId: 'baseline-machine' });
    mockBaselineService.compareWithBaseline.mockResolvedValue({
      differences: [
        { category: 'config', path: '/shared/cfg', description: 'same diff on both', severity: 'WARNING' },
      ],
    });

    const result = await comparator.listDiffs();
    // One deduped diff, but it carries BOTH machines.
    expect(result.totalDiffs).toBe(1);
    expect(result.diffs[0].machines).toEqual(
      expect.arrayContaining(['baseline-machine', 'test-machine'])
    );
    expect(result.diffs[0].machines).toHaveLength(2);
  });

  // ── compareRealConfigurations: summary.warning severity count (source L320) ──

  test('compareRealConfigurations summary counts the WARNING severity (L320)', async () => {
    mockBaselineService.loadBaseline.mockResolvedValue({});
    mockBaselineService.compareWithBaseline.mockImplementation(async (machineId: string) => ({
      differences: [
        // One WARNING per machine → summary.warning === 2
        { category: 'config', path: `/${machineId}/w`, description: 'warn', severity: 'WARNING' },
      ],
    }));

    const result = await comparator.compareRealConfigurations('source', 'target');
    expect(result).not.toBeNull();
    // L318-321: summary filters by severity; WARNING arm must tally.
    expect(result!.summary.warning).toBe(2);
    expect(result!.summary.total).toBe(2);
    // The other severity buckets stay at 0.
    expect(result!.summary.critical).toBe(0);
    expect(result!.summary.important).toBe(0);
    expect(result!.summary.info).toBe(0);
  });

  // ── compareWithProfiles: hardware-cpu exact match → no deviation (source L51 stringify-equal) ──

  test('compareWithProfiles returns no deviation when hardware-cpu matches exactly (L51)', async () => {
    const cpu = 'AMD Ryzen 9';
    const inventory = { config: { hardware: { cpu } } };
    const profiles = [{ category: 'hardware-cpu', configuration: cpu }];

    const result = comparator.compareWithProfiles(inventory, profiles as any);
    // JSON.stringify(actual) === JSON.stringify(expected) → deviation branch NOT taken.
    expect(result).toEqual([]);
  });
});
