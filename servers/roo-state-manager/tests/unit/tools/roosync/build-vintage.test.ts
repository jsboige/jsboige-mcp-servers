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
        const v = deriveBuildVintage(STAMP, new Date('2026-08-31T09:14:52.000Z'));
        expect(v.processPrecedesBuild).toBe(true);
        expect(v.processStartedAt).toBe('2026-08-31T09:14:52.000Z');
    });

    it('does not flag a process that started AFTER the build, and adds no note', () => {
        const v = deriveBuildVintage(STAMP, new Date('2026-09-01T21:52:41.000Z'));
        expect(v.processPrecedesBuild).toBe(false);
        expect(v.note).toBeUndefined();
    });

    it('names the mixed-vintage reality and never recommends a hot rebuild', () => {
        // A rebuild on a live process is worse than none: it mixes vintages and
        // arms an ESM crash on the next lazy import. The remedy is a restart.
        const note = deriveBuildVintage(STAMP, new Date('2026-08-31T09:14:52.000Z')).note ?? '';
        expect(note).toMatch(/mélange/i);
        expect(note).toMatch(/redémarrage/i);
        expect(note).toMatch(/pas un rebuild/i);
    });

    it('degrades to null — never throws — when no stamp is present', () => {
        const v = deriveBuildVintage(null, new Date('2026-09-01T21:52:41.000Z'));
        expect(v.processPrecedesBuild).toBeNull();
        expect(v.sha).toBeNull();
        expect(v.note).toMatch(/build-info\.json/);
    });

    it('degrades to null on an unparseable builtAt rather than asserting an order', () => {
        const v = deriveBuildVintage({ ...STAMP, builtAt: 'not-a-date' }, new Date());
        expect(v.processPrecedesBuild).toBeNull();
    });

    it('passes the stamp fields through verbatim', () => {
        const v = deriveBuildVintage({ ...STAMP, dirty: true }, new Date());
        expect(v.sha).toBe(STAMP.sha);
        expect(v.shortSha).toBe('9c44f633');
        expect(v.dirty).toBe(true);
        expect(v.version).toBe('1.0.14');
    });
});
