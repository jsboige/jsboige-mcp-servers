/**
 * Coverage tests for TaskIndexer.indexTask() — Claude Code path-resolution branches.
 *
 * Issue #833 (C3). The claude-code session-scoping logic in task-indexer.ts
 * (L104-135) was previously untested (functions ~23% coverage per the #2642
 * `vitest --coverage` run). This suite covers the two supported taskId formats
 * documented at L100-103 — per-project (legacy) and per-session (#937) — plus the
 * missing-file fallback and the not-found error path.
 *
 * Isolation: the VectorIndexer seam (./task-indexer/VectorIndexer.js) and the
 * ClaudeStorageDetector are mocked, so no real Qdrant / embedding / global storage
 * is touched. Session files live in an OS temp dir → CI-safe (no APPDATA/GDrive/PS).
 *
 * @module services/__tests__/task-indexer.claude-branches
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// The global test setup (tests/setup/jest.setup.js) replaces the whole task-indexer
// module with a stub whose indexTask always rejects 'not found'. Opt this file out so
// we exercise the REAL TaskIndexer.indexTask branch logic (file-level vi.unmock wins
// over the setup-level vi.mock).
vi.unmock('../task-indexer.js');

// Mock the VectorIndexer seam so the façade's delegation is intercepted before any
// real Qdrant/embedding work. All named exports task-indexer.ts imports are provided.
// countPointsByHostOs returns a number by default to stay faithful to its real contract.
vi.mock('../task-indexer/VectorIndexer.js', () => ({
    indexTask: vi.fn(),
    resetCollection: vi.fn(),
    countPointsByHostOs: vi.fn().mockResolvedValue(0),
    cleanupOldVectors: vi.fn(),
    updateSkeletonIndexTimestamp: vi.fn(),
    upsertPointsBatch: vi.fn(),
    qdrantRateLimiter: {},
}));

// Mock the Claude storage detector so the resolved locations are fully controlled.
// task-indexer.ts imports it via a dynamic import (L105); vi.mock intercepts those too.
vi.mock('../../utils/claude-storage-detector.js', () => ({
    ClaudeStorageDetector: {
        detectStorageLocations: vi.fn(),
    },
}));

import { TaskIndexer } from '../task-indexer.js';
import { indexTask as indexTaskVector } from '../task-indexer/VectorIndexer.js';
import { ClaudeStorageDetector } from '../../utils/claude-storage-detector.js';

const FAKE_POINTS = [{ id: 'p1', vector: [0.1], payload: {} }] as any;

describe('TaskIndexer.indexTask — Claude Code branch resolution (coverage #833 C3)', () => {
    let tmpDir: string;
    let projectDir: string;
    let indexer: TaskIndexer;
    let errSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        vi.clearAllMocks();
        vi.mocked(indexTaskVector).mockResolvedValue(FAKE_POINTS);
        // The class method logs the error before rethrowing (L163) — suppress the noise.
        errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ti-claude-'));
        projectDir = path.join(tmpDir, 'my-project');
        await fs.mkdir(projectDir, { recursive: true });
        indexer = new TaskIndexer();
    });

    afterEach(async () => {
        errSpy.mockRestore();
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    test('per-project taskId (basename === suffix) indexes the whole project dir (src L110-113)', async () => {
        vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
            { projectPath: projectDir } as any,
        ]);
        const base = path.basename(projectDir); // 'my-project'
        const taskId = `claude-${base}`;

        const points = await indexer.indexTask(taskId, 'claude-code');

        expect(points).toBe(FAKE_POINTS);
        // Legacy per-project path: delegates with the PROJECT dir, source preserved (L112).
        expect(indexTaskVector).toHaveBeenCalledWith(taskId, projectDir, 'claude-code', undefined);
    });

    test('per-session taskId (#937, suffix startsWith basename + "--") resolves the single .jsonl file (src L116-123)', async () => {
        const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        const sessionFile = path.join(projectDir, `${uuid}.jsonl`);
        await fs.writeFile(sessionFile, '{}\n');
        vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
            { projectPath: projectDir } as any,
        ]);
        const base = path.basename(projectDir);
        const taskId = `claude-${base}--${uuid}`;
        const meta = { workspace: 'ws1' };

        const points = await indexer.indexTask(taskId, 'claude-code', meta);

        expect(points).toBe(FAKE_POINTS);
        // #937 fix: delegates with the SPECIFIC session file (L118/L122), not the dir,
        // and forwards metadata through the façade.
        expect(indexTaskVector).toHaveBeenCalledWith(taskId, sessionFile, 'claude-code', meta);
    });

    test('per-session taskId whose .jsonl is absent falls through and throws not-found (src L124-134)', async () => {
        vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
            { projectPath: projectDir } as any,
        ]);
        const base = path.basename(projectDir);
        const taskId = `claude-${base}--missing-uuid`;

        // fs.access rejects → catch → continue → no more locations → throws (L129).
        await expect(indexer.indexTask(taskId, 'claude-code')).rejects.toThrow(/not found/i);
        expect(indexTaskVector).not.toHaveBeenCalled();
    });

    test('taskId matching no location throws "Claude Code session ... not found" (src L129-134)', async () => {
        vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([
            { projectPath: projectDir } as any,
        ]);
        const taskId = 'claude-totally-unknown-project';

        await expect(indexer.indexTask(taskId, 'claude-code')).rejects.toThrow(/not found/i);
        expect(indexTaskVector).not.toHaveBeenCalled();
    });

    test('empty location list throws not-found without delegating (src L108 loop skipped → L129)', async () => {
        vi.mocked(ClaudeStorageDetector.detectStorageLocations).mockResolvedValue([]);

        await expect(indexer.indexTask('claude-anything', 'claude-code')).rejects.toThrow(/not found/i);
        expect(indexTaskVector).not.toHaveBeenCalled();
    });
});
