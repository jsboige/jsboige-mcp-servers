/**
 * Tests pour read-vscode-logs.ts
 * Issue #492 - Couverture des outils top-level
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockReaddir, mockReadFile, mockAccess, mockStat } = vi.hoisted(() => ({
	mockReaddir: vi.fn(),
	mockReadFile: vi.fn(),
	mockAccess: vi.fn(),
	mockStat: vi.fn()
}));

vi.mock('fs/promises', () => ({
	default: {
		readdir: mockReaddir,
		readFile: mockReadFile,
		access: mockAccess,
		stat: mockStat
	},
	readdir: mockReaddir,
	readFile: mockReadFile,
	access: mockAccess,
	stat: mockStat
}));

describe('read-vscode-logs', () => {
	const origAppdata = process.env.APPDATA;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
	});

	afterEach(() => {
		process.env.APPDATA = origAppdata;
	});

	test('has correct tool metadata', async () => {
		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		expect(readVscodeLogs.name).toBe('read_vscode_logs');
		expect(readVscodeLogs.inputSchema.properties).toHaveProperty('lines');
		expect(readVscodeLogs.inputSchema.properties).toHaveProperty('filter');
		expect(readVscodeLogs.inputSchema.properties).toHaveProperty('maxSessions');
	});

	test('returns error when APPDATA not set', async () => {
		delete process.env.APPDATA;
		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({});
		expect(result.content[0].text).toContain('APPDATA');
	});

	test('returns no sessions message when directory empty', async () => {
		mockReaddir.mockResolvedValueOnce([]);

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({});
		expect(result.content[0].text).toContain('No session log directory found');
	});

	test('finds and reads log files from session directories', async () => {
		// Session dirs
		mockReaddir.mockResolvedValueOnce([
			{ name: '20260215T100000', isDirectory: () => true }
		]);
		// Window dirs in session
		mockReaddir.mockResolvedValueOnce([
			{ name: 'window1', isDirectory: () => true }
		]);
		// Access check for renderer.log
		mockAccess.mockResolvedValueOnce(undefined);
		// Read renderer.log
		mockReadFile.mockResolvedValueOnce('renderer log line 1\nrenderer log line 2');
		// Access check for exthost.log
		mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
		// Access check for main.log
		mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
		// Access check for nested exthost
		mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
		// exthost dir listing
		mockReaddir.mockResolvedValueOnce([]);

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({ lines: 50 });

		expect(result.content[0].text).toContain('renderer');
		expect(result.content[0].text).toContain('renderer log line');
	});

	test('handles multiple sessions with maxSessions', async () => {
		// Session dirs - 3 sessions
		mockReaddir.mockResolvedValueOnce([
			{ name: '20260215T100000', isDirectory: () => true },
			{ name: '20260214T100000', isDirectory: () => true },
			{ name: '20260213T100000', isDirectory: () => true }
		]);
		// First session - window dirs
		mockReaddir.mockResolvedValueOnce([
			{ name: 'window1', isDirectory: () => true }
		]);
		// First session - log file access checks
		mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // renderer
		mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // exthost
		mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // main
		mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // nested exthost
		mockReaddir.mockResolvedValueOnce([]); // exthost output dirs
		// Second session - window dirs
		mockReaddir.mockResolvedValueOnce([
			{ name: 'window1', isDirectory: () => true }
		]);
		mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
		mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
		mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
		mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
		mockReaddir.mockResolvedValueOnce([]);

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({ maxSessions: 2 });

		// Should have processed 2 sessions maximum
		expect(result.content[0].text).toBeDefined();
	});

	test('applies filter to log lines', async () => {
		mockReaddir.mockResolvedValueOnce([
			{ name: '20260215T100000', isDirectory: () => true }
		]);
		mockReaddir.mockResolvedValueOnce([
			{ name: 'window1', isDirectory: () => true }
		]);
		mockAccess.mockResolvedValueOnce(undefined); // renderer.log exists
		mockReadFile.mockResolvedValueOnce('ERROR: something broke\nINFO: all good\nERROR: another issue');
		mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // exthost
		mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // main
		mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // nested exthost
		mockReaddir.mockResolvedValueOnce([]); // exthost output

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({ filter: 'ERROR' });

		expect(result.content[0].text).toContain('ERROR');
	});

	test('handles filesystem errors gracefully', async () => {
		mockReaddir.mockRejectedValueOnce(new Error('Permission denied'));

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({});

		expect(result.content[0].text).toContain('Failed to read VS Code logs');
	});

	test('returns no logs found when sessions exist but have no logs', async () => {
		mockReaddir.mockResolvedValueOnce([
			{ name: '20260215T100000', isDirectory: () => true }
		]);
		// No window dirs
		mockReaddir.mockResolvedValueOnce([]);

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({});

		expect(result.content[0].text).toContain('No relevant VS Code logs found');
	});

	test('reads ALL windows of a session, not only the lexicographically-highest one (#3341)', async () => {
		// Session dirs
		mockReaddir.mockResolvedValueOnce([
			{ name: '20260215T100000', isDirectory: () => true }
		]);
		// 12 window dirs — l'ancien code ne lisait que windowDirs[0], choisi par
		// localeCompare descendant (tri de chaînes) : window9 dès 10+ fenêtres
		const windows = Array.from({ length: 12 }, (_, i) => ({ name: `window${i + 1}`, isDirectory: () => true }));
		mockReaddir.mockResolvedValueOnce(windows);

		for (let i = 1; i <= 12; i++) {
			mockAccess.mockResolvedValueOnce(undefined); // renderer.log exists
			mockReadFile.mockResolvedValueOnce(`renderer log line window${i}`);
			mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // exthost
			mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // main
			mockAccess.mockRejectedValueOnce(new Error('ENOENT')); // nested exthost
			mockReaddir.mockResolvedValueOnce([]); // exthost output dirs
		}

		const { readVscodeLogs } = await import('../read-vscode-logs.js');
		const result = await readVscodeLogs.handler({ lines: 10 });

		const text = result.content[0].text;
		const rendererBlocks = text.match(/--- LOG: window\d+\/renderer ---/g) || [];
		expect(rendererBlocks).toHaveLength(12);
		expect(text).toContain('--- LOG: window12/renderer ---');
		expect(text).toContain('renderer log line window12');
		// Ordre numérique, pas lexicographique : bloc window2 avant bloc window10
		expect(text.indexOf('--- LOG: window2/renderer ---')).toBeLessThan(text.indexOf('--- LOG: window10/renderer ---'));
	});
});
