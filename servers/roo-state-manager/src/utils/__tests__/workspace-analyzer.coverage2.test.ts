/**
 * Coverage gap-complement for workspace-analyzer.ts.
 *
 * Baseline (post workspace-analyzer.test.ts + workspace-analyzer-coverage.test.ts
 * from #1786): 96.97% stmts / 93.06% branches. Two cold spots remain; both
 * covered here via direct private-static calls (`(WorkspaceAnalyzer as any)`).
 *
 * Anchored on source lines:
 *   - areSimilarPrefixes L312-316 nested-prefix `||` — both arms:
 *       * L313 first arm true (prefix1.startsWith(prefix2) short-circuits)
 *       * L314 second arm (first false, prefix2.startsWith(prefix1) true)
 *       * Both-false fall-through already covered by existing suite.
 *     Reached only when prefixes have DIFFERENT roots (L308 same-root guard
 *     short-circuits otherwise) — on Windows path.sep='\\', so '/'-delimited
 *     prefixes split to single-element arrays with differing [0].
 *   - generateWorkspaceName L420-421 `parts.length === 0` -> 'Root Workspace'
 *     (empty/sep-only path splits+filters to []).
 *
 * Discipline: 0 source touched (#1936). No overlap — existing suites use public
 * API only; these cold branches need crafted-string private calls.
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkspaceAnalyzer } from '../workspace-analyzer.js';
import { WorkspaceDetectionError } from '../../types/task-tree.js';

describe('WorkspaceAnalyzer — coverage gap-complement (cold branches)', () => {
    const WA = WorkspaceAnalyzer as any;

    // ─── areSimilarPrefixes L312-316: nested-prefix `||` both arms ───

    it('areSimilarPrefixes: prefix1 starts with prefix2 → first arm true (short-circuit)', () => {
        // Different roots (so the same-root guard L308 does NOT short-circuit),
        // then prefix1.startsWith(prefix2) is true.
        // path.sep on Windows is '\\' — '/'-delimited strings split to single
        // elements, so parts1[0]='/foo/bar' !== parts2[0]='/foo'.
        expect(WA.areSimilarPrefixes('/foo/bar', '/foo')).toBe(true);
    });

    it('areSimilarPrefixes: prefix2 starts with prefix1 → second arm (first false, second true)', () => {
        // prefix1.startsWith(prefix2) = '/foo'.startsWith('/foo/bar') = false
        // → evaluates second arm: prefix2.startsWith(prefix1) = true.
        expect(WA.areSimilarPrefixes('/foo', '/foo/bar')).toBe(true);
    });

    it('areSimilarPrefixes: neither nested → returns false (both arms false)', () => {
        // Sanity: confirms the fall-through past the `||` (distinct from same-root true).
        expect(WA.areSimilarPrefixes('/alpha', '/beta/gamma')).toBe(false);
    });

    // ─── generateWorkspaceName L420-421: empty parts → 'Root Workspace' ───

    it('generateWorkspaceName: sep-only path → empty parts → "Root Workspace"', () => {
        // path.sep on Windows is '\\'. A path of just the sep (or empty) splits
        // to [''] or ['',''] → filter(Boolean) removes empties → [] → length 0.
        const sep = require('path').sep;
        expect(WA.generateWorkspaceName(sep)).toBe('Root Workspace');
    });

    it('generateWorkspaceName: empty string → empty parts → "Root Workspace"', () => {
        expect(WA.generateWorkspaceName('')).toBe('Root Workspace');
    });

    it('generateWorkspaceName: normal path → last segment, beautified (no L420 fallback)', () => {
        // Confirm the L420 arm is NOT hit for a real path. The method beautifies
        // the last segment (title-case + dash-to-space): 'my-app' -> 'My App'.
        const sep = require('path').sep;
        expect(WA.generateWorkspaceName(`projects${sep}my-app`)).toBe('My App');
    });

    // ─── calculatePrefixConfidence L296-298: depth > 3 malus ───

    it('calculatePrefixConfidence: deep prefix (depth > 3) → applies malus, clamps to [0,1]', () => {
        // path.sep on Windows is '\\'. A 4-segment prefix → depth 4 > 3 → malus.
        const sep = require('path').sep;
        const deepPrefix = ['a', 'b', 'c', 'd'].join(sep);
        // CommonPrefix needs `paths` + `count` (read before the depth check).
        const result = WA.calculatePrefixConfidence({
            prefix: deepPrefix,
            paths: [`${deepPrefix}${sep}file.ts`],
            count: 1,
        });
        expect(typeof result).toBe('number');
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
    });

    // ─── analyzeWorkspaces L113-116: outer catch → WorkspaceDetectionError ───

    it('analyzeWorkspaces: internal failure → wrapped in WorkspaceDetectionError (catch L113)', async () => {
        // Inject a throw in a private sub-method so the orchestration's outer
        // try/catch fires.
        const spy = vi
            .spyOn(WA, 'extractFilePatterns')
            .mockImplementationOnce(() => {
                throw new Error('injected');
            });

        await expect(WA.analyzeWorkspaces([])).rejects.toThrow(WorkspaceDetectionError);

        spy.mockRestore();
    });

    it('analyzeWorkspaces: non-Error throw → String(error) arm of message (L114)', async () => {
        // Throwing a non-Error value exercises the `String(error)` branch of the
        // ternary (the `error instanceof Error` arm is covered by the test above).
        const spy = vi
            .spyOn(WA, 'extractFilePatterns')
            .mockImplementationOnce(() => {
                // eslint-disable-next-line no-throw-literal
                throw 'string error';
            });

        await expect(WA.analyzeWorkspaces([])).rejects.toThrow(WorkspaceDetectionError);

        spy.mockRestore();
    });
});
