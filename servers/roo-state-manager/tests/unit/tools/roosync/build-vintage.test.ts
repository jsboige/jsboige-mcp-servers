/**
 * Tests for the build-vintage stamp exposed by roosync_diagnose (action=env).
 *
 * Why this exists: the MCP server is a stdio child (one process per session)
 * and a process loads its modules once. A long-lived session keeps serving the
 * build it started with, so a defect observed from it may already be fixed on
 * disk. Without a vintage stamp, that false bug report is indistinguishable
 * from a real one — the coordinator reproduced #3351 from a process ~18 h
 * older than the commit that fixed it, while two other machines saw the fix
 * working (2026-09-02).
 */

import { describe, it, expect } from 'vitest';
import { deriveBuildVintage } from '../../../../src/tools/roosync/diagnose.js';

const STAMP = {
    sha: '9c44f633604ec37ff707dff8d29846780442dcce',
    shortSha: '9c44f633',
    dirty: false,
    builtAt: '2026-09-01T19:42:27.000Z',
    version: '1.0.14',
};

describe('deriveBuildVintage', () => {
    it('flags a process that started BEFORE the on-disk build', () => {
        const v = deriveBuildVintage(STAMP, new Date('2026-08-31T09:14:52.000Z'), STAMP.sha);
        expect(v.processPrecedesBuild).toBe(true);
        expect(v.processStartedAt).toBe('2026-08-31T09:14:52.000Z');
    });

    it('does not flag a process that started AFTER the build, and adds no note', () => {
        const v = deriveBuildVintage(STAMP, new Date('2026-09-01T21:52:41.000Z'), STAMP.sha);
        expect(v.processPrecedesBuild).toBe(false);
        expect(v.note).toBeUndefined();
    });

    it('names the mixed-vintage reality and never recommends a hot rebuild', () => {
        // A rebuild on a live process is worse than none: it mixes vintages and
        // arms an ESM crash on the next lazy import. The remedy is a restart.
        const note = deriveBuildVintage(STAMP, new Date('2026-08-31T09:14:52.000Z'), STAMP.sha).note ?? '';
        expect(note).toMatch(/mélange/i);
        expect(note).toMatch(/redémarrage/i);
        expect(note).toMatch(/pas un rebuild/i);
    });

    it('degrades to null — never throws — when no stamp is present', () => {
        const v = deriveBuildVintage(null, new Date('2026-09-01T21:52:41.000Z'), STAMP.sha);
        expect(v.processPrecedesBuild).toBeNull();
        expect(v.sha).toBeNull();
        expect(v.note).toMatch(/build-info\.json/);
    });

    it('degrades to null on an unparseable builtAt rather than asserting an order', () => {
        const v = deriveBuildVintage({ ...STAMP, builtAt: 'not-a-date' }, new Date(), STAMP.sha);
        expect(v.processPrecedesBuild).toBeNull();
    });

    it('never leaves a bare null: an unreadable builtAt still gets an explanation', () => {
        // A null without a reason is the very failure mode this tool removes.
        // Caught in review of #1076 (Hermes): the note branch covered only a
        // missing file, not a present-but-unparseable stamp.
        const v = deriveBuildVintage({ ...STAMP, builtAt: 'not-a-date' }, new Date(), STAMP.sha);
        expect(v.note).toMatch(/indéterminé/i);
        expect(v.note).toContain('not-a-date');
    });

    it('explains a stamp whose builtAt is absent altogether', () => {
        const v = deriveBuildVintage({ ...STAMP, builtAt: null }, new Date(), STAMP.sha);
        expect(v.processPrecedesBuild).toBeNull();
        expect(v.note).toMatch(/indéterminé/i);
    });

    it('passes the stamp fields through verbatim', () => {
        const v = deriveBuildVintage({ ...STAMP, dirty: true }, new Date(), STAMP.sha);
        expect(v.sha).toBe(STAMP.sha);
        expect(v.shortSha).toBe('9c44f633');
        expect(v.dirty).toBe(true);
        expect(v.version).toBe('1.0.14');
    });
});

/**
 * Second question, orthogonal to the first: the binary may be older than the
 * SOURCE, whatever its relation to the process.
 *
 * This is not a corner case — it is the fleet's normal state. The standing ESM
 * instruction is "pull + submodule update, never rebuild", so every machine's
 * `build/` drifts behind its checkout by design. Measured on myia-ai-01
 * (2026-09-02): stamp 9c44f633, source HEAD 6b35caff — one commit behind, and
 * that commit was #1076 itself, the very feature doing the reporting.
 */
describe('deriveBuildVintage — build vs source', () => {
    const SOURCE_AHEAD = '6b35caff3dce043b48956bfa4f0849b02d13290a';

    it('confirms a binary compiled from the source in place', () => {
        const v = deriveBuildVintage(STAMP, new Date('2026-09-01T21:52:41.000Z'), STAMP.sha);
        expect(v.buildMatchesSource).toBe(true);
        expect(v.sourceSha).toBe(STAMP.sha);
        expect(v.sourceNote).toBeUndefined();
    });

    it('reports a source that moved ahead of the binary, naming both vintages', () => {
        const v = deriveBuildVintage(STAMP, new Date('2026-09-01T21:52:41.000Z'), SOURCE_AHEAD);
        expect(v.buildMatchesSource).toBe(false);
        expect(v.sourceNote).toContain('9c44f633');
        expect(v.sourceNote).toContain('6b35caff');
    });

    it('does not let a fresh process on a stale build read as up to date', () => {
        // The trap this closes: `processPrecedesBuild: false` answers only
        // "am I older than the binary?". It says nothing about whether the
        // binary carries the fix you just merged.
        const v = deriveBuildVintage(STAMP, new Date('2026-09-02T06:20:51.000Z'), SOURCE_AHEAD);
        expect(v.processPrecedesBuild).toBe(false);
        expect(v.note).toBeUndefined();
        expect(v.sourceNote).toMatch(/absent du binaire/i);
    });

    it('keeps the two verdicts separate when both are bad', () => {
        // Folding them into one string would drop a signal.
        const v = deriveBuildVintage(STAMP, new Date('2026-08-31T09:14:52.000Z'), SOURCE_AHEAD);
        expect(v.processPrecedesBuild).toBe(true);
        expect(v.note).toMatch(/mélange/i);
        expect(v.sourceNote).toMatch(/sans recompilation/i);
    });

    it('still refuses to prescribe a bare hot rebuild when the source is ahead', () => {
        const note = deriveBuildVintage(STAMP, new Date(), SOURCE_AHEAD).sourceNote ?? '';
        expect(note).toMatch(/redémarrage/i);
        expect(note).toMatch(/jamais un rebuild seul/i);
    });

    it('explains a stamp written outside a build instead of leaving a bare null', () => {
        // The stamp script now refuses to name a commit it did not compile.
        const v = deriveBuildVintage({ ...STAMP, sha: null, shortSha: null }, new Date(), SOURCE_AHEAD);
        expect(v.buildMatchesSource).toBeNull();
        expect(v.sourceNote).toMatch(/sans SHA/i);
    });

    it('explains an unreadable source SHA instead of leaving a bare null', () => {
        const v = deriveBuildVintage(STAMP, new Date(), null);
        expect(v.buildMatchesSource).toBeNull();
        expect(v.sourceNote).toMatch(/indéterminable/i);
    });
});
