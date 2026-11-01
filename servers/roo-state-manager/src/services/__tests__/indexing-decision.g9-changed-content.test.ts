/**
 * #4352 g9 — content written since the last successful indexing overrides the
 * reindex TTL, at most once per minimum interval.
 *
 * Before: the 7-day TTL was checked before the content-changed check, so a
 * session written right after its indexing waited up to 7 days (ai-01 01/11: 16
 * changed sessions held, 10 of them written in the last 24 h).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexingDecisionService } from '../indexing-decision.js';
import { DEFAULT_REINDEX_CHANGED_AFTER_MS, getReindexChangedAfterMs } from '../../types/indexing.js';
import type { SkeletonHeader } from '../../types/conversation.js';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function header(lastActivityMs: number, indexingState: Record<string, unknown>): SkeletonHeader {
    return {
        taskId: 'g9-task',
        metadata: {
            title: 'g9',
            createdAt: iso(NOW - 3 * DAY),
            lastActivity: iso(lastActivityMs),
            messageCount: 5,
            actionCount: 2,
            totalSize: 1024,
            indexingState,
        },
    } as unknown as SkeletonHeader;
}

describe('IndexingDecisionService — #4352 g9 changed content vs TTL', () => {
    let service: IndexingDecisionService;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        vi.stubEnv('ROO_INDEX_FORCE', '');
        vi.stubEnv('ROO_INDEX_VERSION', '');
        service = new IndexingDecisionService();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it('changed content past the interval is indexed although the TTL is still active', () => {
        const decision = service.shouldIndex(header(NOW - 10 * MIN, {
            indexStatus: 'success',
            lastIndexedAt: iso(NOW - 2 * HOUR),
            nextReindexAfter: iso(NOW + 5 * DAY),
        }));

        expect(decision.shouldIndex).toBe(true);
        expect(decision.action).toBe('index');
        expect(decision.reason).toContain('prime sur le TTL');
    });

    it('changed content inside the interval waits, and says how long', () => {
        const decision = service.shouldIndex(header(NOW - 1 * MIN, {
            indexStatus: 'success',
            lastIndexedAt: iso(NOW - 10 * MIN),
            nextReindexAfter: iso(NOW + 7 * DAY - 10 * MIN),
        }));

        expect(decision.shouldIndex).toBe(false);
        expect(decision.action).toBe('skip');
        expect(decision.reason).toContain('intervalle minimal');
        expect(decision.reason).toContain('50min');
    });

    it('the interval boundary is inclusive', () => {
        const decision = service.shouldIndex(header(NOW - 1 * MIN, {
            indexStatus: 'success',
            lastIndexedAt: iso(NOW - DEFAULT_REINDEX_CHANGED_AFTER_MS),
            nextReindexAfter: iso(NOW + 6 * DAY),
        }));
        expect(decision.shouldIndex).toBe(true);
    });

    it('unchanged content: the TTL still applies', () => {
        const decision = service.shouldIndex(header(NOW - 3 * HOUR, {
            indexStatus: 'success',
            lastIndexedAt: iso(NOW - 2 * HOUR),
            nextReindexAfter: iso(NOW + 5 * DAY),
        }));
        expect(decision.shouldIndex).toBe(false);
        expect(decision.reason).toContain('TTL actif');
    });

    it('unchanged content with an expired TTL: still skipped as unchanged', () => {
        const decision = service.shouldIndex(header(NOW - 9 * DAY, {
            indexStatus: 'success',
            lastIndexedAt: iso(NOW - 8 * DAY),
            nextReindexAfter: iso(NOW - DAY),
        }));
        expect(decision.shouldIndex).toBe(false);
        expect(decision.reason).toContain('inchangé');
    });

    it('without lastIndexedAt nothing proves a change: the TTL applies', () => {
        const decision = service.shouldIndex(header(NOW, {
            indexStatus: 'success',
            nextReindexAfter: iso(NOW + DAY),
        }));
        expect(decision.shouldIndex).toBe(false);
        expect(decision.reason).toContain('TTL');
    });

    it('an unparseable lastActivity is not read as a change', () => {
        const h = header(NOW, {
            indexStatus: 'success',
            lastIndexedAt: iso(NOW - 2 * HOUR),
            nextReindexAfter: iso(NOW + DAY),
        });
        (h.metadata as any).lastActivity = 'not-a-date';
        const decision = service.shouldIndex(h);
        expect(decision.shouldIndex).toBe(false);
        expect(decision.reason).toContain('TTL');
    });

    it('kill-switch INDEX_REINDEX_CHANGED_AFTER_MS=0 restores the TTL-first order', () => {
        vi.stubEnv('INDEX_REINDEX_CHANGED_AFTER_MS', '0');
        const decision = service.shouldIndex(header(NOW - 10 * MIN, {
            indexStatus: 'success',
            lastIndexedAt: iso(NOW - 2 * HOUR),
            nextReindexAfter: iso(NOW + 5 * DAY),
        }));
        expect(decision.shouldIndex).toBe(false);
        expect(decision.reason).toContain('TTL actif');
    });

    it('env override shortens the interval', () => {
        vi.stubEnv('INDEX_REINDEX_CHANGED_AFTER_MS', '1000');
        const decision = service.shouldIndex(header(NOW - 500, {
            indexStatus: 'success',
            lastIndexedAt: iso(NOW - 2000),
            nextReindexAfter: iso(NOW + 7 * DAY),
        }));
        expect(decision.shouldIndex).toBe(true);
    });

    it('invalid env values fall back to the default interval', () => {
        for (const bad of ['abc', '-5', '', '   ']) {
            vi.stubEnv('INDEX_REINDEX_CHANGED_AFTER_MS', bad);
            expect(getReindexChangedAfterMs()).toBe(DEFAULT_REINDEX_CHANGED_AFTER_MS);
        }
    });

    it('round trip: markIndexingSuccess, a write, then index only once the interval has elapsed', () => {
        const h = header(NOW - HOUR, {});
        service.markIndexingSuccess(h);
        expect(service.shouldIndex(h).shouldIndex).toBe(false); // unchanged

        vi.setSystemTime(NOW + 20 * MIN);
        (h.metadata as any).lastActivity = iso(NOW + 19 * MIN);
        const early = service.shouldIndex(h);
        expect(early.shouldIndex).toBe(false);
        expect(early.reason).toContain('intervalle minimal');

        vi.setSystemTime(NOW + 61 * MIN);
        const due = service.shouldIndex(h);
        expect(due.shouldIndex).toBe(true);
        expect(due.reason).toContain('prime sur le TTL');
    });

    it('a failed task is not turned into an index by the changed-content rule', () => {
        const decision = service.shouldIndex(header(NOW - MIN, {
            indexStatus: 'failed',
            lastIndexedAt: iso(NOW - 2 * DAY),
            indexRetryCount: 3,
        }));
        expect(decision.shouldIndex).toBe(false);
    });
});
