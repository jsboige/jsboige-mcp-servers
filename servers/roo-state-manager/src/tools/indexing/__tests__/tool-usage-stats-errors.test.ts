/**
 * Tests for error_rate and retry_rate extraction in tool_usage_stats
 * Issue #549 follow-up — W1 critical gap (zero test coverage for new fields)
 *
 * @module tools/indexing/__tests__/tool-usage-stats-errors
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

/**
 * Create a temporary Claude Code project dir with a JSONL file.
 * Claude Code sessions live at ~/.claude/projects/<hash>/<uuid>.jsonl
 */
async function createClaudeSessionFixture(
	projDir: string,
	sessionFile: string,
	entries: any[],
): Promise<string> {
	const projPath = path.join(projDir);
	await fs.mkdir(projPath, { recursive: true });
	const jsonl = entries.map((e) => JSON.stringify(e)).join('\n');
	const filePath = path.join(projPath, sessionFile);
	await fs.writeFile(filePath, jsonl, 'utf-8');
	return filePath;
}

describe('tool_usage_stats — error_rate and retry_rate extraction (#549)', () => {
	const cache = new Map();
	const ensureFresh = vi.fn().mockResolvedValue(true);
	const saveSkeleton = vi.fn();
	const setEnabled = vi.fn();
	const rebuildHandler = vi.fn();
	let tmpDir: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockDetectStorageLocations.mockResolvedValue([]);
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tus-err-test-'));
		fakeHomedir = tmpDir;
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		fakeHomedir = realHomedir();
	});

	test('detects error_rate from Claude Code tool_result with is_error=true', async () => {
		// Create a Claude Code session with 1 error out of 3 Bash calls
		const projDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
		const entries = [
			// assistant: 3 tool_use for Bash
			{
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'echo ok' } },
					],
				},
				timestamp: '2026-05-20T10:00:00Z',
			},
			// user: tool_result with is_error=true
			{
				type: 'user',
				message: {
					role: 'user',
					content: [
						{ type: 'tool_result', tool_use_id: 'toolu_01', is_error: true, content: 'command failed' },
					],
				},
			},
			// assistant: 2 more Bash calls (no error)
			{
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'echo ok2' } },
					],
				},
				timestamp: '2026-05-20T10:01:00Z',
			},
			{
				type: 'user',
				message: {
					role: 'user',
					content: [
						{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'ok2' },
					],
				},
			},
			{
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'tool_use', id: 'toolu_03', name: 'Bash', input: { command: 'echo ok3' } },
					],
				},
				timestamp: '2026-05-20T10:02:00Z',
			},
			{
				type: 'user',
				message: {
					role: 'user',
					content: [
						{ type: 'tool_result', tool_use_id: 'toolu_03', content: 'ok3' },
					],
				},
			},
		];

		await createClaudeSessionFixture(projDir, 'session-001.jsonl', entries);

		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
		);

		expect(result.isError).toBe(false);
		const parsed = JSON.parse(result.content[0].text);
		const bash = parsed.tools.find((t: any) => t.tool_name === 'Bash');
		expect(bash).toBeDefined();
		expect(bash.calls).toBe(3);
		expect(bash.errors).toBe(1);
		expect(bash.error_rate).toBe(33.3);
	});

	test('detects retry_rate from consecutive same-tool calls', async () => {
		const projDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
		// 4 Edit calls: 3 consecutive retries (same tool repeated)
		const entries = [
			{
				type: 'assistant',
				message: { role: 'assistant', content: [
					{ type: 'tool_use', id: 'toolu_10', name: 'Edit', input: {} },
				] },
				timestamp: '2026-05-20T11:00:00Z',
			},
			{ type: 'user', message: { role: 'user', content: [
				{ type: 'tool_result', tool_use_id: 'toolu_10', content: 'ok' },
			] } },
			// 3 consecutive Edit calls = 3 retries
			{
				type: 'assistant',
				message: { role: 'assistant', content: [
					{ type: 'tool_use', id: 'toolu_11', name: 'Edit', input: {} },
				] },
				timestamp: '2026-05-20T11:01:00Z',
			},
			{ type: 'user', message: { role: 'user', content: [
				{ type: 'tool_result', tool_use_id: 'toolu_11', content: 'ok' },
			] } },
			{
				type: 'assistant',
				message: { role: 'assistant', content: [
					{ type: 'tool_use', id: 'toolu_12', name: 'Edit', input: {} },
				] },
				timestamp: '2026-05-20T11:02:00Z',
			},
			{ type: 'user', message: { role: 'user', content: [
				{ type: 'tool_result', tool_use_id: 'toolu_12', content: 'ok' },
			] } },
			// Intervening different tool resets retry counter
			{
				type: 'assistant',
				message: { role: 'assistant', content: [
					{ type: 'tool_use', id: 'toolu_13', name: 'Read', input: {} },
				] },
				timestamp: '2026-05-20T11:03:00Z',
			},
			{ type: 'user', message: { role: 'user', content: [
				{ type: 'tool_result', tool_use_id: 'toolu_13', content: 'ok' },
			] } },
			// Edit again — not a retry because Read was in between
			{
				type: 'assistant',
				message: { role: 'assistant', content: [
					{ type: 'tool_use', id: 'toolu_14', name: 'Edit', input: {} },
				] },
				timestamp: '2026-05-20T11:04:00Z',
			},
			{ type: 'user', message: { role: 'user', content: [
				{ type: 'tool_result', tool_use_id: 'toolu_14', content: 'ok' },
			] } },
		];

		await createClaudeSessionFixture(projDir, 'session-002.jsonl', entries);

		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
		);

		const parsed = JSON.parse(result.content[0].text);
		const edit = parsed.tools.find((t: any) => t.tool_name === 'Edit');
		expect(edit).toBeDefined();
		expect(edit.calls).toBe(4);
		// Edit→Edit→Edit (2 retries between 3 consecutive) + Read intervenes → last Edit not retry
		expect(edit.retries).toBe(2);
		expect(edit.retry_rate).toBe(50.0); // 2/4 * 100
	});

	test('returns 0 error_rate and retry_rate when no errors or retries', async () => {
		const projDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
		const entries = [
			{
				type: 'assistant',
				message: { role: 'assistant', content: [
					{ type: 'tool_use', id: 'toolu_20', name: 'Read', input: {} },
				] },
				timestamp: '2026-05-20T12:00:00Z',
			},
			{ type: 'user', message: { role: 'user', content: [
				{ type: 'tool_result', tool_use_id: 'toolu_20', content: 'file content' },
			] } },
		];

		await createClaudeSessionFixture(projDir, 'session-003.jsonl', entries);

		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
		);

		const parsed = JSON.parse(result.content[0].text);
		const read = parsed.tools.find((t: any) => t.tool_name === 'Read');
		expect(read).toBeDefined();
		expect(read.errors).toBe(0);
		expect(read.error_rate).toBe(0);
		expect(read.retries).toBe(0);
		expect(read.retry_rate).toBe(0);
	});

	test('error_rate includes both is_error and toolResult.is_error formats', async () => {
		const projDir = path.join(tmpDir, '.claude', 'projects', 'test-project');
		const entries = [
			// Format 1: is_error at top level
			{
				type: 'assistant',
				message: { role: 'assistant', content: [
					{ type: 'tool_use', id: 'toolu_30', name: 'Bash', input: {} },
				] },
				timestamp: '2026-05-20T13:00:00Z',
			},
			{ type: 'user', message: { role: 'user', content: [
				{ type: 'tool_result', tool_use_id: 'toolu_30', is_error: true, content: 'fail1' },
			] } },
			// Format 2: toolResult.is_error (Claude Code format)
			{
				type: 'assistant',
				message: { role: 'assistant', content: [
					{ type: 'tool_use', id: 'toolu_31', name: 'Bash', input: {} },
				] },
				timestamp: '2026-05-20T13:01:00Z',
			},
			{ type: 'user', message: { role: 'user', content: [
				{ type: 'tool_result', tool_use_id: 'toolu_31', toolResult: { is_error: true }, content: 'fail2' },
			] } },
		];

		await createClaudeSessionFixture(projDir, 'session-004.jsonl', entries);

		const result = await handleRooSyncIndexing(
			{ action: 'tool_usage_stats', start_date: '2026-05-19', end_date: '2026-05-21' },
			cache, ensureFresh, saveSkeleton, new Set(), setEnabled, rebuildHandler,
		);

		const parsed = JSON.parse(result.content[0].text);
		const bash = parsed.tools.find((t: any) => t.tool_name === 'Bash');
		expect(bash).toBeDefined();
		expect(bash.calls).toBe(2);
		expect(bash.errors).toBe(2);
		expect(bash.error_rate).toBe(100.0);
	});
});
