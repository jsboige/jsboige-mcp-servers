/**
 * Tests for #4691: tool_usage_stats flags calls to a tool that does not exist
 * on this server — raw names under the `mcp__roo-state-manager__` prefix whose
 * tool part is absent from allToolDefinitions.
 *
 * @module tools/indexing/__tests__/tool-usage-stats-unknown-server-tools
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

describe('tool_usage_stats — unknown tools under the server prefix (#4691)', () => {
	const cache = new Map();
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const rebuildHandler = vi.fn();
	let tmpDir: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockDetectStorageLocations.mockResolvedValue([]);
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tus-ust-test-'));
		fakeHomedir = tmpDir;
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		fakeHomedir = realHomedir();
	});

	test('lists the call to a non-existent server tool; an existing tool is not flagged', async () => {
		const projDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
		await createClaudeSessionFixture(projDir, 'session-ust-001.jsonl', [
			assistantToolUse('2026-05-20T10:00:00Z', [
				{ id: 'ust1', name: 'mcp__roo-state-manager__CronList' },
			]),
			assistantToolUse('2026-05-20T10:01:00Z', [
				{ id: 'ust2', name: 'mcp__roo-state-manager__conversation_browser' },
			]),
		]);

		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
		);

		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);

		// CronList does not exist on this server: flagged, with raw name and count.
		expect(parsed.unknown_server_tools).toEqual([
			{ raw_name: 'mcp__roo-state-manager__CronList', calls: 1 },
		]);
		expect(parsed.unknown_server_tools_total).toBe(1);

		// conversation_browser exists: never flagged.
		expect(
			parsed.unknown_server_tools.some((t: any) => t.raw_name.includes('conversation_browser')),
		).toBe(false);

		// Counting itself is unchanged: both calls still land in the totals,
		// and the unknown one still folds into the (built-in-looking) key.
		expect(parsed.total_tool_calls).toBe(2);
		const cronList = parsed.tools.find((t: any) => t.tool_name === 'CronList');
		expect(cronList?.calls).toBe(1);
	});

	test('empty dedicated section and zero total when every prefixed call resolves', async () => {
		const projDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
		await createClaudeSessionFixture(projDir, 'session-ust-002.jsonl', [
			assistantToolUse('2026-05-20T10:00:00Z', [
				{ id: 'ust3', name: 'mcp__roo-state-manager__conversation_browser' },
			]),
		]);

		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
		);

		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.unknown_server_tools).toEqual([]);
		expect(parsed.unknown_server_tools_total).toBe(0);
	});
});
