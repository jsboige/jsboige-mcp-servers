/**
 * #3279 — Wiring guard for the leader-observability fields.
 *
 * #3014 added `is_leader` / `leader_pid` / `leader_lock_age_ms` to the
 * `roosync_indexing(status)` output so a healthy follower (queue plateau is
 * normal — the drain is carried by the leader elsewhere on this machine) is
 * distinguishable from a blocked leader. The tool reads them off its 8th
 * argument through casts:
 *
 *     const leaderMachineId = (state as { machineId?: string }).machineId;
 *     const isLeader = (state as { isIndexLeader?: boolean }).isIndexLeader === true;
 *
 * A cast ASSERTS a shape; it does not CHECK one. The production call site in
 * registry.ts builds an explicit object literal, and it never supplied those
 * two fields — while the parameter's declared type (`IndexingState`) is the
 * per-task shape that contains neither. So nothing could flag the omission at
 * either end, and the feature was dead in production from the day it shipped:
 *
 *   - `is_leader` was `undefined === true` → **false on every machine**, the
 *     leader included. No process could ever report itself as leader.
 *   - `leader_pid` / `leader_lock_age_ms` → null (the read short-circuits on a
 *     falsy machineId), and the explanatory follower hint never fired.
 *
 * Measured on ai-01 on 2026-08-27: a live leader lock
 * (roosync-indexer-leader-myia-ai-01.lock, PID 38276, renewed 1.3 min earlier,
 * process up 38.5h) rendered as `is_leader:false, leader_pid:null` — byte for
 * byte what "there is no leader at all" renders as. po-2025 read that same
 * output 20 minutes later and concluded "this process is a follower"; that
 * reading was not available from the data.
 *
 * WHY THIS TEST READS SOURCE TEXT INSTEAD OF CALLING THE TOOL: the #3014 unit
 * tests in roosync-indexing.tool.test.ts pass `machineId` and `isIndexLeader`
 * in their own state literal. They were green for the whole lifetime of the
 * defect, because they prove the tool RENDERS the fields it is handed — never
 * that the wiring DELIVERS them. A test that calls the handler with a literal
 * cannot, by construction, catch a call site that omits a field. So this one
 * asserts the call site itself, the way the PowerShell harnesses under
 * scripts/testing/harness/ assert production scripts they cannot execute.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const registrySource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../registry.ts'),
    'utf-8'
);

/** The `case 'roosync_indexing':` block, up to the `break;` that closes it. */
function roosyncIndexingCaseBlock(): string {
    const start = registrySource.indexOf("case 'roosync_indexing':");
    expect(start, "case 'roosync_indexing' not found in registry.ts").toBeGreaterThan(-1);
    const end = registrySource.indexOf('break;', start);
    expect(end, "no break; closing the roosync_indexing case").toBeGreaterThan(start);
    return registrySource.slice(start, end);
}

describe('#3279 registry wiring — roosync_indexing state literal', () => {
    test('supplies machineId (without it, leader_pid/lock age are null on every machine)', () => {
        expect(roosyncIndexingCaseBlock()).toMatch(/machineId:\s*state\.machineId/);
    });

    test('supplies isIndexLeader (without it, is_leader is `undefined === true` → constant false)', () => {
        expect(roosyncIndexingCaseBlock()).toMatch(/isIndexLeader:\s*state\.isIndexLeader/);
    });

    test('both fields land inside the state literal, not merely somewhere in the case', () => {
        // Guards against a future refactor that keeps the identifiers alive in
        // the case block (a log line, a comment made executable) while dropping
        // them from the object actually handed to the handler.
        const block = roosyncIndexingCaseBlock();
        const literalStart = block.indexOf('qdrantIndexQueue: state.qdrantIndexQueue');
        expect(literalStart, 'state literal not found in the case block').toBeGreaterThan(-1);
        const literal = block.slice(literalStart);
        expect(literal).toMatch(/machineId:\s*state\.machineId/);
        expect(literal).toMatch(/isIndexLeader:\s*state\.isIndexLeader/);
    });
});

describe('#3279 ServerState still carries what the wiring forwards', () => {
    // The wiring above is only meaningful while ServerState actually holds these
    // two fields. If they are renamed or moved, `state.machineId` becomes a
    // compile error and this pairing is what says why.
    const stateSource = readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../services/state-manager.service.ts'),
        'utf-8'
    );

    test('declares machineId and isIndexLeader', () => {
        expect(stateSource).toMatch(/machineId:\s*string;/);
        expect(stateSource).toMatch(/isIndexLeader:\s*boolean;/);
    });

    test('initialises machineId to a non-empty value (a falsy id disables the lock read)', () => {
        // `getLeaderLockPath` tolerates an empty id (`machineId || 'local'`), but
        // the status tool's guard short-circuits on falsy — so an empty machineId
        // silently reproduces the exact defect this file exists to prevent.
        expect(stateSource).toMatch(/machineId:\s*rooSyncCfg\?\.machineId\s*\?\?[^\n]*\|\|\s*'local'/);
    });
});
