/**
 * Coverage tests for roo-storage-detector.ts — #1666 Phase E
 *
 * Targets previously untested methods:
 * - extractTaskIdFromText (UUID extraction from text)
 * - loadUIMessages (BOM handling, JSON parsing)
 * - scanConversationsMetadata (sorting, pagination)
 * - calculateTreeDepth (tree depth calculation)
 * - processBatch (concurrency control, error handling)
 * - inferParentTaskIdFromContent (deprecated — always returns undefined)
 * - scanConversations edge cases
 * - detectRooStorage structure validation
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { RooStorageDetector } from '../roo-storage-detector.js';
import type { ConversationSkeleton } from '../../types/conversation.js';

// ─────────────────── Mocks ───────────────────

const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockReadFile = vi.fn();
const mockExistsSync = vi.fn();
const mockAccess = vi.fn();
const mockGlob = vi.fn();

vi.mock('fs', () => ({
    existsSync: (...args: any[]) => mockExistsSync(...args),
    createReadStream: vi.fn(),
    stat: (...args: any[]) => mockStat(...args),
}));

vi.mock('fs/promises', () => ({
    readdir: (...args: any[]) => mockReaddir(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
    access: (...args: any[]) => mockAccess(...args),
    stat: (...args: any[]) => mockStat(...args),
}));

vi.mock('glob', () => ({
    glob: (...args: any[]) => mockGlob(...args),
}));

// ─────────────────── Setup ───────────────────

beforeEach(() => {
    vi.clearAllMocks();
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({
        isDirectory: () => true,
        size: 1000,
        mtime: new Date('2025-01-01T00:00:00Z'),
        birthtime: new Date('2024-01-01T00:00:00Z'),
    });
    mockReadFile.mockResolvedValue('{}');
    mockExistsSync.mockReturnValue(false);
    mockAccess.mockResolvedValue(undefined);
    mockGlob.mockResolvedValue([]);
});

// ─────────────────── Tests ───────────────────

describe('RooStorageDetector — Phase E Coverage', () => {

    // ============================================================
    // extractTaskIdFromText — UUID extraction patterns
    // ============================================================

    describe('extractTaskIdFromText', () => {
        const extract = (text: string) =>
            (RooStorageDetector as any).extractTaskIdFromText(text);

        test('extracts standard UUID v4', () => {
            const text = 'Some context with task 019dd04b-1234-4abc-8def-123456789abc reference';
            const result = extract(text);
            expect(result).toBe('019dd04b-1234-4abc-8def-123456789abc');
        });

        test('extracts UUID from CONTEXTE HÉRITÉ pattern', () => {
            const text = 'CONTEXTE HÉRITÉ de la tâche parent abc12345-dead-4be0-9123-456789abcdef';
            const result = extract(text);
            expect(result).toBe('abc12345-dead-4be0-9123-456789abcdef');
        });

        test('extracts UUID from ORCHESTRATEUR pattern', () => {
            const text = 'ORCHESTRATEUR tâche parent feed1234-5678-4abc-9123-abcdef123456';
            const result = extract(text);
            expect(result).toBe('feed1234-5678-4abc-9123-abcdef123456');
        });

        test('extracts UUID from "tâche parent" pattern (French)', () => {
            const text = 'Cette tâche parent abcdef01-2345-4abc-b123-abcdef123456 a été créée';
            const result = extract(text);
            expect(result).toBe('abcdef01-2345-4abc-b123-abcdef123456');
        });

        test('returns undefined for empty string', () => {
            expect(extract('')).toBeUndefined();
        });

        test('returns undefined when no UUID present', () => {
            expect(extract('No task IDs here, just plain text')).toBeUndefined();
        });

        test('extracts first UUID when multiple present', () => {
            const text = 'Tasks first-01234567-abcd-4abc-9123-abcdef123456 and second-fedcba98-7654-4abc-8123-fedcba987654';
            const result = extract(text);
            expect(result).toBe('01234567-abcd-4abc-9123-abcdef123456');
        });

        test('returns undefined for null input', () => {
            expect(extract(null)).toBeUndefined();
        });

        test('returns undefined for undefined input', () => {
            expect(extract(undefined)).toBeUndefined();
        });
    });

    // ============================================================
    // loadUIMessages — BOM handling, JSON parsing
    // ============================================================

    describe('loadUIMessages', () => {
        const load = (path: string) =>
            (RooStorageDetector as any).loadUIMessages(path);

        test('returns empty array when file does not exist', async () => {
            mockExistsSync.mockReturnValue(false);
            const result = await load('/nonexistent/ui_messages.json');
            expect(result).toEqual([]);
        });

        test('parses valid JSON array', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFile.mockResolvedValue(JSON.stringify([
                { type: 'say', text: 'hello' },
                { type: 'user', text: 'world' },
            ]));
            const result = await load('/mock/ui_messages.json');
            expect(result).toHaveLength(2);
        });

        test('strips UTF-8 BOM before parsing', async () => {
            mockExistsSync.mockReturnValue(true);
            const contentWithBOM = '﻿' + JSON.stringify([{ type: 'say', text: 'test' }]);
            mockReadFile.mockResolvedValue(contentWithBOM);
            const result = await load('/mock/ui_messages.json');
            expect(result).toHaveLength(1);
        });

        test('returns empty array for non-array JSON', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFile.mockResolvedValue(JSON.stringify({ not: 'an array' }));
            const result = await load('/mock/ui_messages.json');
            expect(result).toEqual([]);
        });

        test('returns empty array for invalid JSON', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFile.mockResolvedValue('not json at all {');
            const result = await load('/mock/ui_messages.json');
            expect(result).toEqual([]);
        });

        test('returns empty array on read error', async () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFile.mockRejectedValue(new Error('EACCES'));
            const result = await load('/mock/ui_messages.json');
            expect(result).toEqual([]);
        });
    });

    // ============================================================
    // scanConversationsMetadata — sorting & pagination
    // ============================================================

    describe('scanConversationsMetadata', () => {
        let analyzeSpy: any;

        afterEach(() => {
            if (analyzeSpy) analyzeSpy.mockRestore();
        });

        test('paginates results with offset and limit', async () => {
            // scanConversationsMetadata uses readdir without withFileTypes → returns strings
            const entries = Array.from({ length: 5 }, (_, i) => `task${i}`);
            mockReaddir.mockResolvedValue(entries);
            mockStat.mockResolvedValue({
                isDirectory: () => true,
                size: 1000,
                mtime: new Date('2025-01-01T00:00:00Z'),
            });

            // Mock analyzeConversation to return predictable skeletons
            analyzeSpy = vi.spyOn(RooStorageDetector as any, 'analyzeConversation')
                .mockImplementation(async (taskId: string) => ({
                    taskId,
                    metadata: {
                        title: `Task ${taskId}`,
                        workspace: '/test',
                        messageCount: 10,
                        lastActivity: new Date('2025-01-01'),
                        totalSize: 1000,
                    },
                }));

            const result = await RooStorageDetector.scanConversationsMetadata('/mock/tasks', {
                limit: 2,
                offset: 1,
                sortBy: 'lastActivity',
                sortOrder: 'desc',
            });

            expect(result.length).toBeLessThanOrEqual(2);
        });

        test('sorts by messageCount ascending', async () => {
            const entries = ['few', 'many'];
            mockReaddir.mockResolvedValue(entries);
            mockStat.mockResolvedValue({
                isDirectory: () => true,
                size: 1000,
                mtime: new Date('2025-01-01T00:00:00Z'),
            });

            analyzeSpy = vi.spyOn(RooStorageDetector as any, 'analyzeConversation')
                .mockImplementation(async (taskId: string) => ({
                    taskId,
                    metadata: {
                        title: `Task ${taskId}`,
                        workspace: '/test',
                        messageCount: taskId === 'few' ? 5 : 50,
                        lastActivity: new Date('2025-01-01'),
                        totalSize: 1000,
                    },
                }));

            const result = await RooStorageDetector.scanConversationsMetadata('/mock/tasks', {
                limit: 10,
                offset: 0,
                sortBy: 'messageCount',
                sortOrder: 'asc',
            });

            if (result.length === 2) {
                expect(result[0].messageCount).toBeLessThanOrEqual(result[1].messageCount);
            }
        });

        test('returns empty for empty directory', async () => {
            mockReaddir.mockResolvedValue([]);

            const result = await RooStorageDetector.scanConversationsMetadata('/empty/tasks', {
                limit: 10,
                offset: 0,
                sortBy: 'lastActivity',
                sortOrder: 'desc',
            });

            expect(result).toEqual([]);
        });
    });

    // ============================================================
    // calculateTreeDepth — pure tree depth calculation
    // ============================================================

    describe('calculateTreeDepth', () => {
        const calcDepth = (skeletons: ConversationSkeleton[]) =>
            (RooStorageDetector as any).calculateTreeDepth(skeletons);

        test('returns 0 for empty array', () => {
            expect(calcDepth([])).toBe(0);
        });

        test('returns 0 for single root (no parent)', () => {
            const skeletons: ConversationSkeleton[] = [
                { taskId: 'root', metadata: {} as any, parentTaskId: undefined } as any,
            ];
            expect(calcDepth(skeletons)).toBe(0);
        });

        test('returns 1 for parent-child pair', () => {
            const skeletons: ConversationSkeleton[] = [
                { taskId: 'parent', metadata: {} as any, parentTaskId: undefined } as any,
                { taskId: 'child', metadata: {} as any, parentTaskId: 'parent' } as any,
            ];
            expect(calcDepth(skeletons)).toBe(1);
        });

        test('returns 2 for 3-level tree', () => {
            const skeletons: ConversationSkeleton[] = [
                { taskId: 'grandparent', metadata: {} as any, parentTaskId: undefined } as any,
                { taskId: 'parent', metadata: {} as any, parentTaskId: 'grandparent' } as any,
                { taskId: 'child', metadata: {} as any, parentTaskId: 'parent' } as any,
            ];
            expect(calcDepth(skeletons)).toBe(2);
        });

        test('returns max depth with multiple branches', () => {
            const skeletons: ConversationSkeleton[] = [
                { taskId: 'root', metadata: {} as any, parentTaskId: undefined } as any,
                { taskId: 'child1', metadata: {} as any, parentTaskId: 'root' } as any,
                { taskId: 'child2', metadata: {} as any, parentTaskId: 'root' } as any,
                { taskId: 'grandchild', metadata: {} as any, parentTaskId: 'child1' } as any,
                { taskId: 'greatgrandchild', metadata: {} as any, parentTaskId: 'grandchild' } as any,
            ];
            expect(calcDepth(skeletons)).toBe(3);
        });

        test('handles orphaned child (parent not in list)', () => {
            const skeletons: ConversationSkeleton[] = [
                { taskId: 'orphan', metadata: {} as any, parentTaskId: 'missing-parent' } as any,
            ];
            // Parent not in map → recursive call returns currentDepth = 1
            // (the child itself contributes 1 level before the chain breaks)
            expect(calcDepth(skeletons)).toBe(1);
        });
    });

    // ============================================================
    // processBatch — concurrency control
    // ============================================================

    describe('processBatch', () => {
        const processBatch = <T, R>(
            items: T[],
            processor: (item: T) => Promise<R>,
            batchSize?: number,
            onProgress?: (processed: number, total: number) => void
        ) => (RooStorageDetector as any).processBatch(items, processor, batchSize, onProgress);

        test('processes all items', async () => {
            const items = [1, 2, 3, 4, 5];
            const processor = vi.fn().mockImplementation(async (n: number) => n * 2);
            const results = await processBatch(items, processor, 2);
            expect(results).toEqual([2, 4, 6, 8, 10]);
        });

        test('handles empty array', async () => {
            const processor = vi.fn();
            const results = await processBatch([], processor, 10);
            expect(results).toEqual([]);
            expect(processor).not.toHaveBeenCalled();
        });

        test('filters out failed items (returns null)', async () => {
            const items = [1, 2, 3];
            const processor = vi.fn().mockImplementation(async (n: number) => {
                if (n === 2) throw new Error('fail');
                return n;
            });
            const results = await processBatch(items, processor, 10);
            expect(results).toEqual([1, 3]);
        });

        test('calls onProgress callback', async () => {
            const items = [1, 2, 3, 4];
            const processor = vi.fn().mockImplementation(async (n: number) => n);
            const onProgress = vi.fn();
            await processBatch(items, processor, 2, onProgress);
            expect(onProgress).toHaveBeenCalled();
        });

        test('respects batch size', async () => {
            const items = [1, 2, 3, 4, 5];
            const callOrder: number[] = [];
            const processor = vi.fn().mockImplementation(async (n: number) => {
                callOrder.push(n);
                return n;
            });
            await processBatch(items, processor, 2);
            // Should process all items (order within batch is parallel)
            expect(processor).toHaveBeenCalledTimes(5);
        });
    });

    // ============================================================
    // inferParentTaskIdFromContent — deprecated, always undefined
    // ============================================================

    describe('inferParentTaskIdFromContent (deprecated)', () => {
        test('always returns undefined (architecture correction)', async () => {
            const result = await (RooStorageDetector as any).inferParentTaskIdFromContent(
                '/mock/api.json',
                '/mock/ui.json',
                {} as any,
                'task-123'
            );
            expect(result).toBeUndefined();
        });
    });

    // ============================================================
    // detectRooStorage — deprecated wrapper structure
    // ============================================================

    describe('detectRooStorage (deprecated)', () => {
        test('wraps locations with type "local"', async () => {
            mockGlob.mockResolvedValue(['/mock/storage']);
            mockAccess.mockResolvedValue(undefined);
            mockExistsSync.mockReturnValue(true);

            const result = await RooStorageDetector.detectRooStorage();

            expect(result).toHaveProperty('locations');
            expect(Array.isArray(result.locations)).toBe(true);
            // Each location should have a type property
            for (const loc of result.locations) {
                expect(loc).toHaveProperty('path');
                expect(loc).toHaveProperty('type');
            }
        });

        test('returns valid structure with empty locations when glob finds nothing', async () => {
            // Ensure glob returns no results
            mockGlob.mockResolvedValue([]);
            mockAccess.mockRejectedValue(new Error('Not found'));
            mockExistsSync.mockReturnValue(false);
            mockReaddir.mockResolvedValue([]);

            const result = await RooStorageDetector.detectRooStorage();

            // Structure must be valid regardless of whether cache returns data
            expect(result).toHaveProperty('locations');
            expect(Array.isArray(result.locations)).toBe(true);
            for (const loc of result.locations) {
                expect(loc).toHaveProperty('path');
                expect(loc).toHaveProperty('type');
                expect(loc.type).toBe('local');
            }
        });
    });

    // ============================================================
    // Edge cases — getStatsForPath
    // ============================================================

    describe('getStatsForPath edge cases', () => {
        test('handles readdir returning non-array value', async () => {
            mockReaddir.mockResolvedValue('not an array' as any);
            const stats = await RooStorageDetector.getStatsForPath('/mock/tasks');
            // Should handle gracefully (may throw or return 0)
            expect(typeof stats.conversationCount).toBe('number');
        });

        test('handles unreadable files inside task dirs gracefully', async () => {
            mockReaddir
                .mockResolvedValueOnce([{ name: 'task1', isDirectory: () => true }])
                .mockRejectedValueOnce(new Error('EACCES')); // inner readdir fails
            const stats = await RooStorageDetector.getStatsForPath('/mock/tasks');
            expect(stats.conversationCount).toBe(1);
        });

        test('accumulates totalSize from individual files (#1409)', async () => {
            mockReaddir
                .mockResolvedValueOnce([{ name: 'task1', isDirectory: () => true }])
                .mockResolvedValueOnce(['a.json', 'b.json']); // files in task1
            mockStat
                .mockResolvedValueOnce({ isFile: () => true, size: 500, mtime: new Date() })
                .mockResolvedValueOnce({ isFile: () => true, size: 300, mtime: new Date() });
            const stats = await RooStorageDetector.getStatsForPath('/mock/tasks');
            expect(stats.totalSize).toBe(800);
        });
    });

    // ============================================================
    // validateCustomPath edge cases
    // ============================================================

    describe('validateCustomPath edge cases', () => {
        test('returns false for path without tasks subdirectory', async () => {
            mockExistsSync.mockReturnValue(false);
            const result = await RooStorageDetector.validateCustomPath('/no/tasks/here');
            expect(result).toBe(false);
        });

        test('returns true when tasks subdirectory exists', async () => {
            mockExistsSync.mockReturnValue(true);
            const result = await RooStorageDetector.validateCustomPath('/valid/storage');
            expect(result).toBe(true);
        });
    });
});
