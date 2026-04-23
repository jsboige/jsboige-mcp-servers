import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
    exportTaskTreeMarkdownTool,
    handleExportTaskTreeMarkdown,
    type ExportTaskTreeMarkdownArgs,
} from '../task/export-tree-md.tool.js';

function makeMockTreeResult(text: string) {
    return {
        content: [{ type: 'text' as const, text }],
    };
}

describe('export-tree-md.tool', () => {
    describe('tool definition', () => {
        it('should have correct name', () => {
            expect(exportTaskTreeMarkdownTool.name).toBe('export_task_tree_markdown');
        });

        it('should require conversation_id', () => {
            const schema = exportTaskTreeMarkdownTool.inputSchema;
            expect(schema.required).toContain('conversation_id');
        });

        it('should define output_format enum', () => {
            const props = exportTaskTreeMarkdownTool.inputSchema.properties;
            expect(props.output_format.enum).toEqual(['ascii-tree', 'markdown', 'hierarchical', 'json']);
        });

        it('should have default values for optional fields', () => {
            const props = exportTaskTreeMarkdownTool.inputSchema.properties;
            expect(props.include_siblings.default).toBe(true);
            expect(props.output_format.default).toBe('ascii-tree');
            expect(props.truncate_instruction.default).toBe(80);
            expect(props.show_metadata.default).toBe(false);
        });
    });

    describe('handleExportTaskTreeMarkdown', () => {
        const mockEnsureFresh = vi.fn();
        const conversation_id = 'test-conv-1';

        const successTree = vi.fn().mockResolvedValue(makeMockTreeResult(
            'Task root\n  ├── Task child 1\n  └── Task child 2',
        ));

        it('should return tree content when no filePath specified', async () => {
            const result = await handleExportTaskTreeMarkdown(
                { conversation_id } as ExportTaskTreeMarkdownArgs,
                successTree,
                mockEnsureFresh,
            );

            expect(result.content[0].type).toBe('text');
            expect((result.content[0] as any).text).toContain('Task root');
            expect(result.isError).toBeUndefined();
        });

        it('should throw error when conversation_id is missing', async () => {
            const result = await handleExportTaskTreeMarkdown(
                {} as ExportTaskTreeMarkdownArgs,
                successTree,
                mockEnsureFresh,
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('conversation_id');
        });

        it('should handle empty tree result gracefully', async () => {
            const emptyTree = vi.fn().mockResolvedValue({
                content: [],
            });

            const result = await handleExportTaskTreeMarkdown(
                { conversation_id } as ExportTaskTreeMarkdownArgs,
                emptyTree,
                mockEnsureFresh,
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('Erreur');
        });

        it('should handle non-text content type', async () => {
            const imageTree = vi.fn().mockResolvedValue({
                content: [{ type: 'image', data: 'base64...' }],
            });

            const result = await handleExportTaskTreeMarkdown(
                { conversation_id } as ExportTaskTreeMarkdownArgs,
                imageTree,
                mockEnsureFresh,
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('texte');
        });

        it('should save to file when filePath is specified', async () => {
            const tmpDir = path.join(os.tmpdir(), `export-tree-test-${Date.now()}`);
            const filePath = path.join(tmpDir, 'tree.md');

            try {
                const result = await handleExportTaskTreeMarkdown(
                    { conversation_id, filePath } as ExportTaskTreeMarkdownArgs,
                    successTree,
                    mockEnsureFresh,
                );

                expect(result.content[0].type).toBe('text');
                expect((result.content[0] as any).text).toContain('exporté avec succès');
                expect((result.content[0] as any).text).toContain(filePath);

                const written = await fs.readFile(filePath, 'utf8');
                expect(written).toContain('Task root');
            } finally {
                await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            }
        });

        it('should create parent directories when saving to file', async () => {
            const tmpDir = path.join(os.tmpdir(), `export-tree-nested-${Date.now()}`);
            const filePath = path.join(tmpDir, 'nested', 'deep', 'tree.md');

            try {
                const result = await handleExportTaskTreeMarkdown(
                    { conversation_id, filePath } as ExportTaskTreeMarkdownArgs,
                    successTree,
                    mockEnsureFresh,
                );

                expect((result.content[0] as any).text).toContain('exporté avec succès');
                const written = await fs.readFile(filePath, 'utf8');
                expect(written).toContain('Task root');
            } finally {
                await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            }
        });

        it('should resolve relative filePath using workspace from cache', async () => {
            const tmpDir = path.join(os.tmpdir(), `export-tree-rel-${Date.now()}`);
            await fs.mkdir(tmpDir, { recursive: true });

            const cache = new Map([
                ['test-conv-1', {
                    taskId: 'test-conv-1',
                    metadata: { workspace: tmpDir },
                    sequence: [],
                } as any],
            ]);

            try {
                const result = await handleExportTaskTreeMarkdown(
                    { conversation_id, filePath: 'output/tree.md' } as ExportTaskTreeMarkdownArgs,
                    successTree,
                    mockEnsureFresh,
                    cache,
                );

                expect((result.content[0] as any).text).toContain('exporté avec succès');

                const written = await fs.readFile(path.join(tmpDir, 'output', 'tree.md'), 'utf8');
                expect(written).toContain('Task root');
            } finally {
                await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
            }
        });

        it('should pass output_format to getTaskTree handler', async () => {
            const trackingTree = vi.fn().mockResolvedValue(makeMockTreeResult('json output'));

            await handleExportTaskTreeMarkdown(
                { conversation_id, output_format: 'json' } as ExportTaskTreeMarkdownArgs,
                trackingTree,
                mockEnsureFresh,
            );

            expect(trackingTree).toHaveBeenCalledWith(
                expect.objectContaining({ output_format: 'json' }),
            );
        });

        it('should handle handler throwing an exception', async () => {
            const failingTree = vi.fn().mockRejectedValue(new Error('Cache corrupted'));

            const result = await handleExportTaskTreeMarkdown(
                { conversation_id } as ExportTaskTreeMarkdownArgs,
                failingTree,
                mockEnsureFresh,
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('Cache corrupted');
        });
    });
});
