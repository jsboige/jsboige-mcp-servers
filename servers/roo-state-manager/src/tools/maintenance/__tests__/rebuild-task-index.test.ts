/**
 * Tests for rebuild-task-index.ts
 * Issue #814 — Recovery of SQLite write-back for orphaned tasks
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Shared mock DB instance — all Database() calls return this
const mockDb = {
	get: vi.fn(),
	run: vi.fn(),
	close: vi.fn((cb: Function) => cb(null))
};

const { mockExistsSync, mockCopyFileSync } = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockCopyFileSync: vi.fn()
}));

const { mockReaddir, mockStat, mockUnlink } = vi.hoisted(() => ({
	mockReaddir: vi.fn(),
	mockStat: vi.fn(),
	mockUnlink: vi.fn().mockResolvedValue(undefined)
}));

const { mockAnalyzeConversation } = vi.hoisted(() => ({
	mockAnalyzeConversation: vi.fn()
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return {
		...actual,
		default: { ...actual, existsSync: mockExistsSync, copyFileSync: mockCopyFileSync },
		existsSync: mockExistsSync,
		copyFileSync: mockCopyFileSync,
		promises: {
			readdir: mockReaddir,
			stat: mockStat,
			unlink: mockUnlink,
			writeFile: vi.fn()
		}
	};
});

vi.mock('sqlite3', () => {
	// The Database constructor must call cb ASYNCHRONOUSLY to avoid TDZ
	// (the source code does `const db = new Database(path, mode, (err) => resolve(db))`)
	const DatabaseMock = vi.fn((_path: string, _mode: number, cb: (err: Error | null) => void) => {
		if (cb) queueMicrotask(() => cb(null));
		return mockDb;
	});
	return {
		default: {
			Database: DatabaseMock,
			OPEN_READONLY: 0x00000001,
			OPEN_READWRITE: 0x00000002
		},
		Database: DatabaseMock,
		OPEN_READONLY: 0x00000001,
		OPEN_READWRITE: 0x00000002
	};
});

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		analyzeConversation: mockAnalyzeConversation
	}
}));

vi.mock('../../../utils/logger.js', () => ({
	createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
	Logger: class {}
}));

vi.mock('../../../utils/workspace-detector.js', () => ({
	WorkspaceDetector: class {
		constructor() {}
		async detect() { return { workspace: 'D:\\Dev\\test-workspace' }; }
	}
}));

import { handleRebuildTaskIndex } from '../rebuild-task-index.js';

describe('rebuild-task-index', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockExistsSync.mockReturnValue(true);
		mockUnlink.mockResolvedValue(undefined);

		// Default: empty state
		mockDb.get.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
			cb(null, { value: JSON.stringify({ taskHistory: [] }) });
		});
		mockDb.close.mockImplementation((cb: Function) => cb(null));
		mockDb.run.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
			if (cb) cb(null);
		});
	});

	describe('error handling', () => {
		test('returns error when state.vscdb not found', async () => {
			mockExistsSync.mockReturnValue(false);

			const result = await handleRebuildTaskIndex({ dry_run: true });

			expect(result.isError).toBe(true);
			expect((result.content[0] as any).text).toContain('state.vscdb not found');
		});

		test('returns error when tasks directory not accessible', async () => {
			mockReaddir.mockRejectedValue(new Error('ENOENT: no such file or directory'));

			const result = await handleRebuildTaskIndex({ dry_run: true });

			expect(result.isError).toBe(true);
			expect((result.content[0] as any).text).toContain('Error reading tasks directory');
		});
	});

	describe('dry-run mode', () => {
		test('defaults to dry-run when not specified', async () => {
			mockDb.get.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
				cb(null, { value: JSON.stringify({ taskHistory: [
					{ ts: 1000, task: 'existing', workspace: 'ws', id: 'existing-id' }
				] }) });
			});

			mockReaddir
				.mockResolvedValueOnce(['existing-id', 'orphan-id'])
				.mockResolvedValueOnce(['api_conversation_history.json'])
				.mockResolvedValueOnce(['api_conversation_history.json']);

			mockStat.mockResolvedValue({
				isDirectory: () => true,
				mtime: new Date('2026-01-01'),
				birthtime: new Date('2026-01-01')
			});

			mockAnalyzeConversation.mockResolvedValue({
				metadata: { title: 'Orphan Task', workspace: 'D:\\Dev\\test' }
			});

			const result = await handleRebuildTaskIndex({});

			const text = (result.content[0] as any).text;
			expect(text).toContain('SIMULATION');
			expect(text).toContain('**Orphaned tasks (total):** 1');
			// No SQLite write in dry-run
			expect(mockDb.run).not.toHaveBeenCalled();
		});
	});

	describe('orphan detection', () => {
		test('correctly identifies orphaned tasks', async () => {
			mockDb.get.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
				cb(null, { value: JSON.stringify({ taskHistory: [
					{ ts: 1000, task: 'indexed-task', workspace: 'ws', id: 'task-a' }
				] }) });
			});

			mockReaddir
				.mockResolvedValueOnce(['task-a', 'task-b', 'task-c'])
				.mockResolvedValueOnce(['file.json'])
				.mockResolvedValueOnce(['file.json'])
				.mockResolvedValueOnce(['file.json']);

			mockStat.mockResolvedValue({
				isDirectory: () => true,
				mtime: new Date('2026-01-01'),
				birthtime: new Date('2026-01-01')
			});

			mockAnalyzeConversation.mockResolvedValue(null);

			const result = await handleRebuildTaskIndex({ dry_run: true });
			const text = (result.content[0] as any).text;

			expect(text).toContain('**Tasks in SQLite index:** 1');
			expect(text).toContain('**Tasks on disk:** 3');
			expect(text).toContain('**Orphaned tasks (total):** 2');
		});

		test('skips .skeletons directory', async () => {
			mockReaddir
				.mockResolvedValueOnce(['.skeletons', 'real-task'])
				.mockResolvedValueOnce(['file.json']);

			mockStat.mockResolvedValue({
				isDirectory: () => true,
				mtime: new Date('2026-01-01'),
				birthtime: new Date('2026-01-01')
			});

			mockAnalyzeConversation.mockResolvedValue(null);

			const result = await handleRebuildTaskIndex({ dry_run: true });
			const text = (result.content[0] as any).text;

			expect(text).toContain('**Tasks on disk:** 1');
		});

		test('skips empty task directories', async () => {
			mockReaddir
				.mockResolvedValueOnce(['task-empty', 'task-with-files'])
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(['api_conversation_history.json']);

			mockStat.mockResolvedValue({
				isDirectory: () => true,
				mtime: new Date('2026-01-01'),
				birthtime: new Date('2026-01-01')
			});

			mockAnalyzeConversation.mockResolvedValue(null);

			const result = await handleRebuildTaskIndex({ dry_run: true });
			const text = (result.content[0] as any).text;

			expect(text).toContain('**Tasks on disk:** 1');
		});
	});

	describe('filters', () => {
		test('workspace_filter limits results', async () => {
			mockReaddir
				.mockResolvedValueOnce(['task-1', 'task-2'])
				.mockResolvedValueOnce(['file.json'])
				.mockResolvedValueOnce(['file.json']);

			mockStat.mockResolvedValue({
				isDirectory: () => true,
				mtime: new Date('2026-01-01'),
				birthtime: new Date('2026-01-01')
			});

			const result = await handleRebuildTaskIndex({
				dry_run: true,
				workspace_filter: 'test-workspace'
			});
			const text = (result.content[0] as any).text;

			expect(text).toContain('**Workspace filter:** test-workspace');
		});

		test('max_tasks limits processing', async () => {
			mockReaddir
				.mockResolvedValueOnce(['task-1', 'task-2', 'task-3'])
				.mockResolvedValueOnce(['file.json'])
				.mockResolvedValueOnce(['file.json'])
				.mockResolvedValueOnce(['file.json']);

			mockStat.mockResolvedValue({
				isDirectory: () => true,
				mtime: new Date('2026-01-01'),
				birthtime: new Date('2026-01-01')
			});

			mockAnalyzeConversation.mockResolvedValue(null);

			const result = await handleRebuildTaskIndex({
				dry_run: true,
				max_tasks: 1
			});
			const text = (result.content[0] as any).text;

			expect(text).toContain('**Max tasks limit:** 1');
			expect(text).toContain('**Tasks to process:** 1');
		});
	});

	describe('metadata enrichment', () => {
		test('uses RooStorageDetector title when available', async () => {
			mockReaddir
				.mockResolvedValueOnce(['task-1'])
				.mockResolvedValueOnce(['file.json']);

			mockStat.mockResolvedValue({
				isDirectory: () => true,
				mtime: new Date('2026-01-01'),
				birthtime: new Date('2026-01-01')
			});

			mockAnalyzeConversation.mockResolvedValue({
				metadata: { title: 'My Rich Task Title', workspace: 'D:\\Projects\\myapp' }
			});

			const result = await handleRebuildTaskIndex({ dry_run: true });
			const text = (result.content[0] as any).text;

			expect(text).toContain('My Rich Task Title');
			expect(text).toContain('**Rich metadata available:** 1');
		});

		test('falls back to task ID when RooStorageDetector fails', async () => {
			mockReaddir
				.mockResolvedValueOnce(['task-fallback'])
				.mockResolvedValueOnce(['file.json']);

			mockStat.mockResolvedValue({
				isDirectory: () => true,
				mtime: new Date('2026-01-01'),
				birthtime: new Date('2026-01-01')
			});

			mockAnalyzeConversation.mockRejectedValue(new Error('Parse error'));

			const result = await handleRebuildTaskIndex({ dry_run: true });
			const text = (result.content[0] as any).text;

			expect(text).toContain('task-fallback');
			expect(text).toContain('**Rich metadata available:** 0');
		});
	});

	describe('no orphans', () => {
		test('reports cleanly when all tasks are indexed', async () => {
			mockDb.get.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
				cb(null, { value: JSON.stringify({ taskHistory: [
					{ ts: 1000, task: 'task-a', workspace: 'ws', id: 'task-a' },
					{ ts: 2000, task: 'task-b', workspace: 'ws', id: 'task-b' }
				] }) });
			});

			mockReaddir
				.mockResolvedValueOnce(['task-a', 'task-b'])
				.mockResolvedValueOnce(['file.json'])
				.mockResolvedValueOnce(['file.json']);

			mockStat.mockResolvedValue({
				isDirectory: () => true,
				mtime: new Date('2026-01-01'),
				birthtime: new Date('2026-01-01')
			});

			const result = await handleRebuildTaskIndex({ dry_run: true });
			const text = (result.content[0] as any).text;

			expect(text).toContain('No orphaned tasks found');
			expect(text).toContain('Index is in sync with disk');
		});
	});

	describe('anti-stub checks', () => {
		test('orphan count varies with input data', async () => {
			// First call: 1 indexed task, 3 on disk → 2 orphans
			mockDb.get.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
				cb(null, { value: JSON.stringify({ taskHistory: [
					{ ts: 1000, task: 'indexed', workspace: 'ws', id: 'task-a' }
				] }) });
			});

			mockReaddir
				.mockResolvedValueOnce(['task-a', 'task-b', 'task-c'])
				.mockResolvedValueOnce(['f.json'])
				.mockResolvedValueOnce(['f.json'])
				.mockResolvedValueOnce(['f.json']);

			mockStat.mockResolvedValue({
				isDirectory: () => true,
				mtime: new Date('2026-01-01'),
				birthtime: new Date('2026-01-01')
			});
			mockAnalyzeConversation.mockResolvedValue(null);

			const result1 = await handleRebuildTaskIndex({ dry_run: true });
			const text1 = (result1.content[0] as any).text;

			// Reset mocks for second call
			mockReaddir.mockReset();
			mockStat.mockReset();

			// Second call: 3 indexed, 3 on disk → 0 orphans
			mockDb.get.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
				cb(null, { value: JSON.stringify({ taskHistory: [
					{ ts: 1000, task: 'a', workspace: 'ws', id: 'task-a' },
					{ ts: 2000, task: 'b', workspace: 'ws', id: 'task-b' },
					{ ts: 3000, task: 'c', workspace: 'ws', id: 'task-c' }
				] }) });
			});

			mockReaddir
				.mockResolvedValueOnce(['task-a', 'task-b', 'task-c'])
				.mockResolvedValueOnce(['f.json'])
				.mockResolvedValueOnce(['f.json'])
				.mockResolvedValueOnce(['f.json']);

			mockStat.mockResolvedValue({
				isDirectory: () => true,
				mtime: new Date('2026-01-01'),
				birthtime: new Date('2026-01-01')
			});

			const result2 = await handleRebuildTaskIndex({ dry_run: true });
			const text2 = (result2.content[0] as any).text;

			// Anti-stub: different inputs produce different orphan counts
			expect(text1).toContain('**Orphaned tasks (total):** 2');
			expect(text2).toContain('No orphaned tasks found');
		});
	});

	// ============================================================
	// Cluster C coverage — branches genuinement non-couvertes.
	// The existing suite covers dry-run thoroughly; these target the
	// untested LIVE write path (#814 core) + readRooState edge cases.
	// #815 scepticism: assertions anchored on real source behavior.
	// ============================================================

	describe('LIVE write mode (dry_run: false) — #814 core path', () => {
		test('writes orphans back to SQLite, sorted desc by ts, and reports INDEX UPDATED', async () => {
			// 1 indexed (old ts=1000) + 1 orphan on disk (newer mtime)
			mockDb.get.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
				cb(null, { value: JSON.stringify({ taskHistory: [
					{ ts: 1000, task: 'old-indexed', workspace: 'ws', id: 'old-id' }
				] }) });
			});
			mockReaddir
				.mockResolvedValueOnce(['old-id', 'orphan-id'])
				.mockResolvedValueOnce(['api_conversation_history.json'])
				.mockResolvedValueOnce(['api_conversation_history.json']);
			mockStat.mockResolvedValue({
				isDirectory: () => true,
				mtime: new Date('2026-06-01T00:00:00Z'),
				birthtime: new Date('2026-06-01T00:00:00Z')
			});
			mockAnalyzeConversation.mockResolvedValue({
				metadata: { title: 'Orphan Task', workspace: 'D:\\Dev\\test' }
			});

			const result = await handleRebuildTaskIndex({ dry_run: false });
			const text = (result.content[0] as any).text;

			// SQLite UPDATE issued exactly once (read uses get, not run)
			expect(mockDb.run).toHaveBeenCalledTimes(1);
			const writeCall = mockDb.run.mock.calls[0];
			expect(writeCall[0]).toContain('UPDATE ItemTable');
			// Written value = merged taskHistory sorted DESC by ts (orphan newer → first)
			const written = JSON.parse(writeCall[1][0]);
			expect(written.taskHistory).toHaveLength(2);
			expect(written.taskHistory[0].id).toBe('orphan-id');
			expect(written.taskHistory[1].id).toBe('old-id');
			// Report (L301-311)
			expect(text).toContain('INDEX UPDATED');
			expect(text).toContain('**Tasks added:** 1');
			expect(text).toContain('**Total after update:** 2');
			expect(text).toContain('Restart VS Code');
		});
	});

	describe('readRooState edge cases', () => {
		test('strips UTF-8 BOM from the SQLite value before parsing (L118-120)', async () => {
			const stateJson = JSON.stringify({ taskHistory: [
				{ ts: 1000, task: 'bom-task', workspace: 'ws', id: 'bom-id' }
			] });
			mockDb.get.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
				cb(null, { value: '﻿' + stateJson }); // BOM-prefixed
			});
			mockReaddir.mockResolvedValueOnce([]); // no tasks on disk

			const result = await handleRebuildTaskIndex({ dry_run: true });
			// Without BOM strip, JSON.parse would throw → outer catch → isError
			expect(result.isError).toBeFalsy();
			expect((result.content[0] as any).text).toContain('**Tasks in SQLite index:** 1');
		});

		test('handles a Buffer value from SQLite via toString(utf-8) (L116)', async () => {
			const stateJson = JSON.stringify({ taskHistory: [
				{ ts: 1000, task: 'buf-task', workspace: 'ws', id: 'buf-id' }
			] });
			mockDb.get.mockImplementation((_sql: string, _params: unknown[], cb: Function) => {
				cb(null, { value: Buffer.from(stateJson, 'utf-8') }); // Buffer, not string
			});
			mockReaddir.mockResolvedValueOnce([]);

			const result = await handleRebuildTaskIndex({ dry_run: true });
			expect(result.isError).toBeFalsy();
			expect((result.content[0] as any).text).toContain('**Tasks in SQLite index:** 1');
		});

		test('skips non-directory entries in the tasks directory (L178)', async () => {
			mockReaddir
				.mockResolvedValueOnce(['stray-file.txt', 'real-task'])
				.mockResolvedValueOnce(['file.json']);
			mockStat
				.mockResolvedValueOnce({
					isDirectory: () => false, // stray-file.txt skipped
					mtime: new Date('2026-01-01'),
					birthtime: new Date('2026-01-01')
				})
				.mockResolvedValueOnce({
					isDirectory: () => true, // real-task processed
					mtime: new Date('2026-01-01'),
					birthtime: new Date('2026-01-01')
				});
			mockAnalyzeConversation.mockResolvedValue(null);

			const result = await handleRebuildTaskIndex({ dry_run: true });
			expect((result.content[0] as any).text).toContain('**Tasks on disk:** 1');
		});
	});
});
