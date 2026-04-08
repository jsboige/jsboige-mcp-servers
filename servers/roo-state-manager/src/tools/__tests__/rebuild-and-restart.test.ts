/**
 * Tests pour rebuild-and-restart.ts
 * Issue #492 - Couverture des outils top-level
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockExec } = vi.hoisted(() => ({
	mockExec: vi.fn()
}));

const { mockReadFile } = vi.hoisted(() => ({
	mockReadFile: vi.fn()
}));

vi.mock('child_process', () => ({
	exec: (...args: any[]) => {
		// Handle both exec(cmd, opts, cb) and exec(cmd, cb) signatures
		const cb = typeof args[1] === 'function' ? args[1] : args[2];
		return mockExec(args[0], typeof args[1] === 'function' ? {} : args[1], cb);
	}
}));

vi.mock('fs/promises', () => ({
	default: { readFile: mockReadFile },
	readFile: mockReadFile
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
		// Use a path recognized by getMcpSettingsPath() safety guard
		process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming';
	});

	afterEach(() => {
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

	test('handles settings file read error', async () => {
		mockReadFile.mockRejectedValue(new Error('File not found'));

		const { rebuildAndRestart } = await import('../rebuild-and-restart.js');
		const result = await rebuildAndRestart.handler({ mcp_name: 'test-mcp' });

		expect(result.content[0].text).toContain('Error');
		expect(result.content[0].text).toContain('File not found');
	});
});
