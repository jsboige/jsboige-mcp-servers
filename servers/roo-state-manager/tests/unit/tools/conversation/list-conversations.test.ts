import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listConversationsTool } from '../../../../src/tools/conversation/list-conversations.tool';
import { ConversationSkeleton } from '../../../../src/types/conversation';
import { normalizePath } from '../../../../src/utils/path-normalizer';
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
vi.mock('os');

describe('list_conversations tool', () => {
    let mockCache: Map<string, ConversationSkeleton>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockCache = new Map();
        
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
        vi.mocked(os.homedir).mockReturnValue('/home/user');
    });

    it('should have correct definition', () => {
        expect(listConversationsTool.definition.name).toBe('list_conversations');
        expect(listConversationsTool.definition.description).toBe('Liste toutes les conversations avec filtres et tri.');
    });

    it('should list all conversations when no filters provided', async () => {
        const result = await listConversationsTool.handler({}, mockCache);
        const content = JSON.parse(result.content[0].text as string);
        
        expect(content).toHaveLength(2);
        expect(content[0].taskId).toBe('task-1'); // Default sort by lastActivity desc
        expect(content[1].taskId).toBe('task-2');
    });

    it('should filter by workspace', async () => {
        const result = await listConversationsTool.handler({ workspace: '/workspace/a' }, mockCache);
        const content = JSON.parse(result.content[0].text as string);
        
        expect(content).toHaveLength(1);
        expect(content[0].taskId).toBe('task-1');
    });

    it('should sort by messageCount asc', async () => {
        const result = await listConversationsTool.handler({
            sortBy: 'messageCount',
            sortOrder: 'asc'
        }, mockCache);
        const content = JSON.parse(result.content[0].text as string);
        
        expect(content).toHaveLength(2);
        expect(content[0].taskId).toBe('task-2'); // 5 messages
        expect(content[1].taskId).toBe('task-1'); // 10 messages
    });

    it('should limit results', async () => {
        const result = await listConversationsTool.handler({ limit: 1 }, mockCache);
        const content = JSON.parse(result.content[0].text as string);
        
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
        const content = JSON.parse(result.content[0].text as string);
        
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
        const content = JSON.parse(result.content[0].text as string);
        
        expect(content).toHaveLength(1);
        expect(content[0].taskId).toBe('task-2');
    });
});