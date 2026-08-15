/**
 * Tests for raw_variants in tool_usage_stats — raw and normalized tool identity
 * kept side by side (#2336, review feedback 2026-06-22).
 *
 * @module tools/indexing/__tests__/tool-usage-stats-raw-variants
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const { mockDetectStorageLocations } = vi.hoisted(() => ({
	mockDetectStorageLocations: vi.fn(),
}));

const realHomedir = os.homedir;
let fakeHomedir: string | null = null;

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

async function createClaudeSessionFixture(
	projDir: string,
	sessionFile: string,
	entries: any[],
): Promise<void> {
	await fs.mkdir(projDir, { recursive: true });
	const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
	await fs.writeFile(path.join(projDir, sessionFile), jsonl, 'utf-8');
}

function assistantToolUse(ts: string, uses: Array<{ id: string; name: string }>): any {
	return {
		type: 'assistant',
		message: { role: 'assistant', content: uses.map((u) => ({ type: 'tool_use', id: u.id, name: u.name, input: {} })) },
		timestamp: ts,
	};
}

describe('tool_usage_stats — raw_variants side by side (#2336)', () => {
	const cache = new Map();
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const rebuildHandler = vi.fn();
	let tmpDir: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockDetectStorageLocations.mockResolvedValue([]);
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tus-rv-test-'));
		fakeHomedir = tmpDir;
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		fakeHomedir = realHomedir();
	});

	test('aggregates 3 raw variants of one tool under one key, each listed with its count', async () => {
		const projDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
		await createClaudeSessionFixture(projDir, 'session-rv-001.jsonl', [
			assistantToolUse('2026-05-20T10:00:00Z', [
				{ id: 'rv1', name: 'mcp__roo-state-manager__roosync_dashboard' },
			]),
			assistantToolUse('2026-05-20T10:01:00Z', [
				{ id: 'rv2', name: 'mcp__roo-state-manager__roosync_dashboard' },
			]),
			assistantToolUse('2026-05-20T10:02:00Z', [
				{ id: 'rv3', name: 'roosync_dashboard' },
			]),
		]);

		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
		);

		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.unique_tools).toBe(1);

		const tool = parsed.tools.find((t: any) => t.tool_name === 'roosync_dashboard');
		expect(tool).toBeDefined();
		expect(tool.calls).toBe(3);
		expect(tool.raw_variants).toHaveLength(2);
		// sorted by count desc: the mcp-prefixed variant (2 calls) first
		expect(tool.raw_variants[0]).toEqual({ raw_name: 'mcp__roo-state-manager__roosync_dashboard', calls: 2 });
		expect(tool.raw_variants[1]).toEqual({ raw_name: 'roosync_dashboard', calls: 1 });
	});

	test('lists the identical raw name when no normalization occurred', async () => {
		const projDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
		await createClaudeSessionFixture(projDir, 'session-rv-002.jsonl', [
			assistantToolUse('2026-05-20T10:00:00Z', [{ id: 'rv4', name: 'Bash' }]),
		]);

		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
		);

		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);
		const bash = parsed.tools.find((t: any) => t.tool_name === 'Bash');
		expect(bash).toBeDefined();
		expect(bash.raw_variants).toEqual([{ raw_name: 'Bash', calls: 1 }]);
	});
});
