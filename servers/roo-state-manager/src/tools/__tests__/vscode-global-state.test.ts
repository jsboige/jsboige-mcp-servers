/**
 * Tests pour vscode-global-state.ts
 * Issue #492 - Couverture des outils top-level
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockAccess, mockReaddir, mockStat, mockReadFile, mockWriteFile } = vi.hoisted(() => ({
	mockAccess: vi.fn(),
	mockReaddir: vi.fn(),
	mockStat: vi.fn(),
	mockReadFile: vi.fn(),
	mockWriteFile: vi.fn()
}));

const { mockDatabase } = vi.hoisted(() => ({
	mockDatabase: vi.fn()
}));

vi.mock('fs/promises', () => ({
	default: {
		access: mockAccess,
		readdir: mockReaddir,
		stat: mockStat,
		readFile: mockReadFile,
		writeFile: mockWriteFile
	},
	access: mockAccess,
	readdir: mockReaddir,
	stat: mockStat,
	readFile: mockReadFile,
	writeFile: mockWriteFile
}));

vi.mock('sqlite3', () => {
	// Database constructor: returns an object with methods, calls cb async via nextTick
	// This avoids "Cannot access 'db' before initialization" when source does:
	//   const db = new Database(path, mode, (err) => resolve(db))
	const DatabaseClass = function(this: any, filePath: string, mode: number, cb: Function) {
		this.get = vi.fn();
		this.run = vi.fn();
		this.close = vi.fn((closeCb: Function) => closeCb(null));
		this._error = null;
		// Let test configure instance (set _error, override get/close, etc.)
		mockDatabase(filePath, mode, this);
		// Defer callback so `db` variable is assigned before callback runs
		const err = this._error;
		process.nextTick(() => cb(err));
		return this;
	} as any;

	return {
		default: { Database: DatabaseClass, OPEN_READWRITE: 2 },
		Database: DatabaseClass,
		OPEN_READWRITE: 2
	};
});

vi.mock('../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		analyzeConversation: vi.fn().mockResolvedValue(null)
	}
}));

vi.mock('../../types/errors.js', () => ({
	GenericError: class extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message); this.name = 'GenericError'; this.code = code;
		}
	},
	GenericErrorCode: { FILE_SYSTEM_ERROR: 'FILE_SYSTEM_ERROR' }
}));

describe('vscode-global-state', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('testVscodeGlobalStateFile', () => {
		test('returns success message', async () => {
			const { testVscodeGlobalStateFile } = await import('../vscode-global-state.js');
			const result = await testVscodeGlobalStateFile.handler();
			expect(result.content[0].text).toContain('Test réussi');
		});

		test('has correct metadata', async () => {
			const { testVscodeGlobalStateFile } = await import('../vscode-global-state.js');
			expect(testVscodeGlobalStateFile.name).toBe('test_vscode_global_state_file');
		});
	});

	describe('rebuildTaskIndex', () => {
		test('has correct metadata', async () => {
			const { rebuildTaskIndex } = await import('../vscode-global-state.js');
			expect(rebuildTaskIndex.name).toBe('rebuild_task_index');
			expect(rebuildTaskIndex.inputSchema.properties).toHaveProperty('workspace_filter');
			expect(rebuildTaskIndex.inputSchema.properties).toHaveProperty('max_tasks');
			expect(rebuildTaskIndex.inputSchema.properties).toHaveProperty('dry_run');
		});

		test('handles database open failure', async () => {
			// findVSCodeGlobalStateFile: access succeeds for state.vscdb
			mockAccess.mockResolvedValueOnce(undefined);
			// openDatabase: fails via _error flag
			mockDatabase.mockImplementation((path: string, mode: number, self: any) => {
				self._error = new Error('Cannot open database');
			});

			const { rebuildTaskIndex } = await import('../vscode-global-state.js');
			const result = await rebuildTaskIndex.handler({});

			expect(result.content[0].text).toContain('Erreur');
		});

		test('reports no orphans when all tasks indexed', async () => {
			// findVSCodeGlobalStateFile
			mockAccess.mockResolvedValueOnce(undefined);

			// openDatabase succeeds - configure the db instance methods
			mockDatabase.mockImplementation((path: string, mode: number, self: any) => {
				self.get = (sql: string, cb2: Function) => {
					cb2(null, { value: JSON.stringify({ taskHistory: [{ id: 'task-1', ts: 1000, task: 'Test', workspace: 'ws' }] }) });
				};
				self.close = (cb2: Function) => cb2(null);
			});

			// Scan disk tasks
			mockReaddir.mockResolvedValueOnce(['task-1']); // same task as indexed
			mockStat.mockResolvedValueOnce({ isDirectory: () => true, mtime: new Date() });
			mockReaddir.mockResolvedValueOnce(['file.json']); // has files

			const { rebuildTaskIndex } = await import('../vscode-global-state.js');
			const result = await rebuildTaskIndex.handler({});

			expect(result.content[0].text).toContain('Aucune tâche orpheline');
		});

		test('returns error when tasks directory unreadable', async () => {
			// findVSCodeGlobalStateFile
			mockAccess.mockResolvedValueOnce(undefined);
			mockDatabase.mockImplementation((path: string, mode: number, self: any) => {
				self.get = (sql: string, cb2: Function) => {
					cb2(null, { value: JSON.stringify({ taskHistory: [] }) });
				};
				self.close = (cb2: Function) => cb2(null);
			});

			// Disk scan fails
			mockReaddir.mockRejectedValueOnce(new Error('Permission denied'));

			const { rebuildTaskIndex } = await import('../vscode-global-state.js');
			const result = await rebuildTaskIndex.handler({});

			expect(result.content[0].text).toContain('Erreur');
		});

		test('handles no state file found', async () => {
			// All access checks fail
			mockAccess.mockRejectedValue(new Error('ENOENT'));
			// readdir for fallback search also fails
			mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));

			const { rebuildTaskIndex } = await import('../vscode-global-state.js');
			const result = await rebuildTaskIndex.handler({});

			expect(result.content[0].text).toContain('Erreur');
		});
	});
});
