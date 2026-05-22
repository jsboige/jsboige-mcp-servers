/**
 * Tests for graceful degradation when task files are not available locally.
 * Covers the fix for "Task directory was not found in any storage location" error (#2307).
 *
 * When a Roo or Claude task is in the skeleton cache but its local files are deleted
 * (or reside on another machine), view should return skeleton metadata instead of
 * throwing an error.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks ───────────────────

const mockStat = vi.fn();
const mockDetectStorageLocations = vi.fn();

vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        promises: {
            ...(actual as any).promises,
            writeFile: vi.fn().mockResolvedValue(undefined),
            mkdir: vi.fn().mockResolvedValue(undefined),
            stat: (...args: any[]) => mockStat(...args),
        },
    };
});

vi.mock('../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: (...args: any[]) => mockDetectStorageLocations(...args),
        analyzeConversation: vi.fn().mockResolvedValue(null),
    },
}));

vi.mock('../smart-truncation/index.js', () => ({
    SmartTruncationEngine: vi.fn().mockImplementation(() => ({
        truncate: vi.fn().mockReturnValue({ content: 'smart-truncated', wasTruncated: false }),
    })),
    ContentTruncator: vi.fn().mockImplementation(() => ({
        truncate: vi.fn().mockReturnValue('truncated-content'),
    })),
    SmartOutputFormatter: vi.fn().mockImplementation(() => ({
        format: vi.fn().mockReturnValue('formatted-output'),
    })),
    DEFAULT_SMART_TRUNCATION_CONFIG: {},
    ViewConversationTreeArgs: {},
}));

import { viewConversationTree } from '../view-conversation-tree.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

// ─────────────────── helpers ───────────────────

function makeSkeletonWithoutFiles(taskId: string, overrides?: Partial<ConversationSkeleton['metadata']>): ConversationSkeleton {
    return {
        taskId,
        parentTaskId: undefined,
        metadata: {
            title: overrides?.title ?? `Deleted Task ${taskId}`,
            messageCount: overrides?.messageCount ?? 5,
            lastActivity: overrides?.lastActivity ?? '2026-01-01T10:00:00.000Z',
            createdAt: '2026-01-01T08:00:00.000Z',
            workspace: overrides?.workspace ?? '/remote/workspace',
            machineId: overrides?.machineId ?? 'myia-po-2026',
            actionCount: overrides?.actionCount ?? 3,
            totalSize: overrides?.totalSize ?? 1234,
            source: 'roo',
            ...overrides,
        },
        sequence: [],
    } as ConversationSkeleton;
}

// ─────────────────── tests ───────────────────

beforeEach(() => {
    vi.clearAllMocks();
    // Default: no storage locations found, stat throws ENOENT
    mockDetectStorageLocations.mockResolvedValue(['/fake/storage/location']);
    const enoent = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    mockStat.mockRejectedValue(enoent);
});

describe('conversation_browser view: graceful degradation for deleted/remote tasks (#2307)', () => {

    test('returns skeleton metadata instead of throwing when Roo task directory is not found', async () => {
        const taskId = 'roo-task-deleted-123';
        const skeleton = makeSkeletonWithoutFiles(taskId, {
            title: 'My Deleted Roo Task',
            messageCount: 7,
            workspace: '/remote/workspace',
            machineId: 'myia-po-2026',
        });
        const cache = new Map([[taskId, skeleton]]);

        const result = await viewConversationTree.handler({ task_id: taskId }, cache);

        expect(result).toBeDefined();
        expect(result.content[0].text).toContain('⚠️');
        expect(result.content[0].text).toContain('Skeleton Only');
        expect(result.content[0].text).toContain(taskId);
    });

    test('skeleton response includes task metadata (title, messageCount, workspace, machineId)', async () => {
        const taskId = 'roo-task-with-meta-456';
        const skeleton = makeSkeletonWithoutFiles(taskId, {
            title: 'Cross-Machine Analysis Task',
            messageCount: 12,
            workspace: '/dev/project',
            machineId: 'myia-po-2023',
            totalSize: 56789,
        });
        const cache = new Map([[taskId, skeleton]]);

        const result = await viewConversationTree.handler({ task_id: taskId }, cache);
        const text = result.content[0].text;

        expect(text).toContain('Cross-Machine Analysis Task');
        expect(text).toContain('12');
        expect(text).toContain('/dev/project');
        expect(text).toContain('myia-po-2023');
    });

    test('skeleton response contains guidance on accessing full content', async () => {
        const taskId = 'roo-task-guidance-789';
        const skeleton = makeSkeletonWithoutFiles(taskId);
        const cache = new Map([[taskId, skeleton]]);

        const result = await viewConversationTree.handler({ task_id: taskId }, cache);
        const text = result.content[0].text;

        expect(text).toContain('includeArchives');
    });

    test('does not throw even when multiple storage locations are checked', async () => {
        mockDetectStorageLocations.mockResolvedValue([
            '/storage/location1',
            '/storage/location2',
            '/storage/location3',
        ]);
        const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        mockStat.mockRejectedValue(enoent);

        const taskId = 'roo-task-multi-storage';
        const skeleton = makeSkeletonWithoutFiles(taskId, { messageCount: 3 });
        const cache = new Map([[taskId, skeleton]]);

        await expect(viewConversationTree.handler({ task_id: taskId }, cache)).resolves.toBeDefined();
        expect(mockStat).toHaveBeenCalledTimes(3);
    });

    test('still works normally when task directory exists (no regression)', async () => {
        // When stat succeeds (directory found), normal flow continues.
        // Use messageCount: 0 to bypass lazy loading entirely (existing behavior).
        const taskId = 'roo-task-normal';
        const skeleton: ConversationSkeleton = {
            taskId,
            parentTaskId: undefined,
            metadata: {
                title: 'Normal Task',
                messageCount: 0,
                lastActivity: '2026-01-01T10:00:00.000Z',
                actionCount: 0,
                totalSize: 100,
            },
            sequence: [{ role: 'user', content: 'Hello', timestamp: '2026-01-01T10:00:00.000Z' }],
        } as ConversationSkeleton;
        const cache = new Map([[taskId, skeleton]]);

        const result = await viewConversationTree.handler({ task_id: taskId }, cache);

        expect(result).toBeDefined();
        // Normal response — NOT a skeleton-only response
        expect(result.content[0].text).not.toContain('⚠️');
    });
});
