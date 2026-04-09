import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listConversationsTool } from '../../../../src/tools/conversation/list-conversations.tool';
import { ConversationSkeleton } from '../../../../src/types/conversation';
import { normalizePath } from '../../../../src/utils/path-normalizer';
import { RooStorageDetector } from '../../../../src/utils/roo-storage-detector';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// Mock fs and path
vi.mock('fs', () => ({
    promises: {
        readFile: vi.fn()
    }
}));
vi.mock('path');
vi.mock('os', () => ({
    default: {
        hostname: () => 'test-host',
        homedir: () => '/home/user',
        tmpdir: () => '/tmp',
    },
    hostname: () => 'test-host',
    homedir: () => '/home/user',
    tmpdir: () => '/tmp',
}));

describe('list_conversations tool', () => {
    let mockCache: Map<string, ConversationSkeleton>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockCache = new Map();

        // vi.spyOn for RooStorageDetector (#1123 — vi.mock doesn't work for loadApiMessages)
        vi.spyOn(RooStorageDetector, 'detectStorageLocations').mockResolvedValue(['/mock/storage']);

        // Setup mock data
        const task1: ConversationSkeleton = {
            taskId: 'task-1',
            sequence: [],
            metadata: {
                lastActivity: '2023-01-02T00:00:00Z',
                messageCount: 10,
                totalSize: 1000,
                workspace: '/workspace/a',
                createdAt: '2023-01-01T00:00:00Z',
                actionCount: 5
            }
        };

        const task2: ConversationSkeleton = {
            taskId: 'task-2',
            sequence: [],
            metadata: {
                lastActivity: '2023-01-01T00:00:00Z',
                messageCount: 5,
                totalSize: 500,
                workspace: '/workspace/b',
                createdAt: '2023-01-01T00:00:00Z',
                actionCount: 2
            }
        };

        mockCache.set('task-1', task1);
        mockCache.set('task-2', task2);

        vi.mocked(path.join).mockImplementation((...args) => args.join('/'));
        // #1244 Couche 2.2 — list-conversations now uses normalizeWorkspaceId() which calls path.basename
        vi.mocked(path.basename).mockImplementation((p: string) => {
            if (!p) return '';
            const normalized = p.replace(/\\/g, '/');
            const parts = normalized.split('/').filter(Boolean);
            return parts[parts.length - 1] || '';
        });
    });

    it('should have correct definition', () => {
        expect(listConversationsTool.definition.name).toBe('list_conversations');
        expect(listConversationsTool.definition.description).toBe('Liste toutes les conversations avec filtres et tri.');
    });

    it('should list all conversations when no filters provided', async () => {
        const result = await listConversationsTool.handler({}, mockCache);
        const _response = JSON.parse(result.content[0].text as string);
        const content = _response.conversations ?? _response;
        
        expect(content).toHaveLength(2);
        expect(content[0].taskId).toBe('task-1'); // Default sort by lastActivity desc
        expect(content[1].taskId).toBe('task-2');
    });

    it('should filter by workspace', async () => {
        const result = await listConversationsTool.handler({ workspace: '/workspace/a' }, mockCache);
        const _response = JSON.parse(result.content[0].text as string);
        const content = _response.conversations ?? _response;
        
        expect(content).toHaveLength(1);
        expect(content[0].taskId).toBe('task-1');
    });

    it('should sort by messageCount asc', async () => {
        const result = await listConversationsTool.handler({
            sortBy: 'messageCount',
            sortOrder: 'asc'
        }, mockCache);
        const _response = JSON.parse(result.content[0].text as string);
        const content = _response.conversations ?? _response;
        
        expect(content).toHaveLength(2);
        expect(content[0].taskId).toBe('task-2'); // 5 messages
        expect(content[1].taskId).toBe('task-1'); // 10 messages
    });

    it('should limit results', async () => {
        const result = await listConversationsTool.handler({ limit: 1 }, mockCache);
        const _response = JSON.parse(result.content[0].text as string);
        const content = _response.conversations ?? _response;
        
        expect(content).toHaveLength(1);
    });

    // Test for pendingSubtaskOnly filter
    it('should filter by pendingSubtaskOnly', async () => {
        // Mock fs.readFile to return messages with pending subtask for task-1
        vi.mocked(fs.readFile).mockImplementation((filePath) => {
            if (filePath.toString().includes('task-1')) {
                return Promise.resolve(JSON.stringify([
                    { role: 'assistant', content: 'Please do this <new_task>subtask</new_task>' }
                ]));
            }
            return Promise.resolve(JSON.stringify([]));
        });

        const result = await listConversationsTool.handler({ pendingSubtaskOnly: true }, mockCache);
        const _response = JSON.parse(result.content[0].text as string);
        const content = _response.conversations ?? _response;
        
        expect(content).toHaveLength(1);
        expect(content[0].taskId).toBe('task-1');
    });

    // Test for contentPattern filter
    it('should filter by contentPattern', async () => {
        // Mock fs.readFile to return messages with specific content for task-2
        vi.mocked(fs.readFile).mockImplementation((filePath) => {
            if (filePath.toString().includes('task-2')) {
                return Promise.resolve(JSON.stringify([
                    { role: 'user', content: 'This is a specific pattern to find' }
                ]));
            }
            return Promise.resolve(JSON.stringify([]));
        });

        const result = await listConversationsTool.handler({ contentPattern: 'specific pattern' }, mockCache);
        const _response = JSON.parse(result.content[0].text as string);
        const content = _response.conversations ?? _response;

        expect(content).toHaveLength(1);
        expect(content[0].taskId).toBe('task-2');
    });

    // ======================================================================
    // #1244 — pipeline repair (couches 2.1 / 2.2 / 3.2)
    // Regression guards for the CoursIA postmortem fixes.
    // ======================================================================
    describe('#1244 — pipeline repair', () => {
        it('[#1244 2.1] startDate filter keeps only tasks with lastActivity >= startDate', async () => {
            // task-1 lastActivity = 2023-01-02, task-2 lastActivity = 2023-01-01
            const result = await listConversationsTool.handler({ startDate: '2023-01-02' }, mockCache);
            const _response = JSON.parse(result.content[0].text as string);
            const content = _response.conversations ?? _response;

            expect(content).toHaveLength(1);
            expect(content[0].taskId).toBe('task-1');
        });

        it('[#1244 2.1] endDate filter keeps only tasks with lastActivity <= endDate (end of day expanded)', async () => {
            // endDate "2023-01-01" is expanded to end-of-day (23:59:59.999Z) by isWithinDateRange,
            // so task-2 (2023-01-01T00:00:00Z) matches while task-1 (2023-01-02T00:00:00Z) is excluded.
            const result = await listConversationsTool.handler({ endDate: '2023-01-01' }, mockCache);
            const _response = JSON.parse(result.content[0].text as string);
            const content = _response.conversations ?? _response;

            expect(content).toHaveLength(1);
            expect(content[0].taskId).toBe('task-2');
        });

        it('[#1244 2.1] machineId filter isolates a single machine cross-machine', async () => {
            mockCache.get('task-1')!.metadata.machineId = 'myia-po-2025';
            mockCache.get('task-2')!.metadata.machineId = 'myia-ai-01';

            const result = await listConversationsTool.handler({ machineId: 'myia-po-2025' }, mockCache);
            const _response = JSON.parse(result.content[0].text as string);
            const content = _response.conversations ?? _response;

            expect(content).toHaveLength(1);
            expect(content[0].taskId).toBe('task-1');
        });

        it('[#1244 2.2] workspacePathMatch "normalized" (default) matches different parent paths via basename', async () => {
            // Override task workspaces to two different parent trees sharing a basename.
            mockCache.get('task-1')!.metadata.workspace = 'd:/dev/CoursIA';
            mockCache.get('task-2')!.metadata.workspace = 'c:/other/Project';

            // Query uses a shorter path ("d:/CoursIA") — with 'normalized' (default) both
            // resolve to basename "coursia" and match. Before #1244 this failed (exact match only).
            const result = await listConversationsTool.handler({ workspace: 'd:/CoursIA' }, mockCache);
            const _response = JSON.parse(result.content[0].text as string);
            const content = _response.conversations ?? _response;

            expect(content).toHaveLength(1);
            expect(content[0].taskId).toBe('task-1');
        });

        it('[#1244 3.2] toConversationSummary exposes source/tier/machineId from metadata', async () => {
            const t1 = mockCache.get('task-1')!;
            t1.metadata.source = 'claude-code';
            t1.metadata.dataSource = 'archive';
            t1.metadata.machineId = 'myia-po-2025';

            const result = await listConversationsTool.handler({}, mockCache);
            const _response = JSON.parse(result.content[0].text as string);
            const content = _response.conversations ?? _response;

            const task1Summary = content.find((c: any) => c.taskId === 'task-1');
            expect(task1Summary).toBeDefined();
            // Couche 3.2 — source flows from metadata.source (not taskId prefix)
            expect(task1Summary.source).toBe('claude');
            // Couche 3.2 — tier derived from metadata.dataSource ('archive' vs 'local')
            expect(task1Summary.tier).toBe('archive');
            // Cross-machine dimension surfaced in meta
            expect(task1Summary.metadata.machineId).toBe('myia-po-2025');
        });
    });
});