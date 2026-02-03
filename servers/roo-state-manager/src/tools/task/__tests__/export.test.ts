/**
 * Tests unitaires pour task_export
 *
 * CONS-9: Outil consolidé qui remplace export_task_tree_markdown + debug_task_parsing
 *
 * Couvre toutes les actions de l'outil consolidé :
 * - action: 'markdown' : Exporte l'arbre des tâches
 * - action: 'debug' : Diagnostic du parsing d'une tâche
 *
 * Framework: Vitest
 * Coverage cible: >80%
 *
 * @module task/export.test
 * @version 1.0.0 (CONS-9)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { handleTaskExport, TaskExportArgs } from '../export.js';
import { ConversationSkeleton } from '../../../types/conversation.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Helper to extract text from CallToolResult content */
function getTextContent(result: CallToolResult, index: number = 0): string {
    const content = result.content[index];
    if (content && content.type === 'text') {
        return content.text;
    }
    return '';
}

// Mock handleExportTaskTreeMarkdown
vi.mock('../export-tree-md.tool.js', () => ({
    handleExportTaskTreeMarkdown: vi.fn(async (args: any) => ({
        content: [{ type: 'text', text: `Exported markdown for ${args.conversation_id}` }]
    })),
    exportTaskTreeMarkdownTool: {
        name: 'export_task_tree_markdown',
        inputSchema: { type: 'object' }
    }
}));

// Mock handleDebugTaskParsing
vi.mock('../debug-parsing.tool.js', () => ({
    handleDebugTaskParsing: vi.fn(async (args: any) => ({
        content: [{ type: 'text', text: `Debug info for ${args.task_id}` }]
    })),
    debugTaskParsingTool: {
        name: 'debug_task_parsing',
        inputSchema: { type: 'object' }
    }
}));

// Mock handleGetTaskTree (used by export)
vi.mock('../get-tree.tool.js', () => ({
    handleGetTaskTree: vi.fn(async () => ({
        content: [{ type: 'text', text: 'Tree content' }]
    })),
    getTaskTreeTool: {
        name: 'get_task_tree',
        inputSchema: { type: 'object' }
    }
}));

describe('task_export - CONS-9', () => {
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
            const args = {} as TaskExportArgs;

            const result = await handleTaskExport(args, mockCache, mockEnsureCache);

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('action');
            expect(getTextContent(result)).toContain('requis');
        });

        test('should return error when action is invalid', async () => {
            const args = { action: 'invalid' as any };

            const result = await handleTaskExport(args, mockCache, mockEnsureCache);

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('invalide');
            expect(getTextContent(result)).toContain('markdown');
            expect(getTextContent(result)).toContain('debug');
        });

        test('should return error when conversation_id is missing for markdown action', async () => {
            const args: TaskExportArgs = { action: 'markdown' };

            const result = await handleTaskExport(args, mockCache, mockEnsureCache);

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('conversation_id');
            expect(getTextContent(result)).toContain('requis');
        });

        test('should return error when task_id is missing for debug action', async () => {
            const args: TaskExportArgs = { action: 'debug' };

            const result = await handleTaskExport(args, mockCache, mockEnsureCache);

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('task_id');
            expect(getTextContent(result)).toContain('requis');
        });
    });

    // ============================================================
    // Tests pour action='markdown'
    // ============================================================

    describe('action: markdown', () => {
        test('should call handleExportTaskTreeMarkdown with correct arguments', async () => {
            const { handleExportTaskTreeMarkdown } = await import('../export-tree-md.tool.js');

            const args: TaskExportArgs = {
                action: 'markdown',
                conversation_id: 'conv-123',
                filePath: '/output/tree.md',
                output_format: 'ascii-tree'
            };

            const result = await handleTaskExport(args, mockCache, mockEnsureCache);

            expect(handleExportTaskTreeMarkdown).toHaveBeenCalledWith(
                expect.objectContaining({
                    conversation_id: 'conv-123',
                    filePath: '/output/tree.md',
                    output_format: 'ascii-tree'
                }),
                expect.any(Function),  // handleGetTaskTree wrapper
                mockEnsureCache,
                mockCache
            );
            expect(result.isError).toBeFalsy();
            expect(getTextContent(result)).toContain('Exported markdown for conv-123');
        });

        test('should pass all markdown-specific parameters', async () => {
            const { handleExportTaskTreeMarkdown } = await import('../export-tree-md.tool.js');

            const args: TaskExportArgs = {
                action: 'markdown',
                conversation_id: 'conv-456',
                filePath: '/path/to/file.md',
                max_depth: 3,
                include_siblings: false,
                current_task_id: 'task-789',
                output_format: 'hierarchical',
                truncate_instruction: 100,
                show_metadata: true
            };

            await handleTaskExport(args, mockCache, mockEnsureCache);

            expect(handleExportTaskTreeMarkdown).toHaveBeenCalledWith(
                expect.objectContaining({
                    conversation_id: 'conv-456',
                    filePath: '/path/to/file.md',
                    max_depth: 3,
                    include_siblings: false,
                    current_task_id: 'task-789',
                    output_format: 'hierarchical',
                    truncate_instruction: 100,
                    show_metadata: true
                }),
                expect.anything(),
                expect.anything(),
                expect.anything()
            );
        });

        test('should work without filePath (returns content)', async () => {
            const args: TaskExportArgs = {
                action: 'markdown',
                conversation_id: 'conv-no-file'
            };

            const result = await handleTaskExport(args, mockCache, mockEnsureCache);

            expect(result.isError).toBeFalsy();
        });
    });

    // ============================================================
    // Tests pour action='debug'
    // ============================================================

    describe('action: debug', () => {
        test('should call handleDebugTaskParsing with correct task_id', async () => {
            const { handleDebugTaskParsing } = await import('../debug-parsing.tool.js');

            const args: TaskExportArgs = {
                action: 'debug',
                task_id: 'task-to-debug'
            };

            const result = await handleTaskExport(args, mockCache, mockEnsureCache);

            expect(handleDebugTaskParsing).toHaveBeenCalledWith({
                task_id: 'task-to-debug'
            });
            expect(result.isError).toBeFalsy();
            expect(getTextContent(result)).toContain('Debug info for task-to-debug');
        });

        test('should only pass task_id to debug handler', async () => {
            const { handleDebugTaskParsing } = await import('../debug-parsing.tool.js');

            // These extra parameters should be ignored for debug action
            const args: TaskExportArgs = {
                action: 'debug',
                task_id: 'debug-task',
                conversation_id: 'should-be-ignored',
                filePath: 'should-be-ignored'
            };

            await handleTaskExport(args, mockCache, mockEnsureCache);

            expect(handleDebugTaskParsing).toHaveBeenCalledWith({
                task_id: 'debug-task'
            });
        });
    });

    // ============================================================
    // Tests pour la définition de l'outil
    // ============================================================

    describe('tool definition', () => {
        test('taskExportTool should have correct name and schema', async () => {
            const { taskExportTool } = await import('../export.js');

            expect(taskExportTool.name).toBe('task_export');
            expect(taskExportTool.inputSchema.properties.action).toBeDefined();
            expect(taskExportTool.inputSchema.properties.action.enum).toEqual(['markdown', 'debug']);
            expect(taskExportTool.inputSchema.required).toContain('action');
        });

        test('schema should include all markdown parameters', async () => {
            const { taskExportTool } = await import('../export.js');
            const props = taskExportTool.inputSchema.properties;

            expect(props.conversation_id).toBeDefined();
            expect(props.filePath).toBeDefined();
            expect(props.max_depth).toBeDefined();
            expect(props.include_siblings).toBeDefined();
            expect(props.output_format).toBeDefined();
            expect(props.current_task_id).toBeDefined();
            expect(props.truncate_instruction).toBeDefined();
            expect(props.show_metadata).toBeDefined();
        });

        test('schema should include task_id parameter for debug', async () => {
            const { taskExportTool } = await import('../export.js');
            const props = taskExportTool.inputSchema.properties;

            expect(props.task_id).toBeDefined();
        });
    });
});
