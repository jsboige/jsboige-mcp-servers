/**
 * Tests unitaires pour task_browse
 *
 * CONS-9: Outil consolidé qui remplace get_task_tree + get_current_task
 *
 * Couvre toutes les actions de l'outil consolidé :
 * - action: 'tree' : Récupère l'arbre des tâches
 * - action: 'current' : Récupère la tâche active
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module task/browse.test
 * @version 1.0.0 (CONS-9)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { handleTaskBrowse, TaskBrowseArgs } from '../browse.js';
import { ConversationSkeleton } from '../../../types/conversation.js';

// Mock handleGetTaskTree
vi.mock('../get-tree.tool.js', () => ({
    handleGetTaskTree: vi.fn(async (args: any) => ({
        content: [{ type: 'text', text: `Tree for ${args.conversation_id}` }]
    })),
    getTaskTreeTool: {
        name: 'get_task_tree',
        inputSchema: { type: 'object' }
    }
}));

// Mock getCurrentTaskTool
vi.mock('../get-current-task.tool.js', () => ({
    getCurrentTaskTool: {
        definition: { name: 'get_current_task' },
        handler: vi.fn(async (args: any) => ({
            content: [{ type: 'text', text: JSON.stringify({ task_id: 'current-task-123', workspace_path: args.workspace || '/default' }) }]
        }))
    }
}));

describe('task_browse - CONS-9', () => {
    let mockCache: Map<string, ConversationSkeleton>;
    let mockEnsureCache: () => Promise<void>;

    beforeEach(() => {
        mockCache = new Map();
        mockEnsureCache = vi.fn(async () => {});
        vi.clearAllMocks();
    });

    // ============================================================
    // Tests pour validation des arguments
    // ============================================================

    describe('argument validation', () => {
        test('should return error when action is missing', async () => {
            const args = {} as TaskBrowseArgs;

            const result = await handleTaskBrowse(args, mockCache, mockEnsureCache);

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('action');
            expect(result.content[0].text).toContain('requis');
        });

        test('should return error when action is invalid', async () => {
            const args = { action: 'invalid' as any };

            const result = await handleTaskBrowse(args, mockCache, mockEnsureCache);

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('invalide');
            expect(result.content[0].text).toContain('tree');
            expect(result.content[0].text).toContain('current');
        });

        test('should return error when conversation_id is missing for tree action', async () => {
            const args: TaskBrowseArgs = { action: 'tree' };

            const result = await handleTaskBrowse(args, mockCache, mockEnsureCache);

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('conversation_id');
            expect(result.content[0].text).toContain('requis');
        });
    });

    // ============================================================
    // Tests pour action='tree'
    // ============================================================

    describe('action: tree', () => {
        test('should call handleGetTaskTree with correct arguments', async () => {
            const { handleGetTaskTree } = await import('../get-tree.tool.js');

            const args: TaskBrowseArgs = {
                action: 'tree',
                conversation_id: 'conv-123',
                max_depth: 5,
                include_siblings: true,
                output_format: 'ascii-tree'
            };

            const result = await handleTaskBrowse(args, mockCache, mockEnsureCache);

            expect(handleGetTaskTree).toHaveBeenCalledWith(
                expect.objectContaining({
                    conversation_id: 'conv-123',
                    max_depth: 5,
                    include_siblings: true,
                    output_format: 'ascii-tree'
                }),
                mockCache,
                mockEnsureCache
            );
            expect(result.isError).toBeFalsy();
            expect(result.content[0].text).toContain('Tree for conv-123');
        });

        test('should pass all tree-specific parameters', async () => {
            const { handleGetTaskTree } = await import('../get-tree.tool.js');

            const args: TaskBrowseArgs = {
                action: 'tree',
                conversation_id: 'conv-456',
                max_depth: 3,
                include_siblings: false,
                output_format: 'json',
                current_task_id: 'task-789',
                truncate_instruction: 50,
                show_metadata: true
            };

            await handleTaskBrowse(args, mockCache, mockEnsureCache);

            expect(handleGetTaskTree).toHaveBeenCalledWith(
                expect.objectContaining({
                    conversation_id: 'conv-456',
                    max_depth: 3,
                    include_siblings: false,
                    output_format: 'json',
                    current_task_id: 'task-789',
                    truncate_instruction: 50,
                    show_metadata: true
                }),
                expect.anything(),
                expect.anything()
            );
        });
    });

    // ============================================================
    // Tests pour action='current'
    // ============================================================

    describe('action: current', () => {
        test('should call getCurrentTaskTool.handler with workspace', async () => {
            const { getCurrentTaskTool } = await import('../get-current-task.tool.js');

            const args: TaskBrowseArgs = {
                action: 'current',
                workspace: '/path/to/workspace'
            };

            const result = await handleTaskBrowse(args, mockCache, mockEnsureCache);

            expect(getCurrentTaskTool.handler).toHaveBeenCalledWith(
                { workspace: '/path/to/workspace' },
                mockCache,
                undefined,  // contextWorkspace
                mockEnsureCache
            );
            expect(result.isError).toBeFalsy();
        });

        test('should work without workspace (auto-detection)', async () => {
            const { getCurrentTaskTool } = await import('../get-current-task.tool.js');

            const args: TaskBrowseArgs = {
                action: 'current'
            };

            const result = await handleTaskBrowse(args, mockCache, mockEnsureCache);

            expect(getCurrentTaskTool.handler).toHaveBeenCalledWith(
                { workspace: undefined },
                mockCache,
                undefined,
                mockEnsureCache
            );
            expect(result.isError).toBeFalsy();
        });

        test('should pass contextWorkspace when provided', async () => {
            const { getCurrentTaskTool } = await import('../get-current-task.tool.js');

            const args: TaskBrowseArgs = {
                action: 'current'
            };

            await handleTaskBrowse(args, mockCache, mockEnsureCache, '/context/workspace');

            expect(getCurrentTaskTool.handler).toHaveBeenCalledWith(
                expect.anything(),
                mockCache,
                '/context/workspace',
                mockEnsureCache
            );
        });
    });

    // ============================================================
    // Tests pour la définition de l'outil
    // ============================================================

    describe('tool definition', () => {
        test('taskBrowseTool should have correct name and schema', async () => {
            const { taskBrowseTool } = await import('../browse.js');

            expect(taskBrowseTool.name).toBe('task_browse');
            expect(taskBrowseTool.inputSchema.properties.action).toBeDefined();
            expect(taskBrowseTool.inputSchema.properties.action.enum).toEqual(['tree', 'current']);
            expect(taskBrowseTool.inputSchema.required).toContain('action');
        });

        test('schema should include all tree parameters', async () => {
            const { taskBrowseTool } = await import('../browse.js');
            const props = taskBrowseTool.inputSchema.properties;

            expect(props.conversation_id).toBeDefined();
            expect(props.max_depth).toBeDefined();
            expect(props.include_siblings).toBeDefined();
            expect(props.output_format).toBeDefined();
            expect(props.current_task_id).toBeDefined();
            expect(props.truncate_instruction).toBeDefined();
            expect(props.show_metadata).toBeDefined();
        });

        test('schema should include workspace parameter for current', async () => {
            const { taskBrowseTool } = await import('../browse.js');
            const props = taskBrowseTool.inputSchema.properties;

            expect(props.workspace).toBeDefined();
        });
    });
});
