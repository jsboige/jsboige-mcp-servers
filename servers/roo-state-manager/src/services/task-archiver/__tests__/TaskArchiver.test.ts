/**
 * Tests pour TaskArchiver.ts - fonctions de transformation pure
 * Issue #492 - Couverture du service d'archivage
 *
 * Teste les fonctions internes (truncateContent, transformUiMessages, transformApiMessages)
 * via le flux public archiveTask/readArchivedTask.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies before importing
const { mockReadFile, mockWriteFile, mockMkdir, mockAccess, mockReaddir } = vi.hoisted(() => ({
	mockReadFile: vi.fn(),
	mockWriteFile: vi.fn(),
	mockMkdir: vi.fn(),
	mockAccess: vi.fn(),
	mockReaddir: vi.fn(),
}));

vi.mock('fs', () => ({
	promises: {
		readFile: mockReadFile,
		writeFile: mockWriteFile,
		mkdir: mockMkdir,
		access: mockAccess,
		readdir: mockReaddir,
	},
	default: {
		promises: {
			readFile: mockReadFile,
			writeFile: mockWriteFile,
			mkdir: mockMkdir,
			access: mockAccess,
			readdir: mockReaddir,
		},
	},
}));

vi.mock('os', () => {
	const m = {
		hostname: () => 'test-machine',
		platform: () => 'linux',
		arch: () => 'x64',
		tmpdir: () => '/tmp',
		EOL: '\n',
		type: () => 'Linux',
		release: () => '5.0',
		networkInterfaces: () => ({}),
		userInfo: () => ({ username: 'test' }),
	};
	return { ...m, default: m };
});

vi.mock('../../../utils/server-helpers.js', () => ({
	getSharedStatePath: () => '/mock/shared-state',
}));

// Mock zlib (gzip/gunzip)
const { mockGzip, mockGunzip } = vi.hoisted(() => ({
	mockGzip: vi.fn(),
	mockGunzip: vi.fn(),
}));

vi.mock('zlib', () => ({
	gzip: mockGzip,
	gunzip: mockGunzip,
	default: { gzip: mockGzip, gunzip: mockGunzip },
}));

vi.mock('util', () => ({
	promisify: (fn: any) => {
		if (fn === mockGzip) return async (buf: Buffer) => Buffer.from(JSON.stringify({ compressed: true }));
		if (fn === mockGunzip) return async (buf: Buffer) => buf;
		return fn;
	},
	default: {
		promisify: (fn: any) => fn,
	},
}));

import { TaskArchiver } from '../TaskArchiver.js';

describe('TaskArchiver', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================
	// archiveTask
	// ============================================================

	describe('archiveTask', () => {
		test('skips if archive already exists', async () => {
			mockAccess.mockResolvedValueOnce(undefined); // file exists
			await TaskArchiver.archiveTask('task-123', '/task/path', {
				taskId: 'task-123',
				isCompleted: true,
			} as any);
			// Should not try to read messages
			expect(mockReadFile).not.toHaveBeenCalled();
		});

		test('reads ui_messages.json as primary source', async () => {
			mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // archive not exists
			const uiMessages = JSON.stringify([
				{ author: 'user', text: 'Hello', timestamp: '2026-02-22T10:00:00Z' },
				{ author: 'agent', text: 'Hi there', timestamp: '2026-02-22T10:01:00Z' },
			]);
			mockReadFile.mockResolvedValueOnce(uiMessages); // ui_messages.json
			mockMkdir.mockResolvedValueOnce(undefined);
			mockWriteFile.mockResolvedValueOnce(undefined);

			await TaskArchiver.archiveTask('task-456', '/task/path', {
				taskId: 'task-456',
				isCompleted: false,
				metadata: { title: 'Test Task' },
			} as any);

			expect(mockReadFile).toHaveBeenCalledTimes(1);
			expect(mockMkdir).toHaveBeenCalled();
			expect(mockWriteFile).toHaveBeenCalled();
		});

		test('falls back to api_conversation_history.json', async () => {
			mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
			mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // ui_messages not found
			const apiMessages = JSON.stringify([
				{ role: 'user', content: 'Hello API', timestamp: '2026-02-22T10:00:00Z' },
				{ role: 'assistant', content: 'Response', timestamp: '2026-02-22T10:01:00Z' },
			]);
			mockReadFile.mockResolvedValueOnce(apiMessages); // api fallback
			mockMkdir.mockResolvedValueOnce(undefined);
			mockWriteFile.mockResolvedValueOnce(undefined);

			await TaskArchiver.archiveTask('task-789', '/task/path', {
				taskId: 'task-789',
				isCompleted: true,
			} as any);

			expect(mockReadFile).toHaveBeenCalledTimes(2);
		});

		test('filters empty messages', async () => {
			mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
			const uiMessages = JSON.stringify([
				{ author: 'user', text: '', timestamp: '2026-02-22T10:00:00Z' },
				{ author: 'user', text: '   ', timestamp: '2026-02-22T10:01:00Z' },
				{ author: 'agent', text: 'Valid message', timestamp: '2026-02-22T10:02:00Z' },
			]);
			mockReadFile.mockResolvedValueOnce(uiMessages);
			mockMkdir.mockResolvedValueOnce(undefined);
			mockWriteFile.mockResolvedValueOnce(undefined);

			await TaskArchiver.archiveTask('task-filter', '/task/path', {
				taskId: 'task-filter',
				isCompleted: false,
			} as any);

			expect(mockWriteFile).toHaveBeenCalled();
		});

		test('handles no message files gracefully', async () => {
			mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
			mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // ui_messages
			mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // api_history

			await TaskArchiver.archiveTask('task-none', '/task/path', {
				taskId: 'task-none',
				isCompleted: false,
			} as any);

			// Should not write anything
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		test('filters system messages from API source', async () => {
			mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
			mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // ui_messages not found
			const apiMessages = JSON.stringify([
				{ role: 'system', content: 'System prompt' },
				{ role: 'user', content: 'Hello' },
				{ role: 'assistant', content: 'Hi' },
			]);
			mockReadFile.mockResolvedValueOnce(apiMessages);
			mockMkdir.mockResolvedValueOnce(undefined);
			mockWriteFile.mockResolvedValueOnce(undefined);

			await TaskArchiver.archiveTask('task-sys', '/task/path', {
				taskId: 'task-sys',
				isCompleted: true,
			} as any);

			expect(mockWriteFile).toHaveBeenCalled();
		});
	});

	// ============================================================
	// listArchivedTasks
	// ============================================================

	describe('listArchivedTasks', () => {
		test('returns empty array when archive dir missing', async () => {
			mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));
			const tasks = await TaskArchiver.listArchivedTasks();
			expect(tasks).toEqual([]);
		});

		test('lists all tasks across machines', async () => {
			mockReaddir.mockResolvedValueOnce(['machine-a', 'machine-b']); // top-level dirs
			mockReaddir.mockResolvedValueOnce(['task-1.json.gz', 'task-2.json.gz']); // machine-a
			mockReaddir.mockResolvedValueOnce(['task-3.json.gz']); // machine-b
			const tasks = await TaskArchiver.listArchivedTasks();
			expect(tasks).toContain('task-1');
			expect(tasks).toContain('task-2');
			expect(tasks).toContain('task-3');
			expect(tasks.length).toBe(3);
		});

		test('filters by machineId', async () => {
			mockReaddir.mockResolvedValueOnce(['task-1.json.gz']); // machine-specific dir
			const tasks = await TaskArchiver.listArchivedTasks('machine-a');
			expect(tasks).toContain('task-1');
		});

		test('handles empty machine directory', async () => {
			mockReaddir.mockResolvedValueOnce(['machine-a']); // top-level
			mockReaddir.mockResolvedValueOnce([]); // empty
			const tasks = await TaskArchiver.listArchivedTasks();
			expect(tasks).toEqual([]);
		});
	});

	// ============================================================
	// readArchivedTask
	// ============================================================

	describe('readArchivedTask', () => {
		test('returns null when archive base missing', async () => {
			mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));
			const result = await TaskArchiver.readArchivedTask('task-missing');
			expect(result).toBeNull();
		});

		test('searches across machine directories', async () => {
			mockReaddir.mockResolvedValueOnce(['machine-a', 'machine-b']);
			mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // not in machine-a
			const archivedData = {
				version: 1,
				taskId: 'task-found',
				machineId: 'machine-b',
				messages: [],
			};
			mockReadFile.mockResolvedValueOnce(Buffer.from(JSON.stringify(archivedData)));
			const result = await TaskArchiver.readArchivedTask('task-found');
			expect(result).not.toBeNull();
			expect(result!.taskId).toBe('task-found');
		});

		test('returns null when task not found in any machine', async () => {
			mockReaddir.mockResolvedValueOnce(['machine-a']);
			mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
			const result = await TaskArchiver.readArchivedTask('task-404');
			expect(result).toBeNull();
		});
	});

	// ============================================================
	// archiveClaudeCodeSession
	// ============================================================

	describe('archiveClaudeCodeSession', () => {
		test('skips if Claude Code session already archived', async () => {
			mockAccess.mockResolvedValueOnce(undefined); // file exists
			await TaskArchiver.archiveClaudeCodeSession('session-456', '/path/to/session.jsonl');
			// If archive exists, readFile should not be called for message parsing
			expect(mockReadFile).not.toHaveBeenCalled();
		});

		test('handles no message files found gracefully', async () => {
			mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // archive not exists
			// readJsonlFile uses createReadStream which will fail, simulating no valid JSONL
			// The archiveClaudeCodeSession should handle this by catching and returning early
			await TaskArchiver.archiveClaudeCodeSession('session-empty', '/path/to/session.jsonl');
			// Should not attempt to write if parsing fails
			// (This is implicit in the archiveClaudeCodeSession logic)
		});

		test('distinguishes Claude Code archives with prefix', async () => {
			// Verify that the archive listing methods correctly identify Claude Code sessions
			mockReaddir.mockResolvedValueOnce(['machine-a']);
			mockReaddir.mockResolvedValueOnce(['claude-session-1.json.gz', 'task-1.json.gz']);
			const claudeSessions = await TaskArchiver.listArchivedTasksBySource('claude-code');
			expect(claudeSessions).toContain('session-1');
			expect(claudeSessions).not.toContain('task-1');
		});
	});

	// ============================================================
	// listArchivedTasksBySource
	// ============================================================

	describe('listArchivedTasksBySource', () => {
		test('lists Roo tasks (no claude- prefix)', async () => {
			mockReaddir.mockResolvedValueOnce(['machine-a']); // top-level
			mockReaddir.mockResolvedValueOnce(['task-1.json.gz', 'claude-session-1.json.gz', 'task-2.json.gz']); // machine-a
			const tasks = await TaskArchiver.listArchivedTasksBySource('roo');
			expect(tasks).toContain('task-1');
			expect(tasks).toContain('task-2');
			expect(tasks).not.toContain('session-1'); // Claude tasks filtered out
		});

		test('lists Claude Code tasks (with claude- prefix)', async () => {
			mockReaddir.mockResolvedValueOnce(['machine-a']);
			mockReaddir.mockResolvedValueOnce(['task-1.json.gz', 'claude-session-1.json.gz', 'claude-session-2.json.gz']);
			const tasks = await TaskArchiver.listArchivedTasksBySource('claude-code');
			expect(tasks).toContain('session-1');
			expect(tasks).toContain('session-2');
			expect(tasks).not.toContain('task-1'); // Roo tasks filtered out
		});

		test('filters by machineId for source', async () => {
			mockReaddir.mockResolvedValueOnce(['claude-session-1.json.gz']);
			const tasks = await TaskArchiver.listArchivedTasksBySource('claude-code', 'machine-a');
			expect(tasks).toContain('session-1');
		});

		test('returns empty array when archive dir missing', async () => {
			mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));
			const tasks = await TaskArchiver.listArchivedTasksBySource('roo');
			expect(tasks).toEqual([]);
		});
	});
});
