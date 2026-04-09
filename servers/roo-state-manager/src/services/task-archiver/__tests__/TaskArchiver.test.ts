/**
 * Tests pour TaskArchiver.ts
 * Issue #492 - Couverture du service d'archivage
 *
 * Teste les fonctions publiques archiveTask / archiveClaudeCodeSession /
 * readArchivedTask / listArchivedTasks / migrateV1Archives, ainsi que la
 * strategie upgrade-if-v1 (soft transition v1 -> v2, aucune troncature).
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
		// Helpers --------------------------------------------------------
		// The hoisted gunzip mock returns its input unchanged, so a "gzipped"
		// archive is simulated as a raw Buffer containing the JSON payload.
		const archiveV2 = (extra: Record<string, any> = {}) =>
			Buffer.from(JSON.stringify({ version: 2, taskId: 'x', messages: [], ...extra }));
		const archiveV1 = (extra: Record<string, any> = {}) =>
			Buffer.from(JSON.stringify({ version: 1, taskId: 'x', messages: [], ...extra }));
		const missingArchive = () => mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

		test('skips if archive already exists as v2', async () => {
			mockReadFile.mockResolvedValueOnce(archiveV2()); // version check returns v2
			await TaskArchiver.archiveTask('task-123', '/task/path', {
				taskId: 'task-123',
				isCompleted: true,
			} as any);
			// Only the version-check read happened; no source read, no write.
			expect(mockReadFile).toHaveBeenCalledTimes(1);
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		test('upgrades existing v1 archive to v2 (soft transition)', async () => {
			mockReadFile.mockResolvedValueOnce(archiveV1()); // version check returns v1
			const uiMessages = JSON.stringify([
				{ author: 'user', text: 'Hello', timestamp: '2026-02-22T10:00:00Z' },
				{ author: 'agent', text: 'Hi', timestamp: '2026-02-22T10:01:00Z' },
			]);
			mockReadFile.mockResolvedValueOnce(uiMessages);
			mockMkdir.mockResolvedValueOnce(undefined);
			mockWriteFile.mockResolvedValueOnce(undefined);

			await TaskArchiver.archiveTask('task-upgrade', '/task/path', {
				taskId: 'task-upgrade',
				isCompleted: true,
			} as any);

			// v1 archive triggered a full re-archive (version + ui source = 2 reads)
			expect(mockReadFile).toHaveBeenCalledTimes(2);
			expect(mockWriteFile).toHaveBeenCalled();
		});

		test('reads ui_messages.json as primary source', async () => {
			missingArchive();
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

			// 1 read for version check (failed) + 1 read for ui_messages
			expect(mockReadFile).toHaveBeenCalledTimes(2);
			expect(mockMkdir).toHaveBeenCalled();
			expect(mockWriteFile).toHaveBeenCalled();
		});

		test('falls back to api_conversation_history.json', async () => {
			missingArchive();
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

			// version check + ui_messages + api_history = 3 reads
			expect(mockReadFile).toHaveBeenCalledTimes(3);
		});

		test('filters empty messages', async () => {
			missingArchive();
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
			missingArchive();
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
			missingArchive();
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

		test('preserves full message content without truncation', async () => {
			missingArchive();
			// A payload much larger than the old 10KB truncation threshold.
			const big = 'A'.repeat(60 * 1024);
			const uiMessages = JSON.stringify([
				{ author: 'user', text: big, timestamp: '2026-02-22T10:00:00Z' },
			]);
			mockReadFile.mockResolvedValueOnce(uiMessages);
			mockMkdir.mockResolvedValueOnce(undefined);

			// Capture the serialized archive that TaskArchiver passes to gzip.
			let capturedJson = '';
			mockWriteFile.mockImplementationOnce(async (_p: string, _buf: Buffer) => {
				// The hoisted gzip mock returns a fixed stub, so we instead snapshot
				// via the JSON payload that archiveTask built before gzipping — the
				// only observable side effect is that writeFile was called once.
				return undefined;
			});

			// Spy on JSON.stringify to capture the archived payload the code serializes.
			const realStringify = JSON.stringify;
			const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementation((value: any, ...rest: any[]) => {
				const out = (realStringify as any)(value, ...rest);
				if (value && typeof value === 'object' && 'version' in value && 'messages' in value) {
					capturedJson = out;
				}
				return out;
			});

			await TaskArchiver.archiveTask('task-big', '/task/path', {
				taskId: 'task-big',
				isCompleted: true,
			} as any);

			stringifySpy.mockRestore();

			expect(mockWriteFile).toHaveBeenCalled();
			const payload = JSON.parse(capturedJson);
			expect(payload.version).toBe(2);
			expect(payload.messages[0].content.length).toBe(big.length);
			expect(payload.messages[0].content).not.toContain('[... truncated ...]');
		});

		test('writes archives as v2 format', async () => {
			missingArchive();
			const uiMessages = JSON.stringify([
				{ author: 'user', text: 'hello', timestamp: '2026-02-22T10:00:00Z' },
			]);
			mockReadFile.mockResolvedValueOnce(uiMessages);
			mockMkdir.mockResolvedValueOnce(undefined);
			mockWriteFile.mockResolvedValueOnce(undefined);

			let captured: any;
			const realStringify = JSON.stringify;
			const spy = vi.spyOn(JSON, 'stringify').mockImplementation((v: any, ...rest: any[]) => {
				const out = (realStringify as any)(v, ...rest);
				if (v && typeof v === 'object' && 'version' in v && 'messages' in v) captured = v;
				return out;
			});

			await TaskArchiver.archiveTask('task-v2', '/task/path', {
				taskId: 'task-v2',
				isCompleted: true,
			} as any);

			spy.mockRestore();
			expect(captured.version).toBe(2);
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
		test('skips if Claude Code session already archived as v2', async () => {
			mockReadFile.mockResolvedValueOnce(
				Buffer.from(JSON.stringify({ version: 2, taskId: 'x', messages: [] }))
			);
			await TaskArchiver.archiveClaudeCodeSession('session-456', '/path/to/session.jsonl');
			// Version check returned v2 → skip path, no mkdir/writeFile.
			expect(mockReadFile).toHaveBeenCalledTimes(1);
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		test('handles no message files found gracefully', async () => {
			mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // archive version check
			// readJsonlFile uses createReadStream which will fail, simulating no valid JSONL
			// The archiveClaudeCodeSession should handle this by catching and returning early
			await TaskArchiver.archiveClaudeCodeSession('session-empty', '/path/to/session.jsonl');
			// Should not attempt to write if parsing fails
			expect(mockWriteFile).not.toHaveBeenCalled();
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

	// ============================================================
	// migrateV1Archives (soft transition batch migration)
	// ============================================================

	describe('migrateV1Archives', () => {
		const v1Buf = () => Buffer.from(JSON.stringify({ version: 1, taskId: 't', messages: [] }));
		const v2Buf = () => Buffer.from(JSON.stringify({ version: 2, taskId: 't', messages: [] }));

		test('returns zero counts when machine dir missing', async () => {
			mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));
			const res = await TaskArchiver.migrateV1Archives({ machineId: 'ghost' });
			expect(res).toEqual({ scanned: 0, v1Found: 0, upgraded: 0, errors: 0 });
		});

		test('dryRun reports v1 archives without writing', async () => {
			mockReaddir.mockResolvedValueOnce(['a.json.gz', 'b.json.gz', 'c.json.gz']);
			mockReadFile.mockResolvedValueOnce(v1Buf());
			mockReadFile.mockResolvedValueOnce(v2Buf());
			mockReadFile.mockResolvedValueOnce(v1Buf());

			const res = await TaskArchiver.migrateV1Archives({ dryRun: true, machineId: 'test-machine' });

			expect(res.scanned).toBe(3);
			expect(res.v1Found).toBe(2);
			expect(res.upgraded).toBe(0);
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		test('upgrades v1 archives and skips v2 archives', async () => {
			mockReaddir.mockResolvedValueOnce(['a.json.gz', 'b.json.gz']);
			// File a: v1 — first the version-check read, then the actual re-read for rewrite.
			mockReadFile.mockResolvedValueOnce(v1Buf()); // version check a
			mockReadFile.mockResolvedValueOnce(v1Buf()); // re-read a for upgrade
			// File b: v2 — version check only, then skipped.
			mockReadFile.mockResolvedValueOnce(v2Buf());

			const res = await TaskArchiver.migrateV1Archives({ machineId: 'test-machine', rateLimitMs: 0 });

			expect(res.scanned).toBe(2);
			expect(res.v1Found).toBe(1);
			expect(res.upgraded).toBe(1);
			expect(mockWriteFile).toHaveBeenCalledTimes(1);
		});

		test('counts unreadable archives as errors', async () => {
			mockReaddir.mockResolvedValueOnce(['corrupt.json.gz']);
			mockReadFile.mockRejectedValueOnce(new Error('EACCES'));

			const res = await TaskArchiver.migrateV1Archives({ machineId: 'test-machine', rateLimitMs: 0 });

			expect(res.scanned).toBe(1);
			expect(res.errors).toBe(1);
			expect(res.upgraded).toBe(0);
		});

		test('invokes onProgress callback for each file', async () => {
			mockReaddir.mockResolvedValueOnce(['a.json.gz', 'b.json.gz']);
			mockReadFile.mockResolvedValueOnce(v2Buf());
			mockReadFile.mockResolvedValueOnce(v2Buf());

			const progress: Array<[number, number]> = [];
			await TaskArchiver.migrateV1Archives({
				machineId: 'test-machine',
				rateLimitMs: 0,
				onProgress: (done, total) => progress.push([done, total]),
			});

			expect(progress).toEqual([[1, 2], [2, 2]]);
		});
	});
});
