import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { getTaskTreeTool, handleGetTaskTree } from '../../../../src/tools/task/get-tree.tool';
import { ConversationSkeleton } from '../../../../src/types/conversation';
import { globalTaskInstructionIndex } from '../../../../src/utils/task-instruction-index';

// Mock globalTaskInstructionIndex
vi.mock('../../../../src/utils/task-instruction-index', () => ({
    globalTaskInstructionIndex: {
        getStats: vi.fn().mockReturnValue({ totalInstructions: 0 }),
        addInstruction: vi.fn(),
        getParentsForInstruction: vi.fn().mockResolvedValue([])
    }
}));

describe('get_task_tree tool', () => {
    let mockCache: Map<string, ConversationSkeleton>;
    let mockEnsureCache: Mock;

    beforeEach(() => {
        vi.clearAllMocks();
        mockCache = new Map();
        mockEnsureCache = vi.fn().mockResolvedValue(undefined);

        // Setup mock data
        const rootTask: ConversationSkeleton = {
            taskId: 'root-task',
            sequence: [],
            metadata: {
                title: 'Root Task',
                createdAt: '2023-01-01T00:00:00Z',
                lastActivity: '2023-01-01T00:00:00Z',
                messageCount: 5,
                totalSize: 500,
                actionCount: 2
            }
        };

        const childTask: ConversationSkeleton = {
            taskId: 'child-task',
            parentTaskId: 'root-task',
            sequence: [],
            metadata: {
                title: 'Child Task',
                createdAt: '2023-01-02T00:00:00Z',
                lastActivity: '2023-01-02T00:00:00Z',
                messageCount: 3,
                totalSize: 300,
                actionCount: 1
            }
        };

        mockCache.set('root-task', rootTask);
        mockCache.set('child-task', childTask);
    });

    it('should have correct definition', () => {
        expect(getTaskTreeTool.name).toBe('get_task_tree');
        expect(getTaskTreeTool.description).toBe('Récupère une vue arborescente et hiérarchique des tâches.');
    });

    it('should return tree for existing task', async () => {
        const result = await handleGetTaskTree(
            { conversation_id: 'root-task' },
            mockCache,
            mockEnsureCache
        );

        const content = JSON.parse(result.content[0].text as string);
        expect(content.root_task.taskId).toBe('root-task');
        expect(content.tree[0].children).toHaveLength(1);
        expect(content.tree[0].children[0].taskId).toBe('child-task');
    });

    it('should handle empty cache', async () => {
        const emptyCache = new Map<string, ConversationSkeleton>();
        const result = await handleGetTaskTree(
            { conversation_id: 'any-id' },
            emptyCache,
            mockEnsureCache
        );

        expect(result.content[0].text).toContain('Arbre de Tâches Vide');
    });

    it('should throw error for non-existent task', async () => {
        await expect(handleGetTaskTree(
            { conversation_id: 'non-existent' },
            mockCache,
            mockEnsureCache
        )).rejects.toThrow("Task ID 'non-existent' not found");
    });

    it('should support ascii-tree format', async () => {
        const result = await handleGetTaskTree(
            { conversation_id: 'root-task', output_format: 'ascii-tree' },
            mockCache,
            mockEnsureCache
        );

        expect(result.content[0].text).toContain('Root Task');
        expect(result.content[0].text).toContain('Child Task');
    });

    it('should support markdown format', async () => {
        const result = await handleGetTaskTree(
            { conversation_id: 'root-task', output_format: 'markdown' },
            mockCache,
            mockEnsureCache
        );

        expect(result.content[0].text).toContain('# Root Task');
        expect(result.content[0].text).toContain('## Child Task');
    });

    it('should filter by max_depth', async () => {
        const result = await handleGetTaskTree(
            { conversation_id: 'root-task', max_depth: 1 },
            mockCache,
            mockEnsureCache
        );

        const content = JSON.parse(result.content[0].text as string);
        // Note: max_depth logic might vary, assuming depth 1 means root only or root + direct children
        // Based on implementation, depth check is inside recursion.
        // If max_depth is 1, it should return root but children recursion might stop or return null.
        // Let's check if children are present or empty based on implementation logic.
        // Implementation: if (depth >= maxDepth) return null.
        // Root is depth 0. Child is depth 1.
        // If max_depth is 1, child (depth 1) >= 1 is true, so child returns null.
        expect(content.tree[0].children).toBeUndefined(); 
    });
});