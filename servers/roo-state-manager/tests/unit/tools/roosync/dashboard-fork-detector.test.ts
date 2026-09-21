/**
 * #3482-follow — enumeration-side fork detection (`action:"list"`).
 *
 * The write-side guard of #3482 only fires once a write has been deviated.
 * These tests pin the enumeration-side predicate, whose main risk is not a
 * missed fork but a FALSE POSITIVE: `workspace-CoursIA-1` / `-2` / `-3` are
 * distinct dashboards that really exist in the fleet store (measured po-2024,
 * 2026-09-21) and a detector that flagged them would teach operators to ignore
 * the warning.
 */
import { describe, it, expect } from 'vitest';
import {
  detectDashboardForks,
} from '../../../../src/tools/roosync/dashboard.js';
import {
  isGdriveConflictCopyFile,
  canonicalKeyOfFork,
} from '../../../../src/services/unified-store/roosync-dashboard-reconcile.js';

describe('isGdriveConflictCopyFile', () => {
  it('accepts a bare key and a filename alike', () => {
    expect(isGdriveConflictCopyFile('workspace-CoursIA (2)')).toBe(true);
    expect(isGdriveConflictCopyFile('workspace-CoursIA (2).md')).toBe(true);
  });

  it('requires the space-paren-number suffix — hyphenated lookalikes are NOT forks', () => {
    expect(isGdriveConflictCopyFile('workspace-CoursIA-2')).toBe(false);
    expect(isGdriveConflictCopyFile('workspace-CoursIA-1')).toBe(false);
    expect(isGdriveConflictCopyFile('workspace-CoursIA')).toBe(false);
    expect(isGdriveConflictCopyFile('workspace-CoursIA (x)')).toBe(false);
    expect(isGdriveConflictCopyFile('workspace-CoursIA (2) x')).toBe(false);
  });

  it('accepts a nested collision marker', () => {
    expect(isGdriveConflictCopyFile('workspace-CoursIA (1) (1)')).toBe(true);
  });
});

describe('canonicalKeyOfFork', () => {
  it('strips one marker', () => {
    expect(canonicalKeyOfFork('workspace-CoursIA (2)')).toBe('workspace-CoursIA');
  });

  it('strips nested markers down to the root', () => {
    expect(canonicalKeyOfFork('workspace-CoursIA (1) (1)')).toBe('workspace-CoursIA');
    expect(canonicalKeyOfFork('machine-myia-po-2025 (1)')).toBe('machine-myia-po-2025');
  });

  it('is identity on a canonical key', () => {
    expect(canonicalKeyOfFork('workspace-CoursIA')).toBe('workspace-CoursIA');
    expect(canonicalKeyOfFork('workspace-CoursIA-2')).toBe('workspace-CoursIA-2');
  });
});

describe('detectDashboardForks', () => {
  it('returns nothing on a clean store', () => {
    expect(detectDashboardForks(['global', 'workspace-CoursIA', 'machine-myia-po-2024'])).toEqual([]);
    expect(detectDashboardForks([])).toEqual([]);
  });

  it('groups a fork with its canonical', () => {
    expect(detectDashboardForks(['workspace-CoursIA', 'workspace-CoursIA (2)'])).toEqual([
      { canonical: 'workspace-CoursIA', canonicalPresent: true, forks: ['workspace-CoursIA (2)'] }
    ]);
  });

  it('collapses a nested collision into the same family', () => {
    const groups = detectDashboardForks([
      'workspace-CoursIA',
      'workspace-CoursIA (1)',
      'workspace-CoursIA (1) (1)',
      'workspace-CoursIA (2)'
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].canonical).toBe('workspace-CoursIA');
    expect(groups[0].forks).toEqual([
      'workspace-CoursIA (1)',
      'workspace-CoursIA (1) (1)',
      'workspace-CoursIA (2)'
    ]);
  });

  it('reports a missing canonical rather than hiding the family', () => {
    expect(detectDashboardForks(['workspace-CoursIA (2)'])).toEqual([
      { canonical: 'workspace-CoursIA', canonicalPresent: false, forks: ['workspace-CoursIA (2)'] }
    ]);
  });

  it('keeps distinct families apart and sorts them', () => {
    expect(
      detectDashboardForks([
        'workspace-CoursIA (2)',
        'machine-myia-po-2025 (1)',
        'workspace-CoursIA',
        'machine-myia-po-2025'
      ])
    ).toEqual([
      { canonical: 'machine-myia-po-2025', canonicalPresent: true, forks: ['machine-myia-po-2025 (1)'] },
      { canonical: 'workspace-CoursIA', canonicalPresent: true, forks: ['workspace-CoursIA (2)'] }
    ]);
  });

  /**
   * Real key set measured on po-2024 the day the detector was written: 5 forked
   * keys among 72 dashboards, including a nested one and a family whose
   * canonical is present. Anchors the detector against the shape actually met
   * in the fleet, not a shape invented for the test.
   */
  it('matches the measured fleet shape without false positives', () => {
    const measured = [
      'global', 'machine-myia-ai-01', 'machine-myia-po-2023', 'machine-myia-po-2024',
      'machine-myia-po-2025', 'machine-myia-po-2025 (1)', 'machine-myia-po-2026',
      'machine-myia-po-2027', 'machine-myia-web1', 'machine-po-2026',
      'workspace-CoursIA', 'workspace-CoursIA (1)', 'workspace-CoursIA (1) (1)',
      'workspace-CoursIA (2)', 'workspace-CoursIA-1', 'workspace-CoursIA-2',
      'workspace-CoursIA-3', 'workspace-CoursIA-issue-debt-ledger',
      'workspace-roo-extensions', 'workspace-claudish'
    ];
    const groups = detectDashboardForks(measured);
    expect(groups).toEqual([
      { canonical: 'machine-myia-po-2025', canonicalPresent: true, forks: ['machine-myia-po-2025 (1)'] },
      {
        canonical: 'workspace-CoursIA',
        canonicalPresent: true,
        forks: ['workspace-CoursIA (1)', 'workspace-CoursIA (1) (1)', 'workspace-CoursIA (2)']
      }
    ]);
    // The three hyphenated siblings must never appear in a fork family.
    const flagged = groups.flatMap(g => [g.canonical, ...g.forks]);
    expect(flagged).not.toContain('workspace-CoursIA-1');
    expect(flagged).not.toContain('workspace-CoursIA-2');
    expect(flagged).not.toContain('workspace-CoursIA-3');
  });
});
