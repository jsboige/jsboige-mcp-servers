/**
 * Tests pour rebuild-and-restart.ts
 * Issue #492 - Couverture des outils top-level
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockExec } = vi.hoisted(() => ({
	mockExec: vi.fn()
}));

const { mockReadFile } = vi.hoisted(() => ({
	mockReadFile: vi.fn()
}));

const { mockAccess } = vi.hoisted(() => ({
	mockAccess: vi.fn()
}));

vi.mock('child_process', () => ({
	exec: (...args: any[]) => {
		// Handle both exec(cmd, opts, cb) and exec(cmd, cb) signatures
		const cb = typeof args[1] === 'function' ? args[1] : args[2];
		return mockExec(args[0], typeof args[1] === 'function' ? {} : args[1], cb);
	}
}));

vi.mock('fs/promises', () => ({
	default: { readFile: mockReadFile, access: mockAccess },
	readFile: mockReadFile,
	access: mockAccess
}));

vi.mock('../../types/errors.js', () => ({
	GenericError: class extends Error {
		code: string;
		constructor(message: string, code: string) {
			super(message); this.name = 'GenericError'; this.code = code;
		}
	},
	GenericErrorCode: {
		FILE_SYSTEM_ERROR: 'FILE_SYSTEM_ERROR',
		INVALID_ARGUMENT: 'INVALID_ARGUMENT'
	}
}));

describe('rebuild-and-restart', () => {
	const origAppdata = process.env.APPDATA;

	beforeEach(() => {
		vi.clearAllMocks();
		// Fake-timer leak defense (review note roo-extensions#1352): if a sibling
		// test file in the same worker armed vi.useFakeTimers() and failed before
		// its own afterEach restored real timers, the async exec chains below
		// would hang on frozen timers (EBUSY-style timeout observed on #1352).
		// vi.useRealTimers() is a no-op when timers are already real.
		vi.useRealTimers();
		// #4006: rebuild now requires package.json at the resolved path — default
		// to present so legacy cwd tests keep their semantics; the refusal test
		// overrides per-call.
		mockAccess.mockResolvedValue(undefined);
		// Use a path recognized by getMcpSettingsPath() safety guard
		process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming';
	});

	afterEach(() => {
		// Restore real timers + APPDATA so this file never leaks fake timers
		// into the next test file of the worker either (mirror of the beforeEach
		// defense — review note roo-extensions#1352).
		vi.useRealTimers();
		process.env.APPDATA = origAppdata;
	});

	test('has correct tool metadata', async () => {
		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		expect(rebuildAndRestart.name).toBe('rebuild_and_restart_mcp');
		expect(rebuildAndRestart.inputSchema.required).toContain('mcp_name');
	});

	test('returns error when MCP not found in settings', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify({ mcpServers: {} }));

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const result = await rebuildAndRestart.handler({ mcp_name: 'nonexistent' });

		expect(result.content[0].text).toContain('Error');
		expect(result.content[0].text).toContain('nonexistent');
	});

	test('returns error when cannot determine cwd', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify({
			mcpServers: {
				'test-mcp': { command: 'node', args: ['index.js'] }
			}
		}));

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

		expect(result.content[0].text).toContain('Error');
		expect(result.content[0].text).toContain('working directory');
	});

	test('builds and restarts via watchPaths', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify({
			mcpServers: {
				'test-mcp': {
					command: 'node',
					cwd: '/path/to/mcp',
					watchPaths: ['/path/to/mcp/build/index.js']
				}
			}
		}));

		// Mock exec for npm build (success)
		mockExec.mockImplementation((cmd: string, opts: any, cb: Function) => {
			cb(null, 'Build output', '');
		});

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

		expect(result.content[0].text).toContain('successful');
		expect(result.content[0].text).toContain('targeted restart');
	});

	test('falls back to global restart without watchPaths', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify({
			mcpServers: {
				'test-mcp': {
					command: 'node',
					cwd: '/path/to/mcp'
				}
			}
		}));

		mockExec.mockImplementation((cmd: string, opts: any, cb: Function) => {
			cb(null, 'output', '');
		});

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

		expect(result.content[0].text).toContain('WARNING');
		expect(result.content[0].text).toContain('watchPaths');
	});

	test('returns error on build failure', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify({
			mcpServers: {
				'test-mcp': {
					command: 'node',
					cwd: '/path/to/mcp',
					watchPaths: ['/path/to/mcp/build/index.js']
				}
			}
		}));

		mockExec.mockImplementation((cmd: string, opts: any, cb: Function) => {
			cb(new Error('Compilation error'), '', 'Error details');
		});

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

		expect(result.content[0].text).toContain('Error');
	});

	test('resolves cwd from options.cwd', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify({
			mcpServers: {
				'test-mcp': {
					command: 'node',
					options: { cwd: '/opts/path' },
					watchPaths: ['/opts/path/build/index.js']
				}
			}
		}));

		mockExec.mockImplementation((cmd: string, opts: any, cb: Function) => {
			cb(null, 'Build OK', '');
		});

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

		expect(result.content[0].text).toContain('successful');
	});

	test('resolves cwd from args path', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify({
			mcpServers: {
				'test-mcp': {
					command: 'node',
					args: ['/path/to/mcp/dist/index.js'],
					watchPaths: ['/path/to/mcp/dist/index.js']
				}
			}
		}));

		mockExec.mockImplementation((cmd: string, opts: any, cb: Function) => {
			cb(null, 'Build OK', '');
		});

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

		expect(result.content[0].text).toContain('successful');
	});

	test('refuses to build when resolved path has no package.json (#4006)', async () => {
		// dirname(dirname('D:/build/index.js')) = 'D:/' — filesystem root, no package.json
		mockReadFile.mockResolvedValue(JSON.stringify({
			mcpServers: {
				'test-mcp': {
					command: 'node',
					args: ['D:/build/index.js']
				}
			}
		}));

		mockAccess.mockRejectedValue(new Error('ENOENT'));

		mockExec.mockImplementation((cmd: string, opts: any, cb: Function) => {
			cb(null, 'Build OK', '');
		});

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

		expect(result.content[0].text).toContain('package.json');
		expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining('npm run build'), expect.anything(), expect.anything());
	});

	test('handles settings file read error', async () => {
		mockReadFile.mockRejectedValue(new Error('File not found'));

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

		expect(result.content[0].text).toContain('Error');
		expect(result.content[0].text).toContain('File not found');
	});

	// ============================================================
	// #2307 (Phase 4, item EBUSY) — même retry borné que
	// roosync_mcp_management rebuild : sous Windows, l'hôte MCP vivant
	// tient sqlite3.node chargé pendant le rebuild → EBUSY transitoire.
	// ============================================================
	test('retries npm build on EBUSY then succeeds (#2307)', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify({
			mcpServers: {
				'test-mcp': {
					command: 'node',
					cwd: '/path/to/mcp',
					watchPaths: ['/path/to/mcp/build/index.js']
				}
			}
		}));

		vi.useFakeTimers();
		let call = 0;
		mockExec.mockImplementation((cmd: string, opts: any, cb: Function) => {
			if (cmd.includes('npm run build')) {
				call++;
				if (call === 1) {
					const err: Error & { code?: string } = new Error(
						'EBUSY: resource busy or locked, open D:\\mcp\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node'
					);
					err.code = 'EBUSY';
					cb(err, '', '');
				} else {
					cb(null, 'build ok', '');
				}
			} else {
				cb(null, '', '');
			}
		});

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const pending = rebuildAndRestart.handler({ mcp_name: 'test-mcp' });
		// Resout le backoff de la 1re tentative (2000 ms).
		await vi.advanceTimersByTimeAsync(2500);
		const result = await pending;

		expect(result.content[0].text).toContain('successful');
		const npmBuildCalls = mockExec.mock.calls.filter(c => String(c[0]).includes('npm run build')).length;
		expect(npmBuildCalls).toBe(2);
		vi.useRealTimers();
	});

	test('non-EBUSY build error → no retry (#2307)', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify({
			mcpServers: {
				'test-mcp': {
					command: 'node',
					cwd: '/path/to/mcp',
					watchPaths: ['/path/to/mcp/build/index.js']
				}
			}
		}));

		mockExec.mockImplementation((cmd: string, opts: any, cb: Function) => {
			cb(new Error('TS2304: Cannot find name'), '', 'Error details');
		});

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

		expect(result.content[0].text).toContain('Error');
		const npmBuildCalls = mockExec.mock.calls.filter(c => String(c[0]).includes('npm run build')).length;
		expect(npmBuildCalls).toBe(1);
	});

	test('global fallback touches the settings file exactly once (#2307)', async () => {
		mockReadFile.mockResolvedValue(JSON.stringify({
			mcpServers: {
				'test-mcp': {
					command: 'node',
					cwd: '/path/to/mcp'
				}
			}
		}));

		mockExec.mockImplementation((cmd: string, opts: any, cb: Function) => {
			cb(null, 'output', '');
		});

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

		expect(result.content[0].text).toContain('WARNING');
		const touchCalls = mockExec.mock.calls.filter(c => String(c[0]).includes('powershell.exe')).length;
		expect(touchCalls).toBe(1);
	});
});
