/**
 * #4293 follow-up — the fail-closed error must name the half that failed.
 *
 * Measured 30/10 (po-2027, 00:1xZ): the shared store was readable AND
 * writable (`roosync_diagnose(env)` → `sharedState: {exists: true,
 * writable: true}`) while the inbox read failed closed with an error stating
 * the store was "absent du système de fichiers" and telling the reader to
 * check the DriveFS mount. Two lanes on two seats (po-2028, po-2023) nearly
 * "repaired" a healthy directory because of it.
 *
 * The contract pinned here: the wording follows the CAUSE, and a cause that
 * is not a missing store never tells the reader to look for a missing store.
 * The legacy wording is preserved verbatim for the one case where it is true
 * (the store really is gone).
 */

import { describe, test, expect } from 'vitest';
import { SharedStoreInaccessibleError } from '../shared-state-path.js';

const PATH = 'G:\\Mon Drive\\Synchronisation\\RooSync\\.shared-state';

/** The exact phrase the defect made of every case. */
const ABSENT_PHRASE = 'absent du système de fichiers';
const MOUNT_ADVICE = 'vérifiez le montage du lecteur';

describe('SharedStoreInaccessibleError — the cause names the failing half', () => {
    test('store-absent (default) keeps the legacy wording — it is true there', () => {
        const err = new SharedStoreInaccessibleError(PATH);
        expect(err.cause).toBe('store-absent');
        expect(err.message).toContain(ABSENT_PHRASE);
        expect(err.message).toContain(MOUNT_ADVICE);
        expect(err.message).toContain('(cause=store-absent)');
        expect(err.code).toBe('ROOSYNC_STORE_INACCESSIBLE');
    });

    test('store-absent + PG read failed keeps the #4293 both-halves clause', () => {
        const err = new SharedStoreInaccessibleError(PATH, true);
        expect(err.cause).toBe('store-absent');
        expect(err.message).toContain(ABSENT_PHRASE);
        expect(err.message).toContain("La lecture PostgreSQL de secours n'a rien rendu non plus");
        expect(err.message).toContain('(cause=store-absent)');
    });

    test('pg-unavailable asserts the evidence (root present), never a negative about the mount', () => {
        const err = new SharedStoreInaccessibleError(PATH, true, 'pg-unavailable');
        expect(err.cause).toBe('pg-unavailable');
        expect(err.message).toContain('PostgreSQL');
        expect(err.message).toContain('CHANNEL_PG_PRIMARY');
        expect(err.message).not.toContain(ABSENT_PHRASE);
        expect(err.message).not.toContain(MOUNT_ADVICE);
        // 30/10 review: the probe establishes EXISTENCE, not responsiveness —
        // the wording must say exactly that, no more.
        expect(err.message).toContain('existence vérifiée');
        expect(err.message).toContain("sa réactivité n'a pas été mesurée");
        expect(err.message).not.toContain("n'est PAS en cause");
        expect(err.message).toContain('(cause=pg-unavailable)');
    });

    test('scan-lock-contended names the host scan lock, not the mount', () => {
        const err = new SharedStoreInaccessibleError(PATH, true, 'scan-lock-contended');
        expect(err.cause).toBe('scan-lock-contended');
        expect(err.message).toContain('verrou de scan G:');
        expect(err.message).not.toContain(ABSENT_PHRASE);
        expect(err.message).not.toContain(MOUNT_ADVICE);
        expect(err.message).toContain('(cause=scan-lock-contended)');
    });

    test('store-unresponsive says the volume did not answer, not that it is gone', () => {
        const err = new SharedStoreInaccessibleError(PATH, true, 'store-unresponsive');
        expect(err.cause).toBe('store-unresponsive');
        expect(err.message).toContain("n'a pas répondu dans le délai imparti");
        expect(err.message).not.toContain(ABSENT_PHRASE);
        expect(err.message).not.toContain(MOUNT_ADVICE);
        expect(err.message).toContain('(cause=store-unresponsive)');
    });

    test('an unset ROOSYNC_SHARED_PATH is reported as such, whatever the cause', () => {
        expect(new SharedStoreInaccessibleError(null).message).toContain('variable non définie');
        expect(new SharedStoreInaccessibleError(null, true, 'pg-unavailable').message).toContain(
            'variable non définie'
        );
    });

    test('the path is still carried — callers read it', () => {
        expect(new SharedStoreInaccessibleError(PATH, true, 'pg-unavailable').storePath).toBe(PATH);
    });
});
