/**
 * server-helpers.test.ts - Tests pour les utilitaires du serveur MCP
 *
 * Couvre:
 * - getSharedStatePath(): résolution du chemin shared-state
 * - truncateResult(): troncature des résultats trop longs
 * - handleTouchMcpSettings(): touch du fichier mcp_settings.json
 * - handleExportConversationJson(): délégation export JSON
 * - handleExportConversationCsv(): délégation export CSV
 *
 * @module server-helpers.test
 * @version 1.0.0
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';

// Mock fs before importing module
vi.mock('fs', () => {
    const actual = vi.importActual('fs');
    return {
        ...actual,
        default: actual,
        promises: {
            access: vi.fn(),
            utimes: vi.fn(),
            mkdir: vi.fn(),
            writeFile: vi.fn(),
            readFile: vi.fn(),
        }
    };
});

// Mock child_process
vi.mock('child_process', () => ({
    exec: vi.fn(),
}));

// Mock tools/index.js
vi.mock('../../tools/index.js', () => ({
    handleExportConversationJson: vi.fn(async () => '{"export": "json"}'),
    handleExportConversationCsv: vi.fn(async () => 'col1,col2\nval1,val2'),
}));

// Mock roo-storage-detector
vi.mock('../roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detect: vi.fn(),
    }
}));

// Mock server-config
vi.mock('../../config/server-config.js', () => ({
    OUTPUT_CONFIG: {
        MAX_OUTPUT_LENGTH: 100, // Small value for testing truncation
    }
}));

import { promises as fs } from 'fs';
import {
    getSharedStatePath,
    truncateResult,
    handleTouchMcpSettings,
    handleExportConversationJson,
    handleExportConversationCsv,
} from '../server-helpers.js';
import * as toolExports from '../../tools/index.js';

describe('server-helpers', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ============================================================
    // getSharedStatePath
    // ============================================================
    describe('getSharedStatePath', () => {
        const originalEnv = process.env.ROOSYNC_SHARED_PATH;

        afterEach(() => {
            if (originalEnv !== undefined) {
                process.env.ROOSYNC_SHARED_PATH = originalEnv;
            } else {
                delete process.env.ROOSYNC_SHARED_PATH;
            }
        });

        test('should return ROOSYNC_SHARED_PATH when env var is set', () => {
            process.env.ROOSYNC_SHARED_PATH = '/custom/shared-state';
            const result = getSharedStatePath();
            expect(result).toBe('/custom/shared-state');
        });

        test('should return fallback path when env var is not set', () => {
            delete process.env.ROOSYNC_SHARED_PATH;
            const result = getSharedStatePath();
            // Should contain roo-config/shared-state in the path
            expect(result).toContain('shared-state');
        });

        test('should return fallback path when env var is empty string', () => {
            process.env.ROOSYNC_SHARED_PATH = '';
            const result = getSharedStatePath();
            // Empty string is falsy, so should use fallback
            expect(result).toContain('shared-state');
        });
    });

    // ============================================================
    // truncateResult
    // ============================================================
    describe('truncateResult', () => {
        test('should not truncate short content', () => {
            const result: CallToolResult = {
                content: [{ type: 'text', text: 'Short text' }]
            };
            const truncated = truncateResult(result);
            expect(truncated.content[0]).toHaveProperty('text', 'Short text');
        });

        test('should truncate content exceeding MAX_OUTPUT_LENGTH', () => {
            const longText = 'A'.repeat(200); // > 100 (mocked MAX_OUTPUT_LENGTH)
            const result: CallToolResult = {
                content: [{ type: 'text', text: longText }]
            };
            const truncated = truncateResult(result);
            const text = (truncated.content[0] as any).text;
            expect(text.length).toBeLessThan(longText.length);
            expect(text).toContain('OUTPUT TRUNCATED');
        });

        test('should handle multiple content items', () => {
            const result: CallToolResult = {
                content: [
                    { type: 'text', text: 'Short' },
                    { type: 'text', text: 'B'.repeat(200) }
                ]
            };
            const truncated = truncateResult(result);
            expect((truncated.content[0] as any).text).toBe('Short');
            expect((truncated.content[1] as any).text).toContain('OUTPUT TRUNCATED');
        });

        test('should not truncate non-text content types', () => {
            const result: CallToolResult = {
                content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' } as any]
            };
            const truncated = truncateResult(result);
            expect(truncated.content[0]).toEqual({ type: 'image', data: 'base64data', mimeType: 'image/png' });
        });

        test('should handle empty content array', () => {
            const result: CallToolResult = { content: [] };
            const truncated = truncateResult(result);
            expect(truncated.content).toEqual([]);
        });
    });

    // ============================================================
    // handleTouchMcpSettings
    // ============================================================
    describe('handleTouchMcpSettings', () => {
        test('should touch mcp_settings.json successfully', async () => {
            vi.mocked(fs.access).mockResolvedValue(undefined);
            vi.mocked(fs.utimes).mockResolvedValue(undefined);

            const result = await handleTouchMcpSettings();

            expect(result.isError).toBeUndefined();
            const text = (result.content[0] as any).text;
            const parsed = JSON.parse(text);
            expect(parsed.success).toBe(true);
            expect(parsed.message).toContain('touché avec succès');
            expect(parsed.path).toContain('mcp_settings.json');
        });

        test('should return error when file does not exist', async () => {
            vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

            const result = await handleTouchMcpSettings();

            expect(result.isError).toBe(true);
            const text = (result.content[0] as any).text;
            const parsed = JSON.parse(text);
            expect(parsed.success).toBe(false);
            expect(parsed.error).toContain('introuvable');
        });

        test('should return error when utimes fails', async () => {
            vi.mocked(fs.access).mockResolvedValue(undefined);
            vi.mocked(fs.utimes).mockRejectedValue(new Error('Permission denied'));

            const result = await handleTouchMcpSettings();

            expect(result.isError).toBe(true);
            const text = (result.content[0] as any).text;
            const parsed = JSON.parse(text);
            expect(parsed.success).toBe(false);
            expect(parsed.error).toContain('Permission denied');
        });
    });

    // ============================================================
    // handleExportConversationJson
    // ============================================================
    describe('handleExportConversationJson', () => {
        let conversationCache: Map<string, ConversationSkeleton>;

        beforeEach(() => {
            conversationCache = new Map();
            conversationCache.set('task-123', {
                id: 'task-123',
                messages: [],
                metadata: {
                    workspace: '/test/workspace',
                    totalMessages: 0,
                    timestamp: new Date().toISOString(),
                }
            } as any);
        });

        test('should export JSON successfully', async () => {
            const result = await handleExportConversationJson(
                { taskId: 'task-123' },
                conversationCache
            );

            expect(result.isError).toBeUndefined();
            expect((result.content[0] as any).text).toBe('{"export": "json"}');
            expect(toolExports.handleExportConversationJson).toHaveBeenCalled();
        });

        test('should return error when taskId is missing', async () => {
            const result = await handleExportConversationJson(
                { taskId: '' },
                conversationCache
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('taskId est requis');
        });

        test('should return error when conversation not found', async () => {
            const result = await handleExportConversationJson(
                { taskId: 'unknown-task' },
                conversationCache
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('introuvable');
        });

        test('should pass jsonVariant and truncationChars to handler', async () => {
            await handleExportConversationJson(
                { taskId: 'task-123', jsonVariant: 'full', truncationChars: 500 },
                conversationCache
            );

            expect(toolExports.handleExportConversationJson).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskId: 'task-123',
                    jsonVariant: 'full',
                    truncationChars: 500
                }),
                expect.any(Function) // getConversationSkeleton callback
            );
        });

        test('should handle export handler errors', async () => {
            vi.mocked(toolExports.handleExportConversationJson).mockRejectedValue(
                new Error('Export failed')
            );

            const result = await handleExportConversationJson(
                { taskId: 'task-123' },
                conversationCache
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('Export failed');
        });
    });

    // ============================================================
    // handleExportConversationCsv
    // ============================================================
    describe('handleExportConversationCsv', () => {
        let conversationCache: Map<string, ConversationSkeleton>;

        beforeEach(() => {
            conversationCache = new Map();
            conversationCache.set('task-456', {
                id: 'task-456',
                messages: [],
                metadata: {
                    workspace: '/test/workspace',
                    totalMessages: 0,
                    timestamp: new Date().toISOString(),
                }
            } as any);
        });

        test('should export CSV successfully', async () => {
            const result = await handleExportConversationCsv(
                { taskId: 'task-456' },
                conversationCache
            );

            expect(result.isError).toBeUndefined();
            expect((result.content[0] as any).text).toBe('col1,col2\nval1,val2');
            expect(toolExports.handleExportConversationCsv).toHaveBeenCalled();
        });

        test('should return error when taskId is missing', async () => {
            const result = await handleExportConversationCsv(
                { taskId: '' },
                conversationCache
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('taskId est requis');
        });

        test('should return error when conversation not found', async () => {
            const result = await handleExportConversationCsv(
                { taskId: 'unknown-task' },
                conversationCache
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('introuvable');
        });

        test('should pass csvVariant to handler', async () => {
            await handleExportConversationCsv(
                { taskId: 'task-456', csvVariant: 'tools' },
                conversationCache
            );

            expect(toolExports.handleExportConversationCsv).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskId: 'task-456',
                    csvVariant: 'tools'
                }),
                expect.any(Function)
            );
        });

        test('should handle export handler errors', async () => {
            vi.mocked(toolExports.handleExportConversationCsv).mockRejectedValue(
                new Error('CSV generation failed')
            );

            const result = await handleExportConversationCsv(
                { taskId: 'task-456' },
                conversationCache
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('CSV generation failed');
        });
    });
});
