import { describe, it, expect, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { archiveToSkeleton } from '../../src/services/archive-skeleton-builder.js';
import { SkeletonCacheService } from '../../src/services/skeleton-cache.service.js';
import type { ArchivedTask } from '../../src/services/task-archiver/types.js';

// console.warn est mocké globalement par tests/setup/jest.setup.js (vi.fn()).
const minimalArchive = {
    taskId: 'deprecation-test-1395',
    archivedAt: '2026-09-29T00:00:00.000Z',
    machineId: 'ci-test-machine',
    messages: [{ role: 'user', content: 'hello' }],
} as ArchivedTask;

function deprecationWarnCalls(): string[] {
    return (console.warn as Mock).mock.calls
        .map((args: unknown[]) => String(args[0]))
        .filter((msg: string) => msg.includes('#1395'));
}

describe('#1395 Phase 5 J+0 — warn-once dépréciation ConversationSkeleton', () => {
    beforeEach(() => {
        (console.warn as Mock).mockClear();
    });

    it('archiveToSkeleton : exactement UN warn de dépréciation sur appels répétés', () => {
        const first = archiveToSkeleton(minimalArchive);
        const second = archiveToSkeleton(minimalArchive);
        expect(second.taskId).toBe(first.taskId);
        expect(deprecationWarnCalls()).toHaveLength(1);
    });

    it('SkeletonCacheService.getInstance : exactement UN warn de dépréciation sur appels répétés', () => {
        const first = SkeletonCacheService.getInstance();
        const second = SkeletonCacheService.getInstance();
        expect(second).toBe(first);
        expect(deprecationWarnCalls()).toHaveLength(1);
    });
});
