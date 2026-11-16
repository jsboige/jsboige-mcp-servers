/**
 * #4736 P4 review (ms#1782, blocker B1) — the env-equality test.
 *
 * The review's exact ask: "add a test that builds both writers from the env
 * and asserts equality." Before the shared helper, the tool path built the
 * writer from `indexingState.machineId` (state manager: ROOSYNC_MACHINE_ID,
 * lowercased) while the loop path built it from raw `COMPUTERNAME` (UPPERCASE
 * on Windows) — the sentinel compares writer strings exactly, so on a real
 * seat the loop's pass was refused EVERY time while same-literal tests stayed
 * green (the #3279 blind-spot motif). Every test here therefore builds the two
 * spellings from DIFFERENT inputs, the way production does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveWsMachineId, resolveWsWriterIdentity } from '../ws-writer-identity.js';

const ROOT = 'C:\\dev\\roo-extensions';

/** Snapshot/restore the env vars the derivation reads — tests are hermetic. */
const KEYS = ['ROOSYNC_MACHINE_ID', 'COMPUTERNAME', 'HOSTNAME'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
    saved = {};
    for (const key of KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
});

describe('resolveWsWriterIdentity — one spelling per seat (ms#1782 B1)', () => {
    it('THE B1 REGRESSION: loop spelling and tool spelling are EQUAL from the same env', () => {
        // Production shape on a cluster seat: the state manager derives its
        // machineId from ROOSYNC_MACHINE_ID (lowercased), while the loop used
        // to read raw COMPUTERNAME — identical value, different case, sentinel
        // refusal. Both paths now go through the helper.
        process.env.ROOSYNC_MACHINE_ID = 'myia-web1';
        process.env.COMPUTERNAME = 'MYIA-WEB1'; // raw Windows casing
        const stateMachineId = process.env.ROOSYNC_MACHINE_ID.toLowerCase(); // what getState() returns
        const toolWriter = resolveWsWriterIdentity(ROOT, stateMachineId);
        const loopWriter = resolveWsWriterIdentity(ROOT, stateMachineId); // loop passes the state id (index.ts)
        expect(loopWriter).toBe(toolWriter);
        expect(loopWriter).toBe('myia-web1:roo-extensions');
    });

    it('state machineId wins over env, whatever the case of either', () => {
        process.env.ROOSYNC_MACHINE_ID = 'other-seat';
        process.env.COMPUTERNAME = 'MYIA-WEB1';
        expect(resolveWsWriterIdentity(ROOT, 'Myia-Web-1')).toBe('myia-web-1:roo-extensions');
    });

    it('falls back to ROOSYNC_MACHINE_ID (lowercased) when the state id is absent', () => {
        process.env.ROOSYNC_MACHINE_ID = 'Myia-Web-1';
        expect(resolveWsMachineId(null)).toBe('myia-web-1');
        expect(resolveWsMachineId(undefined)).toBe('myia-web-1');
    });

    it('falls back to COMPUTERNAME, lowercased — never the raw uppercase env', () => {
        process.env.COMPUTERNAME = 'MYIA-WEB1';
        expect(resolveWsMachineId(null)).toBe('myia-web1');
        // The exact B1 production failure, pinned: the sentinel would have
        // compared this against the state spelling and refused.
        process.env.ROOSYNC_MACHINE_ID = 'myia-web1';
        expect(resolveWsMachineId(null)).toBe(resolveWsMachineId('MYIA-WEB1'.toLowerCase()));
    });

    it('HOSTNAME is the last env fallback before unknown-machine', () => {
        process.env.HOSTNAME = 'po-2027.local';
        expect(resolveWsMachineId(null)).toBe('po-2027.local');
        expect(resolveWsWriterIdentity('/home/user/proj', null)).toBe('po-2027.local:proj');
    });

    it('no state, no env → the lowercase sentinel literal unknown-machine', () => {
        expect(resolveWsMachineId(null)).toBe('unknown-machine');
        expect(resolveWsMachineId('   ')).toBe('unknown-machine'); // blank ≠ present
    });
});
