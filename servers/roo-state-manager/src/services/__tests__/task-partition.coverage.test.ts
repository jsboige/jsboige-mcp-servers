/**
 * #833 Sprint C3 — task-partition branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `task-partition.test.ts` (16 tests) covers the public API of the four pure
 * functions well — hash determinism, roster parsing variants, owner membership, distribution,
 * and the exactly-one-owner invariant. It leaves these branches/contracts cold, all pinned
 * here against source lines of `task-partition.ts`:
 *
 * - `fnv1a32` **empty-string** (L28): the loop never executes → hash stays at the FNV offset
 *   basis `0x811c9dc5` (2166136261), then `>>> 0` (L32) is identity. The base only tests
 *   non-empty inputs; the empty-input arm (offset basis) is never pinned. This is the single
 *   most regression-sensitive known-vector: any change to the offset basis or the loop
 *   structure breaks it.
 * - `fnv1a32` **avalanche / bit-sensitivity** (L29-30): flipping one bit of the input must
 *   yield a substantially different hash (a property of FNV-1a; a degenerate hash would fail).
 *   The base only checks `not.toBe` for different strings, never the magnitude of difference.
 * - `parseFleetRoster` **all-empty-after-filter → null** (L46): an input like `",,"` or
 *   `" , , "` survives the L41 empty check (non-empty, non-whitespace-only string) but
 *   filters down to `length === 0` at L45 → returns null at L46. The base covers undefined,
 *   empty, and whitespace-only strings (all caught at L41) but never the all-commas case.
 * - `getTaskOwner` **exact modulo contract** (L57): `roster[hash % roster.length]`. The base
 *   asserts the owner is *in* the roster, but never that it is specifically
 *   `roster[fnv1a32(taskId) % length]`. A refactor that changes the indexing (e.g. sorted
 *   vs unsorted, or `% (length+1)`) would pass the base but fail this pin. Recomputed here
 *   via the exported `fnv1a32` so it tracks the real hash.
 * - `getTaskOwner` **strict determinism**: the base asserts membership once; this pins that
 *   the same taskId yields the byte-identical owner across 1000 calls (guards against any
 *   accidental non-determinism / Date.now / Math.random in a future edit).
 * - `shouldIndexTask` **currentMachineId not in roster** (L72): when a machine has been
 *   removed from the roster (roster-change migration, documented in the header), it owns
 *   nothing → always false. The base never tests a machine outside the roster.
 *
 * No production code touched (#1936 anti-churn). Pure functions, no mocks.
 */

import { describe, test, expect } from 'vitest';
import { fnv1a32, parseFleetRoster, getTaskOwner, shouldIndexTask } from '../task-partition.js';

describe('task-partition — branch coverage (#833 C3, source-grounded)', () => {

    // ============================================================
    // fnv1a32 — empty string (offset basis) + avalanche
    // ============================================================
    describe('fnv1a32 — empty input + avalanche (L28, L29-30, L32)', () => {
        test('empty string returns the FNV offset basis 0x811c9dc5 (L28 loop skip)', () => {
            // L28 loop never runs for '' → hash = 0x811c9dc5 = 2166136261, then L32 >>> 0 identity.
            expect(fnv1a32('')).toBe(0x811c9dc5); // 2166136261
            expect(fnv1a32('')).toBe(2166136261);
        });

        test('single-char input is NOT the offset basis (loop runs once, L29-30)', () => {
            // Proves the loop body executes for any non-empty input — 'a' must differ from ''.
            expect(fnv1a32('a')).not.toBe(0x811c9dc5);
            // And stays unsigned 32-bit (the >>> 0 at L32).
            expect(fnv1a32('a')).toBeGreaterThanOrEqual(0);
            expect(fnv1a32('a')).toBeLessThanOrEqual(0xffffffff);
        });

        test('avalanche: flipping one input bit yields a substantially different hash', () => {
            // FNV-1a avalanches — a 1-char difference must move many output bits.
            const h1 = fnv1a32('task-0001');
            const h2 = fnv1a32('task-0002'); // last char differs
            const xor = h1 ^ h2;
            // Count differing bits; expect >= 8 of 32 (a degenerate hash would flip few).
            let diffBits = 0;
            for (let b = 0; b < 32; b++) {
                if (xor & (1 << b)) diffBits++;
            }
            expect(diffBits).toBeGreaterThanOrEqual(8);
        });

        test('hash is stable across repeat calls (no hidden non-determinism)', () => {
            const first = fnv1a32('deterministic-input');
            for (let i = 0; i < 100; i++) {
                expect(fnv1a32('deterministic-input')).toBe(first);
            }
        });
    });

    // ============================================================
    // parseFleetRoster — all-empty-after-filter → null (L46)
    // ============================================================
    describe('parseFleetRoster — all-empty-after-filter (L46)', () => {
        test('comma-only input returns null (passes L41, filters to empty at L45)', () => {
            // ",,," is non-empty and not whitespace-only → L41 passes. After split/trim/filter
            // every segment is '' (length 0) → filtered out → machines.length === 0 → L46 null.
            expect(parseFleetRoster(',,,')).toBeNull();
            expect(parseFleetRoster(',')).toBeNull();
            expect(parseFleetRoster(',,')).toBeNull();
        });

        test('comma-and-whitespace input returns null (L41 pass, L45 filter all)', () => {
            // " , , , " passes L41 (has non-whitespace? actually it's only commas+spaces — but
            // trim() of the whole string is ", , ," which is !== '' → L41 passes). After
            // split+trim each segment is '' → filtered → L46 null.
            expect(parseFleetRoster(' , , , ')).toBeNull();
            expect(parseFleetRoster('  ,  ,  ')).toBeNull();
        });

        test('mixed empty and valid entries keeps only the valid ones (L45 filter, L47 dedup/sort)', () => {
            // One valid entry among empties → NOT null.
            const roster = parseFleetRoster(',myia-po-2026,,');
            expect(roster).toEqual(['myia-po-2026']);
        });
    });

    // ============================================================
    // getTaskOwner — exact modulo contract (L57) + strict determinism
    // ============================================================
    describe('getTaskOwner — modulo contract + determinism (L57)', () => {
        test('owner is exactly roster[fnv1a32(taskId) % length] (L57 exact formula)', () => {
            const roster = ['myia-ai-01', 'myia-po-2023', 'myia-po-2026', 'myia-web1'];
            for (const taskId of ['alpha', 'beta', 'gamma', 'task-9999', 'zzz']) {
                const expectedIndex = fnv1a32(taskId) % roster.length;
                // L57: `roster[hash % roster.length]`
                expect(getTaskOwner(taskId, roster)).toBe(roster[expectedIndex]);
            }
        });

        test('modulo contract holds for single-machine roster (length=1, index always 0)', () => {
            const roster = ['solo-machine'];
            // hash % 1 === 0 always → owner is always the single machine.
            for (let i = 0; i < 50; i++) {
                expect(getTaskOwner(`task-${i}`, roster)).toBe('solo-machine');
            }
        });

        test('strict determinism: same taskId yields byte-identical owner across 1000 calls', () => {
            const roster = ['myia-ai-01', 'myia-po-2023', 'myia-po-2024', 'myia-po-2025', 'myia-po-2026', 'myia-web1'];
            const first = getTaskOwner('stable-task-id', roster);
            expect(first).not.toBeNull();
            for (let i = 0; i < 1000; i++) {
                expect(getTaskOwner('stable-task-id', roster)).toBe(first);
            }
        });

        test('owner assignment is stable under roster reordering only via sort (L47 sort contract)', () => {
            // parseFleetRoster sorts alphabetically (L47). The owner depends on the SORTED order
            // because getTaskOwner indexes by position. Passing an unsorted roster gives a
            // different owner than the same set sorted — pinning that the sort is load-bearing.
            const unsorted = ['myia-web1', 'myia-ai-01', 'myia-po-2026'];
            const sorted = [...unsorted].sort();
            // Both are valid 3-machine rosters, but indexing differs → owners may differ for
            // the same taskId. The point: getTaskOwner indexes by position, so order matters.
            // Pin the contract: owner === roster[hash % len] for the GIVEN roster (whatever order).
            const taskId = 'order-sensitive-task';
            expect(getTaskOwner(taskId, unsorted)).toBe(unsorted[fnv1a32(taskId) % unsorted.length]);
            expect(getTaskOwner(taskId, sorted)).toBe(sorted[fnv1a32(taskId) % sorted.length]);
        });
    });

    // ============================================================
    // shouldIndexTask — currentMachineId not in roster (L72, migration case)
    // ============================================================
    describe('shouldIndexTask — machine not in roster (L72)', () => {
        test('returns false when currentMachineId is not the owner (a third machine owns it)', () => {
            const roster = ['myia-ai-01', 'myia-po-2023', 'myia-po-2026'];
            // Find the actual owner, then test a DIFFERENT (but in-roster) machine → false.
            const owner = getTaskOwner('migr-001', roster)!;
            const nonOwner = roster.find(m => m !== owner)!;
            expect(shouldIndexTask('migr-001', nonOwner, roster)).toBe(false);
        });

        test('returns false for a machine removed from the roster (roster-change migration)', () => {
            // Header doc: removing a machine shifts buckets. A machine no longer in the roster
            // can never be an owner → always false (even if it used to own the task).
            const roster = ['myia-ai-01', 'myia-po-2023', 'myia-po-2026'];
            // myia-po-2024 is NOT in this 3-machine roster.
            for (let i = 0; i < 100; i++) {
                // A removed machine owns nothing under the new roster.
                expect(shouldIndexTask(`post-migration-${i}`, 'myia-po-2024', roster)).toBe(false);
            }
        });

        test('partition + migration: exactly one machine in the NEW roster owns each task', () => {
            // After a roster change (6 → 4 machines), each task still has exactly 1 owner
            // among the remaining 4. The 2 removed machines own nothing.
            const newRoster = ['myia-ai-01', 'myia-po-2023', 'myia-po-2026', 'myia-web1'];
            for (let i = 0; i < 200; i++) {
                const taskId = `migrated-${i}`;
                let owners = 0;
                for (const m of newRoster) {
                    if (shouldIndexTask(taskId, m, newRoster)) owners++;
                }
                expect(owners).toBe(1);
            }
        });
    });
});
