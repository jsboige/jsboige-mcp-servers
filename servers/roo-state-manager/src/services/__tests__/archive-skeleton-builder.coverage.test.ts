/**
 * #833 Sprint C3 — archiveToSkeleton branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `archive-skeleton-builder.test.ts` (11 tests) covers the happy paths and
 * the field-level fallbacks thoroughly: message-timestamp-vs-archivedAt (L33),
 * createdAt/lastActivity → archivedAt fallback (L47/L48), messageCount-from-sequence
 * (L49), source-default 'roo' (L53), isCompleted-default-false (L42 — metadata PRESENT
 * but isCompleted ABSENT).
 *
 * It leaves a coherent cluster of defensive branches cold, however. The TS types
 * (`task-archiver/types.ts`) declare both `metadata` (L57) and `messages` (L58) as
 * REQUIRED, but `archiveToSkeleton` defensively tolerates their ABSENCE at runtime —
 * `archive.messages || []` (L30) and `archive.metadata?.X` optional-chains (L41-54).
 * This is a deliberate robustness net for real-world malformed/partial archives
 * (GDrive older-version files, corruption, hand-edits) that violate the TS contract.
 * The base never feeds type-violating inputs, so every defensive arm is dead:
 *
 * - **`archive.messages` undefined (L30 `|| []`)**: base always supplies an array.
 *   The `|| []` guard is never exercised — a malformed archive with no `messages`
 *   field would throw at `.map` if this regressed to a direct access.
 * - **`archive.metadata` entirely undefined (L41, L42, L44, L47-49, L53-54 `?.`)**:
 *   base always supplies a metadata object. When metadata itself is absent, ALL the
 *   optional chains short-circuit to undefined, then the `??` defaults take over:
 *   - L41 `parentTaskId: archive.metadata?.parentTaskId` → undefined
 *   - L42 `archive.metadata?.isCompleted ?? false` → BOTH `?.` AND `??` fire → false
 *   - L44 `title: archive.metadata?.title` → undefined
 *   - L47 `createdAt ?? fallbackTimestamp` → archivedAt
 *   - L48 `lastActivity ?? fallbackTimestamp` → archivedAt
 *   - L49 `messageCount ?? sequence.length` → sequence.length
 *   - L53 `source ?? 'roo'` → 'roo'
 *   - L54 `parentTaskId` (metadata field) → undefined
 * - **`msg.timestamp` falsy-string `''` (L33 `||` not `??`)**: base tests timestamp-
 *   present and timestamp-absent (undefined), never the falsy-empty-string case.
 *   The code uses `||` (not `??`), so `timestamp: ''` falls back to archivedAt —
 *   a subtle but deliberate distinction. If `||` were ever "modernized" to `??`, an
 *   empty-string timestamp would survive (bug).

 * This add-only file pins each, fed via `as any` to bypass the TS required-field
 * types (the runtime deliberately tolerates the absence the types forbid). No mocks,
 * no production code touched (#1936 anti-churn).
 */

import { describe, it, expect } from 'vitest';
import { archiveToSkeleton } from '../archive-skeleton-builder.js';
import type { ArchivedTask } from '../task-archiver/types.js';

describe('archiveToSkeleton — branch coverage (#833 C3, source-grounded)', () => {

    // ============================================================
    // L30 — archive.messages undefined (|| [] defensive guard)
    // ============================================================
    describe('messages absent — || [] guard (L30)', () => {
        it('produces an empty sequence when archive.messages is undefined (L30 || [])', () => {
            // Type-violating input: messages field entirely absent. The runtime tolerates it.
            const archive = {
                version: 2,
                taskId: 'task-no-msgs',
                machineId: 'myia-ai-01',
                hostIdentifier: 'host',
                archivedAt: '2026-04-18T12:00:00Z',
                metadata: {
                    title: 'No Messages Field',
                    messageCount: 0,
                    isCompleted: false,
                },
                // messages intentionally OMITTED
            } as unknown as ArchivedTask;

            const result = archiveToSkeleton(archive);

            // L30 `(archive.messages || []).map` → [] → sequence empty, no throw.
            expect(result.sequence).toEqual([]);
        });

        it('produces an empty sequence when archive.messages is explicitly null (L30 || [])', () => {
            const archive = {
                version: 2,
                taskId: 'task-null-msgs',
                machineId: 'myia-ai-01',
                hostIdentifier: 'host',
                archivedAt: '2026-04-18T12:00:00Z',
                metadata: {
                    title: 'Null Messages',
                    messageCount: 0,
                    isCompleted: false,
                },
                messages: null,
            } as unknown as ArchivedTask;

            const result = archiveToSkeleton(archive);

            expect(result.sequence).toEqual([]);
        });

        it('messageCount falls back to sequence.length (0) when messages absent and metadata.messageCount absent (L49)', () => {
            // Combines L30 (no messages → empty sequence) with L49 (no messageCount → sequence.length).
            const archive = {
                version: 2,
                taskId: 'task-double-absent',
                machineId: 'myia-ai-01',
                hostIdentifier: 'host',
                archivedAt: '2026-04-18T12:00:00Z',
                metadata: {
                    title: 'No messages, no messageCount',
                    isCompleted: false,
                    // messageCount omitted
                },
                // messages omitted
            } as unknown as ArchivedTask;

            const result = archiveToSkeleton(archive);

            expect(result.sequence).toHaveLength(0);
            // L49: archive.metadata?.messageCount ?? sequence.length → 0.
            expect(result.metadata.messageCount).toBe(0);
        });
    });

    // ============================================================
    // L41-54 — archive.metadata entirely undefined (?. optional chains)
    // ============================================================
    describe('metadata absent — ?. optional-chain arms (L41, L42, L44, L47-49, L53-54)', () => {
        const archiveNoMetadata = {
            version: 2,
            taskId: 'task-no-meta',
            machineId: 'myia-po-2026',
            hostIdentifier: 'host',
            archivedAt: '2026-04-18T12:00:00Z',
            // metadata entirely OMITTED
            messages: [
                { role: 'user', content: 'one' },
                { role: 'assistant', content: 'two' },
                { role: 'user', content: 'three' },
            ],
        } as unknown as ArchivedTask;

        it('parentTaskId on skeleton is undefined (L41 archive.metadata?.parentTaskId)', () => {
            const result = archiveToSkeleton(archiveNoMetadata);
            expect(result.parentTaskId).toBeUndefined();
        });

        it('isCompleted defaults to false — BOTH ?. and ?? fire (L42 archive.metadata?.isCompleted ?? false)', () => {
            const result = archiveToSkeleton(archiveNoMetadata);
            // L42: metadata absent → ?. yields undefined → ?? yields false.
            expect(result.isCompleted).toBe(false);
        });

        it('title is undefined (L44 archive.metadata?.title)', () => {
            const result = archiveToSkeleton(archiveNoMetadata);
            expect(result.metadata.title).toBeUndefined();
        });

        it('createdAt falls back to archivedAt (L47 archive.metadata?.createdAt ?? fallbackTimestamp)', () => {
            const result = archiveToSkeleton(archiveNoMetadata);
            expect(result.metadata.createdAt).toBe('2026-04-18T12:00:00Z');
        });

        it('lastActivity falls back to archivedAt (L48 archive.metadata?.lastActivity ?? fallbackTimestamp)', () => {
            const result = archiveToSkeleton(archiveNoMetadata);
            expect(result.metadata.lastActivity).toBe('2026-04-18T12:00:00Z');
        });

        it('messageCount falls back to sequence.length=3 (L49 archive.metadata?.messageCount ?? sequence.length)', () => {
            const result = archiveToSkeleton(archiveNoMetadata);
            expect(result.metadata.messageCount).toBe(3);
        });

        it('source defaults to "roo" (L53 archive.metadata?.source ?? "roo")', () => {
            const result = archiveToSkeleton(archiveNoMetadata);
            expect(result.metadata.source).toBe('roo');
        });

        it('metadata.parentTaskId is undefined (L54 archive.metadata?.parentTaskId)', () => {
            const result = archiveToSkeleton(archiveNoMetadata);
            expect(result.metadata.parentTaskId).toBeUndefined();
        });

        it('dataSource is still "archive" regardless of metadata absence (L55 hardcode)', () => {
            // The dataSource marker is hardcoded, independent of metadata resolution.
            const result = archiveToSkeleton(archiveNoMetadata);
            expect(result.metadata.dataSource).toBe('archive');
        });

        it('machineId passes through from archive root (L52 archive.machineId — not metadata-dependent)', () => {
            const result = archiveToSkeleton(archiveNoMetadata);
            expect(result.metadata.machineId).toBe('myia-po-2026');
        });
    });

    // ============================================================
    // L33 — msg.timestamp falsy-string '' (|| vs ?? semantics)
    // ============================================================
    describe('msg.timestamp empty string — || fallback (L33)', () => {
        it('empty-string timestamp falls back to archivedAt because || (not ??) is used (L33)', () => {
            // The code uses `msg.timestamp || archive.archivedAt`. Empty string is falsy →
            // falls back. If this were ever changed to `??`, the empty string would survive.
            const archive: ArchivedTask = {
                version: 2,
                taskId: 'task-empty-ts',
                machineId: 'myia-ai-01',
                hostIdentifier: 'host',
                archivedAt: '2026-04-18T12:00:00Z',
                metadata: {
                    title: 'Empty Timestamp',
                    messageCount: 1,
                    isCompleted: false,
                },
                messages: [
                    { role: 'user', content: 'msg', timestamp: '' },
                ],
            };

            const result = archiveToSkeleton(archive);

            // L33: '' is falsy → || yields archivedAt.
            expect(result.sequence[0].timestamp).toBe('2026-04-18T12:00:00Z');
            expect(result.sequence[0].timestamp).not.toBe('');
        });

        it('a present non-empty timestamp wins over archivedAt (L33 first operand)', () => {
            // Pin the winning arm too, to anchor the `||` contract on both sides.
            const archive: ArchivedTask = {
                version: 2,
                taskId: 'task-real-ts',
                machineId: 'myia-ai-01',
                hostIdentifier: 'host',
                archivedAt: '2026-04-18T12:00:00Z',
                metadata: {
                    title: 'Real Timestamp',
                    messageCount: 1,
                    isCompleted: false,
                },
                messages: [
                    { role: 'user', content: 'msg', timestamp: '2026-04-18T09:30:00Z' },
                ],
            };

            const result = archiveToSkeleton(archive);

            expect(result.sequence[0].timestamp).toBe('2026-04-18T09:30:00Z');
        });
    });
});
