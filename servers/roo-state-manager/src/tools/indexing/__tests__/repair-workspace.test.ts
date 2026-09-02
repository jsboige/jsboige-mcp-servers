/**
 * #3344: repair_workspace — backfill of workspace_name / workspace on existing points.
 *
 * Covers the three repair paths:
 *  - derivation cohort (workspace present, name missing) → setPayload workspace_name;
 *  - claude-* task_id resolved via local Claude storage (JSONL cwd);
 *  - roo task_id resolved via local Roo storage (task_metadata.json workspace);
 * plus dry_run (no writes) and the unresolved report (by source / machine).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

const { mockQdrant, state } = vi.hoisted(() => ({
	mockQdrant: { scroll: vi.fn(), setPayload: vi.fn() },
	state: {
		claudeLocations: [] as { projectPath: string }[],
		rooLocations: [] as string[],
	},
}));

vi.mock('../../../services/qdrant.js', () => ({
	getQdrantClient: () => mockQdrant,
}));

vi.mock('../../../utils/claude-storage-detector.js', () => ({
	ClaudeStorageDetector: { detectStorageLocations: vi.fn(async () => state.claudeLocations) },
}));

vi.mock('../../../utils/roo-storage-detector.js', () => ({
	RooStorageDetector: { detectStorageLocations: vi.fn(async () => state.rooLocations) },
}));

import { handleRepairWorkspace } from '../repair-workspace.js';

let tmpDir: string;

const POINTS = [
	// derivation cohort: workspace present, name missing (3.5% of the ai-01 sample)
	{ id: 'pA', payload: { workspace: 'd:/dev/CoursIA-2', source: 'roo', host_os: 'm1' } },
	// neither field, claude-* task_id resolvable locally via JSONL cwd
	{ id: 'pB', payload: { task_id: 'claude-MyProj--sess-uuid-1', source: 'claude-code', host_os: 'm1' } },
	// neither field, roo task_id resolvable locally via task_metadata.json
	{ id: 'pC', payload: { task_id: 'roo-task-x', source: 'roo', host_os: 'm1' } },
	// neither field, no task_id → unrepairable, reported by source + machine
	{ id: 'pD', payload: { source: 'claude-code', host_os: 'm2' } },
];

beforeAll(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rsm-3344-repair-'));

	// Claude fixture: project dir containing the session JSONL with a cwd first line
	const claudeProj = path.join(tmpDir, 'MyProj');
	await fs.mkdir(claudeProj, { recursive: true });
	await fs.writeFile(
		path.join(claudeProj, 'sess-uuid-1.jsonl'),
		JSON.stringify({ type: 'user', cwd: 'D:\\dev\\CoursIA-2', message: { role: 'user', content: 'x' } }) + '\n',
		'utf-8'
	);
	state.claudeLocations = [{ projectPath: claudeProj }];

	// Roo fixture: tasks/roo-task-x/task_metadata.json with a workspace
	const rooRoot = path.join(tmpDir, 'roo-global-storage');
	await fs.mkdir(path.join(rooRoot, 'tasks', 'roo-task-x'), { recursive: true });
	await fs.writeFile(
		path.join(rooRoot, 'tasks', 'roo-task-x', 'task_metadata.json'),
		JSON.stringify({ workspace: 'd:/dev/Foo' }),
		'utf-8'
	);
	state.rooLocations = [rooRoot];
});

afterAll(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function setupScroll(pages: any[][]): void {
	mockQdrant.scroll.mockReset();
	mockQdrant.setPayload.mockReset();
	// Call 1 = is_empty probe (limit 1); subsequent calls return fixture pages.
	let call = 0;
	mockQdrant.scroll.mockImplementation(async () => {
		call++;
		if (call === 1) return { points: [] }; // probe OK → server_filter mode
		const page = pages[call - 2];
		return page ? { points: page } : { points: [] };
	});
}

describe('handleRepairWorkspace (#3344)', () => {
	it('repairs all three cohorts and reports the unresolved one', async () => {
		setupScroll([POINTS]);

		const result = await handleRepairWorkspace({});
		const parsed = JSON.parse(result.content[0].text);

		expect(result.isError).toBe(false);
		expect(parsed.action).toBe('repair_workspace');
		expect(parsed.dry_run).toBe(false);
		expect(parsed.findings.missing_workspace_name).toBe(4);
		expect(parsed.findings.with_workspace_only).toBe(1);
		expect(parsed.findings.with_neither).toBe(3);

		expect(parsed.repairs.from_workspace_derivation).toBe(1);
		expect(parsed.repairs.from_local_lookup).toBe(2);
		expect(parsed.repairs.applied_points).toBe(3);

		// Three distinct payload shapes written
		expect(mockQdrant.setPayload).toHaveBeenCalledTimes(3);
		const payloads = mockQdrant.setPayload.mock.calls.map((c: any[]) => c[1]);
		expect(payloads).toContainEqual(expect.objectContaining({ payload: { workspace_name: 'CoursIA-2' }, points: ['pA'] }));
		expect(payloads).toContainEqual(expect.objectContaining({
			payload: { workspace: 'D:\\dev\\CoursIA-2', workspace_name: 'CoursIA-2' },
			points: ['pB'],
		}));
		expect(payloads).toContainEqual(expect.objectContaining({
			payload: { workspace: 'd:/dev/Foo', workspace_name: 'Foo' },
			points: ['pC'],
		}));

		// Unresolved point reported by source and machine — the lane needing a re-index
		expect(parsed.unresolved.total).toBe(1);
		expect(parsed.unresolved.by_source['claude-code'].total).toBe(1);
		expect(parsed.unresolved.by_machine.m2.total).toBe(1);
	});

	it('dry_run reports would-be repairs without writing', async () => {
		setupScroll([POINTS]);

		const result = await handleRepairWorkspace({ dryRun: true });
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.dry_run).toBe(true);
		expect(parsed.repairs.would_apply_points).toBe(3);
		expect(parsed.repairs.applied_points).toBe(0);
		expect(mockQdrant.setPayload).not.toHaveBeenCalled();
	});

	it('points already carrying workspace_name are left untouched', async () => {
		setupScroll([[{ id: 'pOK', payload: { workspace: 'd:/dev/W', workspace_name: 'W', source: 'roo' } }]]);

		const result = await handleRepairWorkspace({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.findings.missing_workspace_name).toBe(0);
		expect(parsed.repairs.applied_points).toBe(0);
		expect(mockQdrant.setPayload).not.toHaveBeenCalled();
	});

	it('falls back to client_scan when the is_empty filter is rejected', async () => {
		mockQdrant.scroll.mockReset();
		mockQdrant.setPayload.mockReset();
		let call = 0;
		mockQdrant.scroll.mockImplementation(async (collection: string, opts: any) => {
			call++;
			if (call === 1 && opts?.filter) throw new Error('unknown filter condition is_empty');
			if (opts?.filter) throw new Error('unknown filter condition is_empty');
			return { points: call === 2 ? [POINTS[0]] : [] };
		});

		const result = await handleRepairWorkspace({});
		const parsed = JSON.parse(result.content[0].text);

		expect(parsed.filter_mode).toBe('client_scan');
		expect(parsed.repairs.applied_points).toBe(1);
		expect(mockQdrant.setPayload).toHaveBeenCalledTimes(1);
	});

	it('probe filter uses IsEmptyCondition with `key` (regression: `field` is a Qdrant 400)', async () => {
		mockQdrant.scroll.mockReset();
		mockQdrant.setPayload.mockReset();
		let probeOpts: any = null;
		let call = 0;
		mockQdrant.scroll.mockImplementation(async (collection: string, opts: any) => {
			call++;
			if (call === 1) {
				probeOpts = opts;
				return { points: [] }; // probe OK → server_filter mode
			}
			return { points: [] };
		});

		await handleRepairWorkspace({});

		// The probe scroll must carry a server-side filter so the repair covers the
		// WHOLE collection (missing points only) instead of the first ~20k points.
		expect(probeOpts).not.toBeNull();
		expect(probeOpts.filter).toEqual({ must: [{ is_empty: { key: 'workspace_name' } }] });
	});

	it('surfaces scroll failures as a structured error instead of throwing', async () => {
		mockQdrant.scroll.mockReset();
		mockQdrant.setPayload.mockReset();
		mockQdrant.scroll.mockRejectedValue(new Error('connect ECONNREFUSED'));

		const result = await handleRepairWorkspace({});
		const parsed = JSON.parse(result.content[0].text);

		expect(result.isError).toBe(true);
		expect(parsed.status).toBe('error');
		expect(parsed.message).toContain('ECONNREFUSED');
	});
});
