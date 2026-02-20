/**
 * export-tree-md.test.ts - Tests pour l'outil export_task_tree_markdown
 *
 * Couvre:
 * - Validation des arguments (conversation_id requis)
 * - Délégation à handleGetTaskTree avec bons paramètres
 * - Écriture fichier (chemin absolu, chemin relatif, mkdir)
 * - Gestion des erreurs (tree retrieval, format, fs errors)
 * - Aperçu et troncature pour fichiers longs
 *
 * @module task/export-tree-md.test
 * @version 1.0.0
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../../types/conversation.js';

// Mock fs
vi.mock('fs', () => {
    const actual = vi.importActual('fs');
    return {
        ...actual,
        default: actual,
        promises: {
            access: vi.fn(),
            utimes: vi.fn(),
            mkdir: vi.fn().mockResolvedValue(undefined),
            writeFile: vi.fn().mockResolvedValue(undefined),
            readFile: vi.fn(),
        }
    };
});

import { promises as fs } from 'fs';
import {
    handleExportTaskTreeMarkdown,
    ExportTaskTreeMarkdownArgs,
} from '../export-tree-md.tool.js';

/** Helper: extract text content from result */
function getTextContent(result: CallToolResult, index: number = 0): string {
    const content = result.content[index];
    if (content && content.type === 'text') {
        return content.text;
    }
    return '';
}

describe('export-tree-md.tool', () => {
    let mockHandleGetTaskTree: ReturnType<typeof vi.fn>;
    let mockEnsureSkeletonCacheIsFresh: ReturnType<typeof vi.fn>;
    let mockConversationCache: Map<string, ConversationSkeleton>;

    const sampleTreeOutput = `# Task Tree
├── [✅] Task 1 - Do something
│   ├── [✅] Task 1.1 - Subtask
│   └── [⏳] Task 1.2 - In progress
└── [❌] Task 2 - Failed task`;

    beforeEach(() => {
        vi.clearAllMocks();

        mockHandleGetTaskTree = vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: sampleTreeOutput }]
        });

        mockEnsureSkeletonCacheIsFresh = vi.fn().mockResolvedValue(undefined);

        mockConversationCache = new Map();
        mockConversationCache.set('conv-123', {
            id: 'conv-123',
            messages: [],
            metadata: {
                workspace: '/test/workspace',
                totalMessages: 5,
                timestamp: new Date().toISOString(),
            }
        } as any);
    });

    // ============================================================
    // Argument Validation
    // ============================================================
    describe('argument validation', () => {
        test('should return error when conversation_id is missing', async () => {
            const args = {} as ExportTaskTreeMarkdownArgs;

            const result = await handleExportTaskTreeMarkdown(
                args,
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('conversation_id est requis');
        });

        test('should return error when conversation_id is empty string', async () => {
            const args = { conversation_id: '' } as ExportTaskTreeMarkdownArgs;

            const result = await handleExportTaskTreeMarkdown(
                args,
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('conversation_id est requis');
        });
    });

    // ============================================================
    // Cache Refresh
    // ============================================================
    describe('cache refresh', () => {
        test('should call ensureSkeletonCacheIsFresh before processing', async () => {
            const args: ExportTaskTreeMarkdownArgs = {
                conversation_id: 'conv-123'
            };

            await handleExportTaskTreeMarkdown(
                args,
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(mockEnsureSkeletonCacheIsFresh).toHaveBeenCalledTimes(1);
        });
    });

    // ============================================================
    // Tree Delegation
    // ============================================================
    describe('tree delegation', () => {
        test('should delegate to handleGetTaskTree with correct args', async () => {
            const args: ExportTaskTreeMarkdownArgs = {
                conversation_id: 'conv-123',
                max_depth: 3,
                include_siblings: false,
                current_task_id: 'task-abc',
                output_format: 'hierarchical',
                truncate_instruction: 120,
                show_metadata: true,
            };

            await handleExportTaskTreeMarkdown(
                args,
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(mockHandleGetTaskTree).toHaveBeenCalledWith({
                conversation_id: 'conv-123',
                max_depth: 3,
                include_siblings: false,
                current_task_id: 'task-abc',
                output_format: 'hierarchical',
                truncate_instruction: 120,
                show_metadata: true,
            });
        });

        test('should use default values for optional args', async () => {
            const args: ExportTaskTreeMarkdownArgs = {
                conversation_id: 'conv-123'
            };

            await handleExportTaskTreeMarkdown(
                args,
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(mockHandleGetTaskTree).toHaveBeenCalledWith({
                conversation_id: 'conv-123',
                max_depth: undefined,
                include_siblings: true,
                current_task_id: undefined,
                output_format: 'ascii-tree',
                truncate_instruction: 80,
                show_metadata: false,
            });
        });

        test('should return tree content directly when no filePath', async () => {
            const args: ExportTaskTreeMarkdownArgs = {
                conversation_id: 'conv-123'
            };

            const result = await handleExportTaskTreeMarkdown(
                args,
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(result.isError).toBeUndefined();
            expect(getTextContent(result)).toBe(sampleTreeOutput);
        });
    });

    // ============================================================
    // Error Handling
    // ============================================================
    describe('error handling', () => {
        test('should handle null tree result', async () => {
            mockHandleGetTaskTree.mockResolvedValue(null);

            const result = await handleExportTaskTreeMarkdown(
                { conversation_id: 'conv-123' },
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('Impossible de récupérer');
        });

        test('should handle empty content array', async () => {
            mockHandleGetTaskTree.mockResolvedValue({ content: [] });

            const result = await handleExportTaskTreeMarkdown(
                { conversation_id: 'conv-123' },
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('Impossible de récupérer');
        });

        test('should handle non-text content type', async () => {
            mockHandleGetTaskTree.mockResolvedValue({
                content: [{ type: 'image', data: 'base64' }]
            });

            const result = await handleExportTaskTreeMarkdown(
                { conversation_id: 'conv-123' },
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain("n'est pas du texte");
        });

        test('should handle tree retrieval throwing an error', async () => {
            mockHandleGetTaskTree.mockRejectedValue(new Error('Tree API failed'));

            const result = await handleExportTaskTreeMarkdown(
                { conversation_id: 'conv-123' },
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('Tree API failed');
        });
    });

    // ============================================================
    // File Export
    // ============================================================
    describe('file export', () => {
        test('should write to absolute file path', async () => {
            const args: ExportTaskTreeMarkdownArgs = {
                conversation_id: 'conv-123',
                filePath: '/tmp/tree-export.md',
            };

            const result = await handleExportTaskTreeMarkdown(
                args,
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(result.isError).toBeUndefined();
            expect(fs.mkdir).toHaveBeenCalled();
            expect(fs.writeFile).toHaveBeenCalledWith(
                '/tmp/tree-export.md',
                sampleTreeOutput,
                'utf8'
            );
            expect(getTextContent(result)).toContain('exporté avec succès');
            expect(getTextContent(result)).toContain('ascii-tree');
        });

        test('should resolve relative path using workspace from cache', async () => {
            const args: ExportTaskTreeMarkdownArgs = {
                conversation_id: 'conv-123',
                filePath: 'output/tree.md',
            };

            const result = await handleExportTaskTreeMarkdown(
                args,
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(result.isError).toBeUndefined();
            // Should have resolved relative to workspace
            const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
            const writtenPath = writeCall[0] as string;
            expect(writtenPath).toContain('workspace');
            expect(writtenPath).toContain('output');
        });

        test('should handle relative path when conversation not in cache', async () => {
            const emptyCache = new Map<string, ConversationSkeleton>();

            const args: ExportTaskTreeMarkdownArgs = {
                conversation_id: 'conv-123',
                filePath: 'output/tree.md',
            };

            const result = await handleExportTaskTreeMarkdown(
                args,
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                emptyCache
            );

            // Should still succeed - just won't resolve the relative path
            expect(result.isError).toBeUndefined();
            expect(fs.writeFile).toHaveBeenCalled();
        });

        test('should handle fs write error', async () => {
            vi.mocked(fs.writeFile).mockRejectedValue(new Error('EACCES: permission denied'));

            const args: ExportTaskTreeMarkdownArgs = {
                conversation_id: 'conv-123',
                filePath: '/protected/tree.md',
            };

            const result = await handleExportTaskTreeMarkdown(
                args,
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(result.isError).toBe(true);
            expect(getTextContent(result)).toContain('permission denied');
        });

        test('should show preview with line count for exported file', async () => {
            // Generate content with many lines
            const manyLines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
            mockHandleGetTaskTree.mockResolvedValue({
                content: [{ type: 'text', text: manyLines }]
            });

            const args: ExportTaskTreeMarkdownArgs = {
                conversation_id: 'conv-123',
                filePath: '/tmp/big-tree.md',
            };

            const result = await handleExportTaskTreeMarkdown(
                args,
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(result.isError).toBeUndefined();
            const text = getTextContent(result);
            expect(text).toContain('Lignes:** 100');
            expect(text).toContain('fichier complet sauvegardé');
        });

        test('should not show truncation notice for short files', async () => {
            const shortContent = 'Line 1\nLine 2\nLine 3';
            mockHandleGetTaskTree.mockResolvedValue({
                content: [{ type: 'text', text: shortContent }]
            });

            const args: ExportTaskTreeMarkdownArgs = {
                conversation_id: 'conv-123',
                filePath: '/tmp/short-tree.md',
            };

            const result = await handleExportTaskTreeMarkdown(
                args,
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            const text = getTextContent(result);
            expect(text).not.toContain('fichier complet sauvegardé');
            expect(text).toContain('Lignes:** 3');
        });
    });

    // ============================================================
    // Output Formats
    // ============================================================
    describe('output formats', () => {
        test('should pass ascii-tree format by default', async () => {
            await handleExportTaskTreeMarkdown(
                { conversation_id: 'conv-123' },
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(mockHandleGetTaskTree).toHaveBeenCalledWith(
                expect.objectContaining({ output_format: 'ascii-tree' })
            );
        });

        test('should pass json format when specified', async () => {
            await handleExportTaskTreeMarkdown(
                { conversation_id: 'conv-123', output_format: 'json' },
                mockHandleGetTaskTree,
                mockEnsureSkeletonCacheIsFresh,
                mockConversationCache
            );

            expect(mockHandleGetTaskTree).toHaveBeenCalledWith(
                expect.objectContaining({ output_format: 'json' })
            );
        });
    });
});
