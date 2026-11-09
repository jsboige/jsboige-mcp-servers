/**
 * #2307 (Utility rising) — window consistency of error_rate / retry_rate.
 *
 * Measured defect (web2, 09/11): a windowed query divided WHOLE-FILE error totals
 * by WINDOWED call counts — PowerShell 104.5% (393 whole-file errors / 376 windowed
 * calls), CronCreate retry_rate 200%. po-2023 named it first (errors counted per
 * line, not per call); the mechanism is file-level error/retry storage meeting a
 * day-filtered denominator.
 *
 * Fix under test: errors and retries are attributed to the day of their own line
 * (result line for an error, retrying call for a retry) and ride the same window
 * as calls; a tool_result re-emitted for an already-counted tool_use_id counts once.
 *
 * @module tools/indexing/__tests__/tool-usage-stats-window-consistency
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const { mockDetectStorageLocations } = vi.hoisted(() => ({
	mockDetectStorageLocations: vi.fn(),
}));

const realHomedir = os.homedir;
let fakeHomedir: string;

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: {
		findConversationById: vi.fn(),
		detectStorageLocations: mockDetectStorageLocations,
	},
}));

vi.mock('../index-task.tool.js', () => ({
	indexTaskSemanticTool: { handler: vi.fn() },
}));

vi.mock('../reset-collection.tool.js', () => ({
	resetQdrantCollectionTool: { handler: vi.fn() },
}));

vi.mock('../diagnose-index.tool.js', () => ({
	handleDiagnoseSemanticIndex: vi.fn(),
}));

vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof os>();
	return {
		...actual,
		homedir: () => fakeHomedir ?? realHomedir(),
	};
});

import { handleRooSyncIndexing } from '../roosync-indexing.tool.js';

/** One PowerShell-style call round-trip on a given day. */
function claudeRoundTrip(id: string, day: string, isError: boolean): any[] {
	return [
		{
			type: 'assistant',
			message: { role: 'assistant', content: [
				{ type: 'tool_use', id, name: 'PowerShell', input: { command: 'ls' } },
			] },
			timestamp: `${day}T10:00:00Z`,
		},
		{
			type: 'user',
			message: { role: 'user', content: [
				{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'out' },
			] },
			timestamp: `${day}T10:00:05Z`,
		},
	];
}

describe('tool_usage_stats — error/retry window consistency (#2307)', () => {
	const cache = new Map();
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const rebuildHandler = vi.fn();
	let tmpDir: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockDetectStorageLocations.mockResolvedValue([]);
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tus-wc-test-'));
		fakeHomedir = tmpDir;
		// Cache isolation: v3 shape must not leak between tests of this file.
		process.env.ROOSYNC_TOOL_USAGE_CACHE_DIR = tmpDir;
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		fakeHomedir = realHomedir();
		delete process.env.ROOSYNC_TOOL_USAGE_CACHE_DIR;
	});

	async function runStats(start: string, end: string) {
		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', start_date: start, end_date: end },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
		);
		expect(result.isError).toBe(false);
		return JSON.parse(result.content[0].text);
	}

	test('errors outside the window no longer inflate the rate (the PowerShell 104.5% case)', async () => {
		// Day A (before window): 30 calls, ALL errored. Day B (window): 30 calls, 3 errored.
		const entries: any[] = [];
		for (let i = 0; i < 30; i++) entries.push(...claudeRoundTrip(`toolu_a${i}`, '2026-11-01', true));
		for (let i = 0; i < 30; i++) entries.push(...claudeRoundTrip(`toolu_b${i}`, '2026-11-05', i < 3));

		const projDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
		await fs.mkdir(projDir, { recursive: true });
		await fs.writeFile(path.join(projDir, 's1.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'), 'utf-8');

		const parsed = await runStats('2026-11-04', '2026-11-06');
		const ps = parsed.tools.find((t: any) => t.tool_name === 'PowerShell');
		expect(ps).toBeDefined();
		expect(ps.calls).toBe(30);
		// Pre-fix: errors = 33 (whole file) → 110%. Post-fix: only the 3 in-window errors.
		expect(ps.errors).toBe(3);
		expect(ps.error_rate).toBe(10);
	});

	test('retry outside the window is not counted in a windowed retry_rate', async () => {
		// Day A: errored call + immediate same-tool retry (the retry pair). Day B: clean calls.
		const dayA = [
			...claudeRoundTrip('toolu_r1', '2026-11-01', true),
			{
				type: 'assistant',
				message: { role: 'assistant', content: [
					{ type: 'tool_use', id: 'toolu_r2', name: 'PowerShell', input: { command: 'ls' } },
				] },
				timestamp: '2026-11-01T11:00:00Z',
			},
			{
				type: 'user',
				message: { role: 'user', content: [
					{ type: 'tool_result', tool_use_id: 'toolu_r2', content: 'ok' },
				] },
				timestamp: '2026-11-01T11:00:05Z',
			},
		];
		const dayB: any[] = [];
		for (let i = 0; i < 40; i++) dayB.push(...claudeRoundTrip(`toolu_c${i}`, '2026-11-05', false));

		const projDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
		await fs.mkdir(projDir, { recursive: true });
		await fs.writeFile(path.join(projDir, 's2.jsonl'), [...dayA, ...dayB].map((e) => JSON.stringify(e)).join('\n'), 'utf-8');

		const parsed = await runStats('2026-11-04', '2026-11-06');
		const ps = parsed.tools.find((t: any) => t.tool_name === 'PowerShell');
		// The retry pair happened on 2026-11-01 — outside the window. Pre-fix: 1/40 = 2.5%.
		expect(ps.retries).toBe(0);
		expect(ps.retry_rate).toBe(0);
	});

	test('a duplicate error tool_result for the same tool_use_id counts once', async () => {
		// 30 clean calls + 1 errored call whose result line is emitted TWICE (re-emission).
		const entries: any[] = [];
		for (let i = 0; i < 30; i++) entries.push(...claudeRoundTrip(`toolu_d${i}`, '2026-11-05', false));
		entries.push({
			type: 'assistant',
			message: { role: 'assistant', content: [
				{ type: 'tool_use', id: 'toolu_dup', name: 'PowerShell', input: { command: 'ls' } },
			] },
			timestamp: '2026-11-05T12:00:00Z',
		});
		const errResult = (ts: string) => ({
			type: 'user',
			message: { role: 'user', content: [
				{ type: 'tool_result', tool_use_id: 'toolu_dup', is_error: true, content: 'boom' },
			] },
			timestamp: ts,
		});
		entries.push(errResult('2026-11-05T12:00:05Z'));
		entries.push(errResult('2026-11-05T12:00:05Z'));

		const projDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
		await fs.mkdir(projDir, { recursive: true });
		await fs.writeFile(path.join(projDir, 's3.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'), 'utf-8');

		const parsed = await runStats('2026-11-04', '2026-11-06');
		const ps = parsed.tools.find((t: any) => t.tool_name === 'PowerShell');
		expect(ps.calls).toBe(31);
		// Pre-fix: 2 error lines → errors=2. One call, one error.
		expect(ps.errors).toBe(1);
	});

	test('untimed error results stay counted in any window (NO_TS_DAY is never filtered)', async () => {
		const entries: any[] = [];
		for (let i = 0; i < 30; i++) entries.push(...claudeRoundTrip(`toolu_u${i}`, '2026-11-05', false));
		// Errored call whose result line carries NO timestamp.
		entries.push({
			type: 'assistant',
			message: { role: 'assistant', content: [
				{ type: 'tool_use', id: 'toolu_uts', name: 'PowerShell', input: { command: 'ls' } },
			] },
			timestamp: '2026-11-05T13:00:00Z',
		});
		entries.push({
			type: 'user',
			message: { role: 'user', content: [
				{ type: 'tool_result', tool_use_id: 'toolu_uts', is_error: true, content: 'boom' },
			] },
		});

		const projDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
		await fs.mkdir(projDir, { recursive: true });
		await fs.writeFile(path.join(projDir, 's4.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'), 'utf-8');

		const parsed = await runStats('2026-11-04', '2026-11-06');
		const ps = parsed.tools.find((t: any) => t.tool_name === 'PowerShell');
		expect(ps.errors).toBe(1);
	});

	test('Roo scanner: errors ride the window too (api_conversation_history.json)', async () => {
		// Same shape as the Claude test, through the Roo path: day A errored calls,
		// day B clean calls, window = day B only.
		const messages: any[] = [];
		for (let i = 0; i < 30; i++) {
			messages.push({ role: 'assistant', ts: `2026-11-01T10:${String(i % 60).padStart(2, '0')}:00.000Z`, content: [
				{ type: 'tool_use', id: `roo_a${i}`, name: 'PowerShell', input: { command: 'ls' } },
			] });
			messages.push({ role: 'user', ts: `2026-11-01T10:${String(i % 60).padStart(2, '0')}:01.000Z`, content: [
				{ type: 'tool_result', tool_use_id: `roo_a${i}`, is_error: true },
			] });
		}
		for (let i = 0; i < 30; i++) {
			messages.push({ role: 'assistant', ts: `2026-11-05T11:${String(i % 60).padStart(2, '0')}:00.000Z`, content: [
				{ type: 'tool_use', id: `roo_b${i}`, name: 'PowerShell', input: { command: 'ls' } },
			] });
			messages.push({ role: 'user', ts: `2026-11-05T11:${String(i % 60).padStart(2, '0')}:01.000Z`, content: [
				{ type: 'tool_result', tool_use_id: `roo_b${i}`, is_error: i < 3 },
			] });
		}
		const rooRoot = path.join(tmpDir, 'roo-tasks');
		await fs.mkdir(path.join(rooRoot, 'tasks', 'task-1'), { recursive: true });
		await fs.writeFile(path.join(rooRoot, 'tasks', 'task-1', 'api_conversation_history.json'), JSON.stringify(messages), 'utf-8');
		mockDetectStorageLocations.mockResolvedValue([rooRoot]);

		const parsed = await runStats('2026-11-04', '2026-11-06');
		const ps = parsed.tools.find((t: any) => t.tool_name === 'PowerShell');
		expect(ps.calls).toBe(30);
		// Pre-fix: 33 whole-file errors over 30 windowed calls = 110%.
		expect(ps.errors).toBe(3);
		expect(ps.error_rate).toBe(10);
	});
});
