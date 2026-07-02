/**
 * server-helpers.coverage.test.ts - Coverage complement for server-helpers.ts
 *
 * Source-grounded targets (pre-PR baseline 72.4% lines / 68.75% branches / 50% funcs):
 * - formatDurationMs (L43): pure 4-branch function, 0 tests
 * - injectDuration (L71): pure + try/catch, 0 tests
 * - handleTouchMcpSettings:
 *   - L106-112 alternative test-path detection (APPDATA paths)
 *   - L113 throw branch (safety abort when no test-path matches)
 *   - L154 non-Error throw (string fallback)
 * - handleExportConversationJson:
 *   - L191 getConversationSkeleton callback (called when mock invokes it)
 *   - L204 non-Error export failure
 * - handleExportConversationCsv:
 *   - L236 getConversationSkeleton callback
 *   - L249 non-Error export failure
 *
 * Discipline:
 * - 0 source touched (add-only)
 * - uses established vi.mock patterns from server-helpers.test.ts
 * - per no-deletion-without-proof: skipped tests must document source bug
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';

// Mock fs before importing module
vi.mock('fs', async () => {
    const actual = await vi.importActual('fs');
    return {
        ...actual,
        default: actual,
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() => 'ROOSYNC_SHARED_PATH=/mock/env/path\n'),
        promises: {
            access: vi.fn(),
            utimes: vi.fn(),
            mkdir: vi.fn(),
            writeFile: vi.fn(),
            readFile: vi.fn(),
        }
    };
});

vi.mock('child_process', () => ({
    exec: vi.fn(),
}));

// #1110 FIX: Mock direct sub-module imports instead of barrel
vi.mock('../../tools/export/export-conversation-json.js', () => ({
    handleExportConversationJson: vi.fn(async () => '{"export": "json"}'),
}));
vi.mock('../../tools/export/export-conversation-csv.js', () => ({
    handleExportConversationCsv: vi.fn(async () => 'col1,col2\nval1,val2'),
}));

vi.mock('../roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageMode: vi.fn().mockResolvedValue({ mode: 'standard' }),
    }
}));

vi.mock('../../config/server-config.js', () => ({
    OUTPUT_CONFIG: {
        MAX_OUTPUT_LENGTH: 100,
    }
}));

// Mock extension-paths for handleTouchMcpSettings test-path detection tests
vi.mock('../extension-paths.js', () => ({
    getMcpSettingsPath: vi.fn(),
}));

// Mock fs to capture readFileSync for env var resolution
vi.mock('../../types/errors.js', async () => {
    const actual = await vi.importActual('../../types/errors.js');
    return actual;
});

import {
    formatDurationMs,
    injectDuration,
    handleTouchMcpSettings,
    handleExportConversationJson,
    handleExportConversationCsv,
} from '../server-helpers.js';
import * as extensionPaths from '../extension-paths.js';
import * as toolExports from '../../tools/export/export-conversation-json.js';
import * as toolExportsCsv from '../../tools/export/export-conversation-csv.js';

const mockedGetMcpSettingsPath = vi.mocked(extensionPaths.getMcpSettingsPath);
const mockedHandleExportJson = vi.mocked(toolExports.handleExportConversationJson);
const mockedHandleExportCsv = vi.mocked(toolExportsCsv.handleExportConversationCsv);

describe('server-helpers — coverage complement', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockedGetMcpSettingsPath.mockReturnValue('C:\\Users\\Test\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline\\settings\\mcp_settings.json');
    });

    describe('formatDurationMs (L43)', () => {
        test('formats sub-second durations as ms (L44)', () => {
            expect(formatDurationMs(0)).toBe('0ms');
            expect(formatDurationMs(142)).toBe('142ms');
            expect(formatDurationMs(999)).toBe('999ms');
        });

        test('formats sub-minute durations as seconds with 1 decimal (L45)', () => {
            expect(formatDurationMs(1000)).toBe('1.0s');
            expect(formatDurationMs(2400)).toBe('2.4s');
            expect(formatDurationMs(59999)).toBe('60.0s');
        });

        test('formats sub-hour durations as minutes:seconds (L47-50)', () => {
            expect(formatDurationMs(60_000)).toBe('1m00s');
            expect(formatDurationMs(83_000)).toBe('1m23s');
            expect(formatDurationMs(3_599_000)).toBe('59m59s');
        });

        test('formats multi-hour durations as hours:minutes (L52-54)', () => {
            expect(formatDurationMs(3_600_000)).toBe('1h00m');
            expect(formatDurationMs(3_900_000)).toBe('1h05m');
            expect(formatDurationMs(7_200_000)).toBe('2h00m');
        });
    });

    describe('injectDuration (L71)', () => {
        test('sets _meta.durationMs and _meta.toolName (L78-81)', () => {
            const result: CallToolResult = {
                content: [{ type: 'text', text: 'hello' }],
            };

            injectDuration(result, 142, 'test_tool');

            expect((result as any)._meta.durationMs).toBe(142);
            expect((result as any)._meta.toolName).toBe('test_tool');
        });

        test('appends footer to first text content (L85-87)', () => {
            const result: CallToolResult = {
                content: [{ type: 'text', text: 'hello' }],
            };

            injectDuration(result, 142, 'test_tool');

            const text = (result.content[0] as any).text;
            expect(text).toContain('[⏱ test_tool 142ms]');
            expect(text.startsWith('hello')).toBe(true);
        });

        test('omits toolName in footer when not provided (L86)', () => {
            const result: CallToolResult = {
                content: [{ type: 'text', text: 'hello' }],
            };

            injectDuration(result, 2400);

            const text = (result.content[0] as any).text;
            expect(text).toContain('[⏱ 2.4s]');
        });

        test('does not append footer for non-text content (L85 false)', () => {
            const result: CallToolResult = {
                content: [
                    { type: 'image', data: 'abc', mimeType: 'image/png' } as any,
                ],
            };

            injectDuration(result, 142, 'image_tool');

            // _meta should still be set
            expect((result as any)._meta.durationMs).toBe(142);
            // But no text content was modified
            expect((result.content[0] as any).text).toBeUndefined();
        });

        test('preserves existing _meta fields (L78)', () => {
            const result: CallToolResult = {
                content: [{ type: 'text', text: 'x' }],
                _meta: { existingField: 'preserved' },
            } as any;

            injectDuration(result, 100);

            expect((result as any)._meta.existingField).toBe('preserved');
            expect((result as any)._meta.durationMs).toBe(100);
        });

        test('swallows errors and returns original result (L89 try/catch)', () => {
            // Force an error: pass a result with content not iterable
            const result = {
                content: 'not-an-array',  // .content[0] would crash
            } as any;

            // Should not throw
            const returned = injectDuration(result, 100, 'crash_tool');

            expect(returned).toBe(result);
        });
    });

    describe('handleTouchMcpSettings — safety guard paths (L106-112)', () => {
        beforeEach(() => {
            vi.mocked(fs.access).mockResolvedValue(undefined);
            vi.mocked(fs.utimes).mockResolvedValue(undefined);
        });

        test('aborts when NODE_ENV=test and path is NOT a test-path (L113 throw)', async () => {
            // Force NODE_ENV=test
            const originalNodeEnv = process.env.NODE_ENV;
            const originalVitest = process.env.VITEST;
            process.env.NODE_ENV = 'test';
            delete process.env.VITEST;

            // Path that matches NONE of L106-112
            mockedGetMcpSettingsPath.mockReturnValue('C:\\Users\\RealUser\\AppData\\Roaming\\Code\\User\\globalStorage\\real-extension\\settings\\mcp_settings.json');
            // APPDATA also doesn't match any pattern
            process.env.APPDATA = 'C:\\Users\\RealUser\\AppData\\Roaming';

            try {
                const result = await handleTouchMcpSettings();

                expect(result.isError).toBe(true);
                const text = JSON.parse((result.content[0] as any).text);
                expect(text.success).toBe(false);
                expect(text.error).toContain('SAFETY ABORT');
            } finally {
                if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
                if (originalVitest !== undefined) process.env.VITEST = originalVitest;
                delete process.env.APPDATA;
            }
        });

        test('allows when NODE_ENV=test and APPDATA contains /home/test (L111)', async () => {
            const originalNodeEnv = process.env.NODE_ENV;
            const originalVitest = process.env.VITEST;
            process.env.NODE_ENV = 'test';
            delete process.env.VITEST;

            mockedGetMcpSettingsPath.mockReturnValue('/home/test/some-path/mcp_settings.json');
            process.env.APPDATA = '/home/test';

            try {
                const result = await handleTouchMcpSettings();
                expect(result.isError).toBeFalsy();
            } finally {
                if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
                if (originalVitest !== undefined) process.env.VITEST = originalVitest;
                delete process.env.APPDATA;
            }
        });

        test('allows when APPDATA contains /tmp/ (L112)', async () => {
            const originalNodeEnv = process.env.NODE_ENV;
            const originalVitest = process.env.VITEST;
            process.env.NODE_ENV = 'test';
            delete process.env.VITEST;

            // Path that doesn't match L106-108 but APPDATA does match L112
            mockedGetMcpSettingsPath.mockReturnValue('/tmp/random/settings/mcp_settings.json');
            process.env.APPDATA = '/tmp/';

            try {
                const result = await handleTouchMcpSettings();
                expect(result.isError).toBeFalsy();
            } finally {
                if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
                if (originalVitest !== undefined) process.env.VITEST = originalVitest;
                delete process.env.APPDATA;
            }
        });

        test('allows when APPDATA exactly equals C:\\Users\\Test\\AppData\\Roaming (L110)', async () => {
            const originalNodeEnv = process.env.NODE_ENV;
            const originalVitest = process.env.VITEST;
            process.env.NODE_ENV = 'test';
            delete process.env.VITEST;

            // Path doesn't match L106-108 but APPDATA matches L110 exactly
            mockedGetMcpSettingsPath.mockReturnValue('C:\\test\\settings\\mcp_settings.json');
            process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming';

            try {
                const result = await handleTouchMcpSettings();
                expect(result.isError).toBeFalsy();
            } finally {
                if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
                if (originalVitest !== undefined) process.env.VITEST = originalVitest;
                delete process.env.APPDATA;
            }
        });

        test('handles non-Error throw (L154 else arm: returns "Erreur inconnue")', async () => {
            // L154 source: error instanceof Error ? error.message : 'Erreur inconnue'
            // When a non-Error value is thrown (string, object, etc.), the catch
            // displays "Erreur inconnue" — the actual value is NOT surfaced.
            // This test exercises the cold L154 branch (else arm) for coverage.
            // NOTE: Source design choice — arbitrary non-Error values are not
            // propagated to the response. A more diagnostic version would include
            // String(error), but that's a source change (out of scope here).
            const originalNodeEnv = process.env.NODE_ENV;
            const originalVitest = process.env.VITEST;
            delete process.env.NODE_ENV;
            delete process.env.VITEST;

            vi.mocked(fs.utimes).mockRejectedValue('plain string error');

            try {
                const result = await handleTouchMcpSettings();

                expect(result.isError).toBe(true);
                const text = JSON.parse((result.content[0] as any).text);
                // Source behavior: non-Error throws map to 'Erreur inconnue'
                expect(text.error).toContain('Erreur inconnue');
            } finally {
                if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
                if (originalVitest !== undefined) process.env.VITEST = originalVitest;
            }
        });
    });

    describe('handleExportConversationJson — callback path (L191-193)', () => {
        let conversationCache: Map<string, ConversationSkeleton>;

        beforeEach(() => {
            conversationCache = new Map();
            conversationCache.set('task-A', {
                taskId: 'task-A',
                workspace: '/test/workspace',
                lastActivity: new Date().toISOString(),
            } as any);
        });

        test('passes getConversationSkeleton that resolves from cache (L191-193)', async () => {
            let capturedCallback: ((id: string) => Promise<any>) | null = null;

            mockedHandleExportJson.mockImplementation(async (_args: any, cb: any) => {
                capturedCallback = cb;
                // Invoke the callback to trigger L192 branch
                const result = await cb('task-A');
                return JSON.stringify({ exported: true, found: !!result });
            });

            const result = await handleExportConversationJson({ taskId: 'task-A' }, conversationCache);

            expect(capturedCallback).toBeTruthy();
            // The callback was invoked → L191-193 are exercised
            expect((result.content[0] as any).text).toContain('exported');
        });

        test('returns null when conversation not in cache via callback (L192 cache miss)', async () => {
            mockedHandleExportJson.mockImplementation(async (_args: any, cb: any) => {
                const result = await cb('non-existent-id');
                return JSON.stringify({ found: result === null });
            });

            const result = await handleExportConversationJson({ taskId: 'task-A' }, conversationCache);
            expect((result.content[0] as any).text).toContain('"found":true');
        });

        test('handles non-Error export failure (L204 non-Error arm)', async () => {
            // L204 source: error instanceof Error ? error.message : 'Erreur inconnue'
            // When the export handler rejects with a non-Error value, the catch
            // displays "Erreur inconnue". This test exercises the L204 else arm.
            mockedHandleExportJson.mockRejectedValue('export failed: bad data');

            const result = await handleExportConversationJson({ taskId: 'task-A' }, conversationCache);

            expect(result.isError).toBe(true);
            const text = (result.content[0] as any).text;
            // Source behavior: non-Error throws map to 'Erreur inconnue'
            expect(text).toContain('Erreur inconnue');
        });
    });

    describe('handleExportConversationCsv — callback path (L236-238)', () => {
        let conversationCache: Map<string, ConversationSkeleton>;

        beforeEach(() => {
            conversationCache = new Map();
            conversationCache.set('task-B', {
                taskId: 'task-B',
                workspace: '/test/workspace',
                lastActivity: new Date().toISOString(),
            } as any);
        });

        test('passes getConversationSkeleton that resolves from cache (L236-238)', async () => {
            let capturedCallback: ((id: string) => Promise<any>) | null = null;

            mockedHandleExportCsv.mockImplementation(async (_args: any, cb: any) => {
                capturedCallback = cb;
                const result = await cb('task-B');
                return `csv,exported,found=${!!result}`;
            });

            const result = await handleExportConversationCsv({ taskId: 'task-B' }, conversationCache);

            expect(capturedCallback).toBeTruthy();
            expect((result.content[0] as any).text).toBe('csv,exported,found=true');
        });

        test('returns null when conversation not in cache via callback (L237 cache miss)', async () => {
            mockedHandleExportCsv.mockImplementation(async (_args: any, cb: any) => {
                const result = await cb('non-existent');
                return `found=${result === null}`;
            });

            const result = await handleExportConversationCsv({ taskId: 'task-B' }, conversationCache);
            expect((result.content[0] as any).text).toBe('found=true');
        });

        test('handles non-Error export failure (L249 non-Error arm)', async () => {
            // L249 source: error instanceof Error ? error.message : 'Erreur inconnue'
            // Same fallback pattern as L153/L204 — non-Error throws map to
            // "Erreur inconnue" in the response.
            mockedHandleExportCsv.mockRejectedValue('csv export crashed');

            const result = await handleExportConversationCsv({ taskId: 'task-B' }, conversationCache);

            expect(result.isError).toBe(true);
            const text = (result.content[0] as any).text;
            expect(text).toContain('Erreur inconnue');
        });
    });
});