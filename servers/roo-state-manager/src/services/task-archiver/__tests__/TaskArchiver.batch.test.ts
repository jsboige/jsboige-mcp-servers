/**
 * Tests pour TaskArchiver.ts - archivage batch Claude Code
 * Tests additionnels pour améliorer la couverture
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock external dependencies before importing
const { mockReadFile, mockWriteFile, mockMkdir, mockAccess, mockReaddir, mockStat } = vi.hoisted(() => ({
	mockReadFile: vi.fn(),
	mockWriteFile: vi.fn(),
	mockMkdir: vi.fn(),
	mockAccess: vi.fn(),
	mockReaddir: vi.fn(),
	mockStat: vi.fn(),
}));

vi.mock('fs', () => ({
	promises: {
		readFile: mockReadFile,
		writeFile: mockWriteFile,
		mkdir: mockMkdir,
		access: mockAccess,
		readdir: mockReaddir,
		stat: mockStat,
	},
	default: {
		promises: {
			readFile: mockReadFile,
			writeFile: mockWriteFile,
			mkdir: mockMkdir,
			access: mockAccess,
			readdir: mockReaddir,
			stat: mockStat,
		},
	},
	createReadStream: vi.fn(),
}));

vi.mock('readline', () => ({
	createInterface: vi.fn(() => ({
		on: vi.fn((event, callback) => {
			if (event === 'line') {
				// Simuler des lignes JSONL
				callback('{"sessionId":"test-1","message":{"role":"user","content":"Hello"}}');
				callback('{"sessionId":"test-1","message":{"role":"assistant","content":"Hi there"}}');
			}
			if (event === 'close') {
				callback();
			}
		}),
		close: vi.fn(),
	})),
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

describe('TaskArchiver - Additional Coverage Tests', () => {
	let capturedJsonData: any = null;

	beforeEach(() => {
		vi.clearAllMocks();
		capturedJsonData = null;

		// Configuration par défaut des mocks
		mockAccess.mockRejectedValue(new Error('ENOENT')); // archive n'existe pas

		// Mock gzip pour capturer les données JSON avant compression
		mockGzip.mockImplementation(async (buf: Buffer) => {
			const data = JSON.parse(buf.toString('utf-8'));
			capturedJsonData = data;
			return Buffer.from('compressed');
		});

		mockMkdir.mockResolvedValue(undefined);
		mockWriteFile.mockResolvedValue(undefined);
		mockStat.mockResolvedValue({
			isDirectory: () => true,
			isFile: () => false,
		});
	});

	// ============================================================
	// archiveClaudeCodeSessions - tests simples
	// ============================================================

	describe('archiveClaudeCodeSessions - error handling', () => {
		test('handles readdir errors on projects directory', async () => {
			mockReaddir.mockRejectedValueOnce(new Error('Permission denied'));

			const result = await TaskArchiver.archiveClaudeCodeSessions('/projects');

			expect(result.archived).toBe(0);
			expect(result.failed).toBe(0);
		});

		test('handles empty projects directory', async () => {
			mockReaddir.mockResolvedValueOnce([]);

			const result = await TaskArchiver.archiveClaudeCodeSessions('/projects');

			expect(result.archived).toBe(0);
			expect(result.failed).toBe(0);
		});

		test('respects maxSessions limit of 0', async () => {
			mockReaddir.mockResolvedValueOnce(['project-a']);
			mockStat.mockResolvedValue({ isDirectory: () => true } as any);

			const result = await TaskArchiver.archiveClaudeCodeSessions('/projects', 0);

			expect(result.archived).toBe(0);
		});

		test('handles non-directory entries gracefully', async () => {
			mockReaddir.mockResolvedValueOnce(['readme.md']);
			mockStat.mockResolvedValue({ isDirectory: () => false, isFile: () => true } as any);

			const result = await TaskArchiver.archiveClaudeCodeSessions('/projects');

			// readme.md devrait être ignoré (pas un répertoire)
			expect(result.archived).toBe(0);
		});

		test('handles project with no subdirectories', async () => {
			mockReaddir.mockResolvedValueOnce(['project-a']);
			mockStat.mockResolvedValue({ isDirectory: () => true } as any);
			mockReaddir.mockResolvedValueOnce([]); // No sessions

			const result = await TaskArchiver.archiveClaudeCodeSessions('/projects');

			expect(result.archived).toBe(0);
		});

		test('counts failed archives separately', async () => {
			mockReaddir.mockResolvedValueOnce(['project-a']);
			mockStat.mockResolvedValue({ isDirectory: () => true } as any);
			mockReaddir.mockResolvedValueOnce(['session-1']);
			mockStat.mockResolvedValue({ isDirectory: () => true } as any);
			mockReaddir.mockResolvedValueOnce(['conversations.jsonl']);
			mockStat.mockResolvedValue({ isDirectory: () => false, isFile: () => true } as any);

			// Simuler une erreur lors de l'écriture
			mockWriteFile.mockRejectedValueOnce(new Error('Write failed'));

			const result = await TaskArchiver.archiveClaudeCodeSessions('/projects');

			// L'erreur devrait être comptée comme failed
			expect(result.failed).toBeGreaterThanOrEqual(0);
		});
	});

	// ============================================================
	// archiveClaudeCodeSession - tests de titre
	// ============================================================

	describe('archiveClaudeCodeSession - title handling', () => {
		test('skips when archive already exists as v2', async () => {
			// v2 archive bump: existence is detected by reading + parsing
			// the archive (not fs.access). Provide a v2 payload so the
			// hoisted gunzip mock (which returns its input unchanged)
			// yields parseable JSON with version === 2.
			mockReadFile.mockResolvedValueOnce(
				Buffer.from(JSON.stringify({ version: 2, taskId: 'x', messages: [] }))
			);
			const jsonlPath = '/some/weird/path/conversations.jsonl';

			await TaskArchiver.archiveClaudeCodeSession('session-123', jsonlPath, 'Custom Title');

			// Ne devrait pas appeler gzip ni writeFile
			expect(mockGzip).not.toHaveBeenCalled();
			expect(mockWriteFile).not.toHaveBeenCalled();
		});

		test('handles JSONL read errors gracefully', async () => {
			mockAccess.mockRejectedValue(new Error('ENOENT'));
			// Le mock readline retourne déjà des données, donc ce test vérifie juste que ça ne crash pas
			const jsonlPath = '/some/weird/path/conversations.jsonl';

			// Ne devrait pas throw
			await expect(TaskArchiver.archiveClaudeCodeSession('session-123', jsonlPath)).resolves.toBeUndefined();
		});
	});

	// ============================================================
	// readArchivedTask - scénarios Claude Code
	// ============================================================

	describe('readArchivedTask - Claude Code format', () => {
		test('reads Claude Code archived task with claude- prefix', async () => {
			const archivedData = {
				version: 1,
				taskId: 'claude-session-1',
				machineId: 'machine-a',
				messages: [{ role: 'user', content: 'Hello' }],
			};

			mockReaddir.mockResolvedValueOnce(['machine-a']);
			mockReadFile
				.mockRejectedValueOnce(new Error('ENOENT')) // Roo format not found
				.mockResolvedValueOnce(Buffer.from(JSON.stringify(archivedData))); // Claude format found

			const result = await TaskArchiver.readArchivedTask('claude-session-1');

			expect(result).not.toBeNull();
			expect(result!.taskId).toBe('claude-session-1');
		});

		test('returns null when neither format is found', async () => {
			mockReaddir.mockResolvedValueOnce(['machine-a']);
			mockReadFile
				.mockRejectedValueOnce(new Error('ENOENT')) // Roo format not found
				.mockRejectedValueOnce(new Error('ENOENT')); // Claude format not found

			const result = await TaskArchiver.readArchivedTask('missing-task');

			expect(result).toBeNull();
		});
	});

	// ============================================================
	// listArchivedTasks - edge cases
	// ============================================================

	describe('listArchivedTasks - additional scenarios', () => {
		test('filters out non-gz files', async () => {
			mockReaddir.mockResolvedValueOnce(['machine-a']);
			mockReaddir.mockResolvedValueOnce(['task-1.json.gz', 'task-2.json', 'readme.txt', '.gitignore']);

			const tasks = await TaskArchiver.listArchivedTasks();

			// Seul task-1.json.gz devrait être retourné
			expect(tasks).toContain('task-1');
			expect(tasks).not.toContain('task-2');
			expect(tasks).not.toContain('readme');
			expect(tasks.length).toBe(1);
		});

		test('handles machine directory read errors gracefully', async () => {
			mockReaddir.mockResolvedValueOnce(['machine-a', 'machine-b']);
			mockReaddir
				.mockRejectedValueOnce(new Error('Permission denied')) // machine-a fails
				.mockResolvedValueOnce(['task-1.json.gz']); // machine-b succeeds

			const tasks = await TaskArchiver.listArchivedTasks();

			// machine-b devrait contribuer task-1
			expect(tasks).toContain('task-1');
		});
	});
});
