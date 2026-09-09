/**
 * Tests for the incremental per-file cache in tool_usage_stats (#753 Bug 2).
 *
 * @module tools/indexing/__tests__/tool-usage-cache
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const { mockDetectStorageLocations } = vi.hoisted(() => ({
	mockDetectStorageLocations: vi.fn(),
}));

const realHomedir = os.homedir;
let fakeHomedir: string;
let cacheDir: string;

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

async function writeSession(dir: string, file: string, entries: any[]): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
	const fp = path.join(dir, file);
	await fs.writeFile(fp, jsonl, 'utf-8');
	return fp;
}

function assistantToolUse(ts: string, uses: Array<{ id: string; name: string }>): any {
	return {
		type: 'assistant',
		message: {
			role: 'assistant',
			content: uses.map((u) => ({ type: 'tool_use', id: u.id, name: u.name, input: {} })),
		},
		timestamp: ts,
	};
}

function userResult(toolUseId: string, isError = false): any {
	return {
		type: 'user',
		message: {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: isError ? 'fail' : 'ok' }],
		},
	};
}

describe('tool_usage_stats — incremental cache (#753 Bug 2)', () => {
	const cache = new Map();
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const rebuildHandler = vi.fn();
	let projDir: string;
	let baseDir: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockDetectStorageLocations.mockResolvedValue([]);
		baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tus-cache-test-'));
		fakeHomedir = baseDir;
		cacheDir = path.join(baseDir, 'cache');
		process.env.ROOSYNC_TOOL_USAGE_CACHE_DIR = cacheDir;
		projDir = path.join(baseDir, '.claude', 'projects', 'proj');
	});

	afterEach(async () => {
		delete process.env.ROOSYNC_TOOL_USAGE_CACHE_DIR;
		await fs.rm(baseDir, { recursive: true, force: true });
		fakeHomedir = realHomedir();
	});

	const call = (args: any) =>
		handleRooSyncIndexing(args, cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler);

	const cacheFilePath = () => path.join(cacheDir, `tool-usage-cache-${os.hostname()}.json`);

	test('second scan of unchanged files hits the cache with identical aggregates', async () => {
		await writeSession(projDir, 's1.jsonl', [
			assistantToolUse('2026-05-20T10:00:00Z', [{ id: 'a1', name: 'Bash' }]),
			userResult('a1'),
			assistantToolUse('2026-05-20T10:01:00Z', [{ id: 'a2', name: 'Bash' }]),
			userResult('a2', true),
		]);
		const args = { action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' };

		const first = JSON.parse((await call(args)).content[0].text);
		expect(first.cache_misses).toBe(1);
		expect(first.cache_hits).toBe(0);
		expect(first.total_tool_calls).toBe(2);
		expect(first.tools.find((t: any) => t.tool_name === 'Bash').errors).toBe(1);
		// Cache file persisted on the first (miss) scan
		await fs.access(cacheFilePath());

		const second = JSON.parse((await call(args)).content[0].text);
		expect(second.cache_hits).toBe(1);
		expect(second.cache_misses).toBe(0);
		expect(second.total_tool_calls).toBe(2);
		expect(second.tools).toEqual(first.tools);
		expect(second.weekly_trend).toEqual(first.weekly_trend);
		expect(second.source_distribution).toEqual(first.source_distribution);
	});

	test('modified file (mtime/size change) is re-parsed', async () => {
		const fp = await writeSession(projDir, 's2.jsonl', [
			assistantToolUse('2026-05-20T10:00:00Z', [{ id: 'b1', name: 'Edit' }]),
			userResult('b1'),
		]);
		const args = { action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' };
		const first = JSON.parse((await call(args)).content[0].text);
		expect(first.total_tool_calls).toBe(1);

		await fs.appendFile(fp, '\n' + JSON.stringify(assistantToolUse('2026-05-20T10:05:00Z', [{ id: 'b2', name: 'Read' }])), 'utf-8');
		const second = JSON.parse((await call(args)).content[0].text);
		expect(second.cache_misses).toBe(1);
		expect(second.cache_hits).toBe(0);
		expect(second.total_tool_calls).toBe(2);
	});

	test('re-filters an arbitrary sub-range from cached per-day buckets without re-parse', async () => {
		await writeSession(projDir, 's4.jsonl', [
			assistantToolUse('2026-05-10T10:00:00Z', [{ id: 'e1', name: 'Bash' }]),
			assistantToolUse('2026-05-20T10:00:00Z', [{ id: 'e2', name: 'Edit' }]),
		]);
		// Wide scan caches both days.
		await call({ action: 'tool_usage_stats', start_date: '2026-05-01', end_date: '2026-05-31' });
		// Narrow scan re-uses the cache and keeps only the in-window day.
		const narrow = JSON.parse(
			(await call({ action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' })).content[0].text,
		);
		expect(narrow.cache_hits).toBe(1);
		expect(narrow.cache_misses).toBe(0);
		expect(narrow.total_tool_calls).toBe(1);
		expect(narrow.tools[0].tool_name).toBe('Edit');
	});

	test('cache file with a mismatched version is ignored (full rescan)', async () => {
		await writeSession(projDir, 's3.jsonl', [
			assistantToolUse('2026-05-20T10:00:00Z', [{ id: 'c1', name: 'Bash' }]),
		]);
		const args = { action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' };
		const first = JSON.parse((await call(args)).content[0].text);
		expect(first.cache_misses).toBe(1);

		// Corrupt the version on disk → the next call must not trust it.
		const cacheFile = cacheFilePath();
		const raw = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
		raw.version = 1;
		await fs.writeFile(cacheFile, JSON.stringify(raw), 'utf-8');

		const second = JSON.parse((await call(args)).content[0].text);
		expect(second.cache_misses).toBe(1);
		expect(second.cache_hits).toBe(0);
		expect(second.total_tool_calls).toBe(1);
	});

	test('removed file is garbage-collected from the on-disk cache when other files remain', async () => {
		const g1 = await writeSession(projDir, 'g1.jsonl', [
			assistantToolUse('2026-05-20T10:00:00Z', [{ id: 'd1', name: 'Bash' }]),
		]);
		await writeSession(projDir, 'g2.jsonl', [
			assistantToolUse('2026-05-20T10:00:00Z', [{ id: 'd2', name: 'Edit' }]),
		]);
		const args = { action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' };
		await call(args); // populate both

		await fs.rm(g1, { force: true });
		const second = JSON.parse((await call(args)).content[0].text);
		// g1 removed → only g2 discovered → GC drops g1's entry.
		expect(second.cache_hits).toBe(1);
		expect(second.cache_misses).toBe(0);

		const cached = JSON.parse(await fs.readFile(cacheFilePath(), 'utf-8'));
		expect(Object.keys(cached.files)).toEqual([path.join(projDir, 'g2.jsonl')]);
	});

	test('Roo storage files also flow through the cache', async () => {
		// Point the Roo detector at a temp tasks dir with one api_conversation_history.json.
		const rooBase = path.join(baseDir, 'roo-storage');
		const taskDir = path.join(rooBase, 'tasks', 'task-1');
		await fs.mkdir(taskDir, { recursive: true });
		await fs.writeFile(
			path.join(taskDir, 'api_conversation_history.json'),
			JSON.stringify([
				{ role: 'assistant', ts: '2026-05-20T09:00:00Z', content: [{ type: 'tool_use', id: 'r1', name: 'Bash', input: {} }] },
				{ role: 'user', ts: '2026-05-20T09:01:00Z', content: [{ type: 'tool_result', tool_use_id: 'r1', is_error: true, content: 'fail' }] },
			]),
			'utf-8',
		);
		mockDetectStorageLocations.mockResolvedValue([rooBase]);
		const args = { action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' };

		const first = JSON.parse((await call(args)).content[0].text);
		expect(first.cache_misses).toBe(1);
		expect(first.total_tool_calls).toBe(1);
		expect(first.source_distribution).toEqual({ roo: 1 });

		const second = JSON.parse((await call(args)).content[0].text);
		expect(second.cache_hits).toBe(1);
		expect(second.cache_misses).toBe(0);
		expect(second.total_tool_calls).toBe(1);
	});

	test('readable cache with right versions but malformed entry shape is rejected — no absorbing failure (review ai-01 2026-09-07)', async () => {
		await writeSession(projDir, 'm1.jsonl', [
			assistantToolUse('2026-05-20T10:00:00Z', [{ id: 'm1', name: 'Bash' }]),
		]);
		const args = { action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' };
		await call(args); // populate

		// Corrupt ONLY the entry shape: version + normalizer_version stay valid, perDay becomes null.
		// This is the case the version checks cannot see: the cache-hit path would throw
		// Object.entries(null) on every call with no rewrite (absorbing state) before the fix.
		const cacheFile = cacheFilePath();
		const raw = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
		const firstPath = Object.keys(raw.files)[0];
		raw.files[firstPath].perDay = null;
		await fs.writeFile(cacheFile, JSON.stringify(raw), 'utf-8');

		const second = JSON.parse((await call(args)).content[0].text);
		expect(second.isError).toBeUndefined();
		expect(second.cache_misses).toBe(1);
		expect(second.cache_hits).toBe(0);
		expect(second.total_tool_calls).toBe(1);

		// The rejected file was rewritten well-formed: the NEXT call hits the cache again.
		const third = JSON.parse((await call(args)).content[0].text);
		expect(third.cache_hits).toBe(1);
		expect(third.cache_misses).toBe(0);
		expect(third.total_tool_calls).toBe(1);
	});

	test('end_date is inclusive of the whole end day — documented semantics (#753 review)', async () => {
		// Pre-#753 the filter compared timestamps against a midnight-UTC endDate, so a call
		// at 18:00 on the end day was EXCLUDED. Day-key comparison counts the whole day.
		await writeSession(projDir, 'w1.jsonl', [
			assistantToolUse('2026-05-21T18:00:00Z', [{ id: 'w1', name: 'Bash' }]),
		]);
		const res = JSON.parse(
			(await call({ action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' })).content[0].text,
		);
		expect(res.total_tool_calls).toBe(1);
		expect(res.tools.find((t: any) => t.tool_name === 'Bash').calls).toBe(1);
	});
});
