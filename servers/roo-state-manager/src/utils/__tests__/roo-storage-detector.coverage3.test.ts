/**
 * roo-storage-detector.coverage3.test.ts — Coverage complement c.31 (web1)
 *
 * Source-grounded (worktree fresh, post-c.30 baseline 39.68% statements / 75.12% branches / 68.29% functions):
 *
 * Cold functions covered below (13 → 8 in this PR, 5 deferred to c.32):
 *
 * F8  L308 scanConversations
 * F10 L400 analyzeWithNewSystem
 * F20 L1211 rebuildIndexFromExistingSkeletons
 * F21 L1278 getAllConversationsInWorkspace
 * F22 L1292 extractNewTaskInstructionsFromUI
 * F25 L1500 extractNewTaskInstructions
 * F28 L1545 getTaskPathById
 * F38 L1937 detectWorkspaceForTaskWithDetector
 *
 * Discipline (anti-churn #1936):
 * - 0 source touched (add-only *.coverage.test.ts)
 * - Each test names its source line anchor
 * - Mocks for fs/promises, fs, glob, WorkspaceDetector, MessageToSkeletonTransformer
 * - Spy on globalTaskInstructionIndex to avoid state leak
 *
 * SKIP-WITH-EVIDENCE (deferred to c.32 — too large / too coupled for one PR):
 * - F9  analyzeConversation (40 LOC public entry, depends on F10/F11)
 * - F11 analyzeWithOldSystem (291 LOC, complex multi-system fallback)
 * - F12 analyzeWithComparison (68 LOC, wraps F10+F11)
 * - F16 buildHierarchicalSkeletons (42 LOC public entry, uses HierarchyReconstructionEngine)
 * - F19 buildHierarchicalSkeletonsLegacy (231 LOC, full hierarchical rebuild)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { RooStorageDetector } from '../roo-storage-detector.js';
import * as path from 'path';

// ─────────────────── Mocks ───────────────────

const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockExistsSync = vi.fn();
const mockAccess = vi.fn();
const mockGlob = vi.fn();
const mockRebuildFromSkeletons = vi.fn();
const mockGetStats = vi.fn(() => ({ totalInstructions: 0, totalNodes: 0 }));
const mockExtractFromMessages = vi.fn(() => ({ instructions: [], errors: [] }));
const mockTransform = vi.fn();

vi.mock('fs', () => ({
    existsSync: (...args: any[]) => mockExistsSync(...args),
    createReadStream: vi.fn(),
    stat: (...args: any[]) => mockStat(...args),
}));

vi.mock('fs/promises', () => ({
    readdir: (...args: any[]) => mockReaddir(...args),
    readFile: (...args: any[]) => mockReadFile(...args),
    writeFile: (...args: any[]) => mockWriteFile(...args),
    access: (...args: any[]) => mockAccess(...args),
    stat: (...args: any[]) => mockStat(...args),
}));

vi.mock('glob', () => ({
    glob: (...args: any[]) => mockGlob(...args),
}));

// Mock globalTaskInstructionIndex (stateful singleton)
vi.mock('../task-instruction-index.js', () => ({
    globalTaskInstructionIndex: {
        addInstruction: vi.fn(),
        searchExactPrefix: vi.fn(() => []),
        getStats: () => mockGetStats(),
        rebuildFromSkeletons: (...args: any[]) => mockRebuildFromSkeletons(...args),
    },
    computeInstructionPrefix: (s: string) => s.substring(0, Math.min(s.length, 192)),
}));

// Mock globalCacheManager — every test gets fresh null cache to avoid cross-test state
vi.mock('../cache-manager.js', () => ({
    globalCacheManager: {
        get: vi.fn(() => Promise.resolve(null)),
        set: vi.fn(() => Promise.resolve(undefined)),
        delete: vi.fn(() => Promise.resolve(undefined)),
    },
}));

// Mock message-extraction-coordinator (dynamic import in F25)
vi.mock('../message-extraction-coordinator.js', () => ({
    messageExtractionCoordinator: {
        extractFromMessages: (...args: any[]) => mockExtractFromMessages(...args),
    },
}));

// Mock MessageToSkeletonTransformer (used by F10)
vi.mock('../message-to-skeleton-transformer.js', () => ({
    MessageToSkeletonTransformer: class {
        constructor(public opts: any) {}
        async transform(messages: any[], taskId: string, workspace?: string) {
            return mockTransform(messages, taskId, workspace, this.opts);
        }
    },
}));

// Mock WorkspaceDetector (used by F10/F38)
const mockWorkspaceDetect = vi.fn();
vi.mock('../workspace-detector.js', () => ({
    WorkspaceDetector: class {
        constructor(public opts: any) {}
        async detect(taskPath: string) {
            return mockWorkspaceDetect(taskPath, this.opts);
        }
    },
}));

// ─────────────────── Setup ───────────────────

beforeEach(() => {
    vi.clearAllMocks();
    // Reset env vars to avoid cross-test pollution (#1936 anti-pattern: shared state)
    delete process.env.ROO_DEBUG_INSTRUCTIONS;
    delete process.env.DEBUG_PARSING;
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({
        isDirectory: () => true,
        isFile: () => true,
        size: 1000,
        mtime: new Date('2025-01-01T00:00:00Z'),
        birthtime: new Date('2024-01-01T00:00:00Z'),
    });
    mockReadFile.mockResolvedValue('[]');
    mockWriteFile.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(false);
    // access: succeed by default (findPotentialStorageLocations walks basePaths)
    mockAccess.mockResolvedValue(undefined);
    mockGlob.mockResolvedValue([]);
    mockWorkspaceDetect.mockResolvedValue({
        workspace: 'mock-workspace',
        source: 'metadata',
        confidence: 0.9,
    });
    mockRebuildFromSkeletons.mockReturnValue(undefined);
    mockGetStats.mockReturnValue({ totalInstructions: 5, totalNodes: 3 });
    mockExtractFromMessages.mockReturnValue({ instructions: [], errors: [] });
    mockTransform.mockResolvedValue({
        skeleton: {
            taskId: 'mockTask',
            parentTaskId: undefined,
            sequence: [],
            metadata: {
                title: 'Mock Task',
                createdAt: new Date().toISOString(),
                lastActivity: new Date().toISOString(),
                mode: 'code',
                messageCount: 1,
                actionCount: 0,
                totalSize: 100,
                workspace: 'mock-ws',
            },
        },
    });
    // Reset coordinator override (sticky from earlier tests)
    RooStorageDetector.setCoordinatorOverride(null);
});

afterEach(() => {
    RooStorageDetector.setCoordinatorOverride(null);
    delete process.env.ROO_DEBUG_INSTRUCTIONS;
    delete process.env.DEBUG_PARSING;
});

// Helper: flatten console.warn/error/log calls
function flattenLogCalls(spy: any): string[] {
    const lines: string[] = [];
    for (const call of spy.mock.calls) {
        for (const arg of call) lines.push(String(arg ?? ''));
    }
    return lines;
}

// ============================================================
// F28 L1545 getTaskPathById
// ============================================================
describe('F28: getTaskPathById', () => {
    const getTaskPath = (taskId: string) =>
        (RooStorageDetector as any).getTaskPathById(taskId);

    test('F28-L1559: returns null when no storage locations found', async () => {
        // access rejects → findPotentialStorageLocations returns []
        mockAccess.mockRejectedValue(new Error('ENOENT'));
        const result = await getTaskPath('abc-123');
        expect(result).toBeNull();
    });

    test('F28-L1553: returns task path when directory found', async () => {
        // Pre-populate cache with 2 locations (bypass findPotentialStorageLocations)
        const { globalCacheManager } = await import('../cache-manager.js');
        (globalCacheManager.get as any).mockResolvedValueOnce(['/mock/storage1', '/mock/storage2']);
        // First stat throws (not a directory), second succeeds
        mockStat.mockImplementation(async (p: string) => {
            if (p.includes('storage1')) throw new Error('ENOENT');
            return {
                isDirectory: () => true,
                size: 0,
                mtime: new Date(),
                birthtime: new Date(),
            };
        });

        const result = await getTaskPath('task-xyz');
        expect(result).toBe(path.join('/mock/storage2', 'tasks', 'task-xyz'));
    });

    test('F28-L1555-L1557: continues when stat throws on a location', async () => {
        const { globalCacheManager } = await import('../cache-manager.js');
        (globalCacheManager.get as any).mockResolvedValueOnce(['/loc1', '/loc2']);
        // First throws (skip), second succeeds
        mockStat.mockImplementation(async (p: string) => {
            if (p.includes('loc1')) throw new Error('ENOENT');
            return {
                isDirectory: () => true,
                size: 0,
                mtime: new Date(),
                birthtime: new Date(),
            };
        });

        const result = await getTaskPath('target-task');
        expect(result).toBe(path.join('/loc2', 'tasks', 'target-task'));
    });

    test('F28-L1552: skips when stat returns non-directory', async () => {
        const { globalCacheManager } = await import('../cache-manager.js');
        (globalCacheManager.get as any).mockResolvedValueOnce(['/loc1', '/loc2']);
        // First: not a directory → skip. Second: directory → return
        mockStat.mockImplementation(async (p: string) => {
            if (p.includes('loc1')) {
                return { isDirectory: () => false, size: 100, mtime: new Date(), birthtime: new Date() };
            }
            return { isDirectory: () => true, size: 0, mtime: new Date(), birthtime: new Date() };
        });

        const result = await getTaskPath('some-task');
        expect(result).toBe(path.join('/loc2', 'tasks', 'some-task'));
    });
});

// ============================================================
// F21 L1278 getAllConversationsInWorkspace
// ============================================================
describe('F21: getAllConversationsInWorkspace', () => {
    test('F21-L1283: delegates to buildHierarchicalSkeletons with maxTasks<1000 → useFullVolume=false', async () => {
        // Spy via prototype — static methods on classes are on the class itself,
        // so we patch on RooStorageDetector (not instance)
        const origBuild = RooStorageDetector['buildHierarchicalSkeletons'];
        const mock = vi.fn(async () => []);
        // Static method: patch via direct assignment to class (test-only side effect)
        Object.defineProperty(RooStorageDetector, 'buildHierarchicalSkeletons', {
            value: mock,
            configurable: true,
            writable: true,
        });

        try {
            // maxTasks=50 < 1000 → bool = true (legacy short-circuit)
            await (RooStorageDetector as any).getAllConversationsInWorkspace('/mock/ws', 50);
            expect(mock).toHaveBeenCalledWith('/mock/ws', true);
        } finally {
            Object.defineProperty(RooStorageDetector, 'buildHierarchicalSkeletons', {
                value: origBuild,
                configurable: true,
                writable: true,
            });
        }
    });

    test('F21-L1283: useFullVolume=false when maxTasks >= 1000', async () => {
        const origBuild = RooStorageDetector['buildHierarchicalSkeletons'];
        const mock = vi.fn(async () => []);
        Object.defineProperty(RooStorageDetector, 'buildHierarchicalSkeletons', {
            value: mock,
            configurable: true,
            writable: true,
        });

        try {
            // maxTasks=5000 >= 1000 → bool = false
            await (RooStorageDetector as any).getAllConversationsInWorkspace('/mock/ws', 5000);
            expect(mock).toHaveBeenCalledWith('/mock/ws', false);
        } finally {
            Object.defineProperty(RooStorageDetector, 'buildHierarchicalSkeletons', {
                value: origBuild,
                configurable: true,
                writable: true,
            });
        }
    });
});

// ============================================================
// F38 L1937 detectWorkspaceForTaskWithDetector
// ============================================================
describe('F38: detectWorkspaceForTaskWithDetector', () => {
    const detect = (taskPath: string, fallback: string) =>
        (RooStorageDetector as any).detectWorkspaceForTaskWithDetector(
            taskPath,
            { detect: mockWorkspaceDetect } as any,
            fallback
        );

    test('F38-L1954: returns detector workspace when found', async () => {
        mockWorkspaceDetect.mockResolvedValue({
            workspace: '/detected/ws',
            source: 'metadata',
            confidence: 0.95,
        });
        const result = await detect('/task/abc', '/fallback/ws');
        expect(result).toBe('/detected/ws');
    });

    test('F38-L1954: returns fallback when detector returns null workspace', async () => {
        mockWorkspaceDetect.mockResolvedValue({
            workspace: null,
            source: 'none',
            confidence: 0,
        });
        const result = await detect('/task/abc', '/fallback/ws');
        expect(result).toBe('/fallback/ws');
    });

    test('F38-L1954: returns UNKNOWN when both detector and fallback empty', async () => {
        mockWorkspaceDetect.mockResolvedValue({
            workspace: null,
            source: 'none',
            confidence: 0,
        });
        const result = await detect('/task/abc', '');
        expect(result).toBe('UNKNOWN');
    });

    test('F38-L1956: returns fallback when detector throws', async () => {
        mockWorkspaceDetect.mockRejectedValue(new Error('detect failed'));
        const result = await detect('/task/abc', '/fallback/ws');
        expect(result).toBe('/fallback/ws');
    });
});

// ============================================================
// F22 L1292 extractNewTaskInstructionsFromUI
// ============================================================
describe('F22: extractNewTaskInstructionsFromUI', () => {
    const extract = (path: string, maxLines: number = 0, preloaded?: string) =>
        (RooStorageDetector as any).extractNewTaskInstructionsFromUI(path, maxLines, preloaded);

    test('F22-L1303: delegates to extractFromMessageFile with onlyJsonFormat=false', async () => {
        // extractFromMessageFile is warm (F24); we spy on it to capture args
        const origExtract = RooStorageDetector['extractFromMessageFile'];
        const mock = vi.fn(async () => undefined);
        Object.defineProperty(RooStorageDetector, 'extractFromMessageFile', {
            value: mock,
            configurable: true,
            writable: true,
        });

        try {
            await extract('/mock/ui.json', 0);
            expect(mock).toHaveBeenCalledWith('/mock/ui.json', expect.any(Array), 0, false, undefined);
        } finally {
            Object.defineProperty(RooStorageDetector, 'extractFromMessageFile', {
                value: origExtract,
                configurable: true,
                writable: true,
            });
        }
    });

    test('F22-L1305-L1307: ROO_DEBUG_INSTRUCTIONS=1 → debug log line', async () => {
        process.env.ROO_DEBUG_INSTRUCTIONS = '1';
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            // Stub extractFromMessageFile to push 2 instructions into the array
            const origExtract = RooStorageDetector['extractFromMessageFile'];
            Object.defineProperty(RooStorageDetector, 'extractFromMessageFile', {
                value: async (_p: string, instructions: any[]) => {
                    instructions.push({ message: 'task1' }, { message: 'task2' });
                },
                configurable: true,
                writable: true,
            });

            const result = await extract('/mock/ui.json');
            expect(result).toHaveLength(2);

            const lines = flattenLogCalls(consoleLogSpy);
            const hit = lines.some(l =>
                l.includes('[extractNewTaskInstructionsFromUI]') &&
                l.includes('2 instructions')
            );
            expect(hit).toBe(true);

            // Restore before assert, so outer try doesn't double-restore
            Object.defineProperty(RooStorageDetector, 'extractFromMessageFile', {
                value: origExtract,
                configurable: true,
                writable: true,
            });
        } finally {
            consoleLogSpy.mockRestore();
        }
    });
});

// ============================================================
// F25 L1500 extractNewTaskInstructions
// ============================================================
describe('F25: extractNewTaskInstructions', () => {
    const extract = (messages: any[]) =>
        (RooStorageDetector as any).extractNewTaskInstructions(messages);

    test('F25-L1504: uses _coordinatorOverride when set', async () => {
        const mockCoord = {
            extractFromMessages: vi.fn(() => ({ instructions: [{ x: 1 }], errors: [] })),
        };
        RooStorageDetector.setCoordinatorOverride(mockCoord);

        const messages = [{ type: 'say', text: 'hello' }];
        const result = await extract(messages);
        expect(result).toEqual([{ x: 1 }]);
        // env is clean (ROO_DEBUG_INSTRUCTIONS deleted in beforeEach)
        expect(mockCoord.extractFromMessages).toHaveBeenCalledWith(messages, { enableDebug: false });
    });

    test('F25-L1507-L1508: falls back to dynamic import when no override', async () => {
        // Coordinator override is null (reset in beforeEach)
        mockExtractFromMessages.mockReturnValue({
            instructions: [{ message: 'fallback-instruction' }],
            errors: [],
        });

        const result = await extract([{ type: 'say', text: 'hi' }]);
        expect(result).toEqual([{ message: 'fallback-instruction' }]);
        // coordinator extracted via dynamic import → message-extraction-coordinator mock
        expect(mockExtractFromMessages).toHaveBeenCalled();
    });

    test('F25-L1512: enableDebug=true when ROO_DEBUG_INSTRUCTIONS=1', async () => {
        process.env.ROO_DEBUG_INSTRUCTIONS = '1';

        const mockCoord = {
            extractFromMessages: vi.fn(() => ({ instructions: [], errors: [] })),
        };
        RooStorageDetector.setCoordinatorOverride(mockCoord);

        await extract([{ type: 'say', text: 'hi' }]);
        expect(mockCoord.extractFromMessages).toHaveBeenCalledWith(
            expect.any(Array),
            { enableDebug: true }
        );
    });
});

// ============================================================
// F20 L1211 rebuildIndexFromExistingSkeletons
// ============================================================
describe('F20: rebuildIndexFromExistingSkeletons', () => {
    const rebuild = () =>
        (RooStorageDetector as any).rebuildIndexFromExistingSkeletons();

    // Helper: build Dirent-like object (for readdir with withFileTypes:true)
    const dirent = (name: string, isDir = true) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
    });

    test('F20-L1272: rebuilds index from existing skeleton files', async () => {
        // Pre-populate cache with 2 locations (bypass findPotentialStorageLocations)
        const { globalCacheManager } = await import('../cache-manager.js');
        (globalCacheManager.get as any).mockResolvedValueOnce(['/loc1', '/loc2']);
        // readdir tasks/ returns Dirent objects (withFileTypes:true)
        mockReaddir.mockImplementation(async (p: string) => {
            if (p.includes('loc1')) return [dirent('taskA')];
            if (p.includes('loc2')) return [dirent('taskB')];
            return [];
        });
        // existsSync for .skeleton files: true for both
        mockExistsSync.mockImplementation((p: string) => p.includes('.skeleton'));
        // readFile returns valid skeleton JSON with prefixes
        mockReadFile.mockImplementation(async (p: string) => {
            if (p.includes('taskA')) return JSON.stringify({
                taskId: 'taskA',
                childTaskInstructionPrefixes: ['prefix-A-1', 'prefix-A-2'],
            });
            if (p.includes('taskB')) return JSON.stringify({
                taskId: 'taskB',
                childTaskInstructionPrefixes: ['prefix-B-1'],
            });
            return '{}';
        });

        await rebuild();

        // rebuildFromSkeletons called with map containing both taskIds
        expect(mockRebuildFromSkeletons).toHaveBeenCalledTimes(1);
        const arg = mockRebuildFromSkeletons.mock.calls[0][0];
        expect(arg).toBeInstanceOf(Map);
        expect(arg.size).toBe(2);
        expect(arg.get('taskA')).toEqual(['prefix-A-1', 'prefix-A-2']);
        expect(arg.get('taskB')).toEqual(['prefix-B-1']);
    });

    test('F20-L1225: skips non-directory entries in tasks dir', async () => {
        const { globalCacheManager } = await import('../cache-manager.js');
        (globalCacheManager.get as any).mockResolvedValueOnce(['/loc1']);
        mockReaddir.mockImplementation(async (p: string) => {
            if (p.includes('loc1')) return [dirent('taskDir', true), dirent('stray-file.txt', false)];
            return [];
        });
        // existsSync: only .skeleton inside taskDir
        mockExistsSync.mockImplementation((p: string) =>
            p.includes('taskDir') && p.includes('.skeleton')
        );
        mockReadFile.mockResolvedValue(JSON.stringify({
            taskId: 'taskDir',
            childTaskInstructionPrefixes: ['p1'],
        }));

        await rebuild();
        expect(mockRebuildFromSkeletons).toHaveBeenCalledTimes(1);
        const arg = mockRebuildFromSkeletons.mock.calls[0][0];
        expect(arg.size).toBe(1);
        expect(arg.has('taskDir')).toBe(true);
    });

    test('F20-L1251-L1253: continues on corrupted skeleton (readFile/parse fails)', async () => {
        const { globalCacheManager } = await import('../cache-manager.js');
        (globalCacheManager.get as any).mockResolvedValueOnce(['/loc1']);
        mockReaddir.mockImplementation(async (p: string) => {
            if (p.includes('loc1')) return [dirent('goodTask'), dirent('corruptTask')];
            return [];
        });
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockImplementation(async (p: string) => {
            if (p.includes('goodTask')) return JSON.stringify({
                taskId: 'goodTask',
                childTaskInstructionPrefixes: ['gp'],
            });
            // corruptTask readFile/parse fails → caught by processBatch try/catch
            return '{not valid json';
        });

        await rebuild();
        const arg = mockRebuildFromSkeletons.mock.calls[0][0];
        expect(arg.size).toBe(1);
        expect(arg.has('goodTask')).toBe(true);
        expect(arg.has('corruptTask')).toBe(false);
    });
});

// ============================================================
// F10 L400 analyzeWithNewSystem
// ============================================================
describe('F10: analyzeWithNewSystem', () => {
    const analyze = (
        taskId: string,
        taskPath: string,
        useProductionHierarchy: boolean,
        paths: { metadataPath: string; apiHistoryPath: string; uiMessagesPath: string; historyItemPath: string }
    ) => (RooStorageDetector as any).analyzeWithNewSystem(taskId, taskPath, useProductionHierarchy, paths);

    test('F10-L412: returns null when loadUIMessages returns empty', async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue('[]'); // empty messages

        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await analyze('task1', '/mock/task', true, {
            metadataPath: '/m',
            apiHistoryPath: '/a',
            uiMessagesPath: '/u',
            historyItemPath: '/h',
        });
        expect(result).toBeNull();
        const lines = flattenLogCalls(consoleWarnSpy);
        expect(lines.some(l => l.includes('No messages found') && l.includes('task1'))).toBe(true);
        consoleWarnSpy.mockRestore();
    });

    test('F10-L426-L432: DEBUG_PARSING=true → workspace debug log', async () => {
        process.env.DEBUG_PARSING = 'true';
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            mockExistsSync.mockReturnValue(true);
            mockReadFile.mockResolvedValue(JSON.stringify([
                { type: 'say', text: 'hello', role: 'assistant', ts: 1700000000000 },
            ]));

            const result = await analyze('task2', '/mock/task', true, {
                metadataPath: '/m',
                apiHistoryPath: '/a',
                uiMessagesPath: '/u',
                historyItemPath: '/h',
            });
            expect(result).not.toBeNull();

            const lines = flattenLogCalls(consoleLogSpy);
            const hit = lines.some(l =>
                l.includes('[NEW PARSING] Workspace') && l.includes('task2')
            );
            expect(hit).toBe(true);
        } finally {
            consoleLogSpy.mockRestore();
        }
    });

    test('F10-L443-L445: DEBUG_PARSING=true → metadata debug log', async () => {
        process.env.DEBUG_PARSING = 'true';
        const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        try {
            mockExistsSync.mockReturnValue(true);
            mockReadFile.mockResolvedValue(JSON.stringify([
                { type: 'say', text: 'msg', role: 'assistant', ts: 1700000000000 },
            ]));

            await analyze('task3', '/mock/task', true, {
                metadataPath: '/m',
                apiHistoryPath: '/a',
                uiMessagesPath: '/u',
                historyItemPath: '/h',
            });

            const lines = flattenLogCalls(consoleLogSpy);
            const hit = lines.some(l => l.includes('[NEW PARSING] Metadata'));
            expect(hit).toBe(true);
        } finally {
            consoleLogSpy.mockRestore();
        }
    });

    test('F10-L452-L454: returns null + console.error when transformer throws', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue(JSON.stringify([
            { type: 'say', text: 'msg', role: 'assistant' },
        ]));
        // WorkspaceDetector throws
        mockWorkspaceDetect.mockRejectedValue(new Error('workspace detect boom'));

        try {
            const result = await analyze('task4', '/mock/task', true, {
                metadataPath: '/m',
                apiHistoryPath: '/a',
                uiMessagesPath: '/u',
                historyItemPath: '/h',
            });
            expect(result).toBeNull();
            const lines = flattenLogCalls(consoleErrorSpy);
            const hit = lines.some(l =>
                l.includes('[NEW PARSING] Error') && l.includes('task4')
            );
            expect(hit).toBe(true);
        } finally {
            consoleErrorSpy.mockRestore();
        }
    });
});

// ============================================================
// F8 L308 scanConversations
// ============================================================
describe('F8: scanConversations', () => {
    const scan = (tasksPath: string) =>
        (RooStorageDetector as any).scanConversations(tasksPath);

    test('F8-L345: throws RooStorageError when readdir fails', async () => {
        mockReaddir.mockRejectedValue(new Error('EACCES: permission denied'));

        await expect(scan('/mock/tasks')).rejects.toThrow();
    });

    test('F8-L322: skips tasks where analyzeConversation returns null', async () => {
        // Patch analyzeConversation to return null for some tasks
        const origAnalyze = RooStorageDetector['analyzeConversation'];
        Object.defineProperty(RooStorageDetector, 'analyzeConversation', {
            value: async (taskId: string) => {
                if (taskId === 'skip-me') return null;
                return {
                    taskId,
                    parentTaskId: undefined,
                    sequence: [],
                    metadata: {
                        title: `Task ${taskId}`,
                        createdAt: new Date().toISOString(),
                        lastActivity: new Date().toISOString(),
                        mode: 'code',
                        messageCount: 5,
                        actionCount: 2,
                        totalSize: 1024,
                        workspace: 'mock-ws',
                        dataSource: '/mock/task',
                        source: 'roo',
                    },
                };
            },
            configurable: true,
            writable: true,
        });

        try {
            mockReaddir.mockResolvedValue(['skip-me', 'keep-me']);
            mockStat.mockResolvedValue({
                isDirectory: () => true,
                size: 1024,
                mtime: new Date(),
                birthtime: new Date(),
            });

            const result = await scan('/mock/tasks');
            expect(result).toHaveLength(1);
            expect(result[0].taskId).toBe('keep-me');
        } finally {
            Object.defineProperty(RooStorageDetector, 'analyzeConversation', {
                value: origAnalyze,
                configurable: true,
                writable: true,
            });
        }
    });

    test('F8-L319: skips non-directory entries', async () => {
        const origAnalyze = RooStorageDetector['analyzeConversation'];
        let analyzedCount = 0;
        Object.defineProperty(RooStorageDetector, 'analyzeConversation', {
            value: async (taskId: string) => {
                analyzedCount++;
                return {
                    taskId,
                    parentTaskId: undefined,
                    sequence: [],
                    metadata: {
                        title: `Task ${taskId}`,
                        createdAt: new Date().toISOString(),
                        lastActivity: new Date().toISOString(),
                        mode: 'code',
                        messageCount: 0,
                        actionCount: 0,
                        totalSize: 0,
                        workspace: 'mock-ws',
                        dataSource: '',
                        source: 'roo',
                    },
                };
            },
            configurable: true,
            writable: true,
        });

        try {
            mockReaddir.mockResolvedValue(['dirTask', 'file.txt']);
            mockStat.mockImplementation(async (p: string) => {
                if (p.endsWith('file.txt')) {
                    return { isDirectory: () => false, size: 0, mtime: new Date(), birthtime: new Date() };
                }
                return { isDirectory: () => true, size: 0, mtime: new Date(), birthtime: new Date() };
            });

            const result = await scan('/mock/tasks');
            expect(result).toHaveLength(1);
            expect(analyzedCount).toBe(1); // only dirTask analyzed
        } finally {
            Object.defineProperty(RooStorageDetector, 'analyzeConversation', {
                value: origAnalyze,
                configurable: true,
                writable: true,
            });
        }
    });
});