/**
 * Coverage test for disk-scanner.ts — analyzeTask inner branches + TTL cache path.
 *
 * Vein D coverage sprint. The existing disk-scanner.test.ts (23 tests) covers the
 * happy paths but NEVER exercises three genuine branches (fresh measure: 84.44%
 * lines / 83.78% branches). This file covers them:
 *
 * 1. L180-182: a task directory whose ui_messages.json `fs.access` REJECTS → skipped.
 *    (Existing L195 "skip without ui_messages" test routes through existsSync at
 *     L147, never reaching the per-task `fs.access` reject inside analyzeTask.)
 * 2. L184-186: a task with a TRUTHY workspace DIFFERENT from the filter → filtered
 *    out (return null). Existing L207 workspace test sets workspace='' (falsy), so
 *     the `&& skeleton.metadata.workspace` conjunct is never truthy → branch dead.
 * 3. L129-137: the TTL cache-hit path (incl. workspace filter on cached results).
 *    Existing tests invalidate the cache each beforeEach and call once, so the
 *    `lastScanResults !== null && (now - lastScanTime) < TTL` short-circuit is
 *    never taken.
 *
 * Unowned territory (task/disk-scanner, no active lane, no open PR). Tests-only.
 *
 * @module task/__tests__/disk-scanner.coverage
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

// ---- hoisted mocks (persist across clearAllMocks) ----
const mockDetectStorageLocations = vi.fn();
const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();
const mockAccess = vi.fn();

vi.mock("../../../utils/roo-storage-detector.js", () => ({
	RooStorageDetector: {
		detectStorageLocations: mockDetectStorageLocations,
	},
}));

vi.mock("fs/promises", () => ({
	readdir: (...a: any[]) => mockReaddir(...a),
	readFile: (...a: any[]) => mockReadFile(...a),
	stat: (...a: any[]) => mockStat(...a),
	access: (...a: any[]) => mockAccess(...a),
}));

// existsSync: tasks dir exists; per-file existence is gated by fs.access in the code.
vi.mock("fs", () => ({
	existsSync: (p: string) => typeof p === "string" && p.includes("tasks"),
}));

describe("disk-scanner — analyzeTask + TTL-cache coverage", () => {
	let scanDiskForNewTasks: typeof import("../disk-scanner.js").scanDiskForNewTasks;
	let invalidate: typeof import("../disk-scanner.js").invalidateDiskScanCache;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockDetectStorageLocations.mockResolvedValue(["/mock/storage"]);
		mockReaddir.mockResolvedValue([]);
		// Unique mtime by default → forces full scan (no mtime-cache hit).
		let mt = 1_700_000_000_000;
		mockStat.mockImplementation(() => Promise.resolve({ mtimeMs: mt++ }));
		// Default: ui_messages.json readable, messages present.
		mockAccess.mockResolvedValue(undefined);
		mockReadFile.mockImplementation(async (p: string) => {
			// task_metadata.json → empty metadata (workspace falsy) unless overridden per-test.
			if (String(p).endsWith("task_metadata.json")) return "{}";
			// ui_messages.json → 2 messages.
			return JSON.stringify([
				{ text: "first", ts: 1_700_000_000_000 },
				{ text: "last", ts: 1_700_000_001_000 },
			]);
		});

		const mod = await import("../disk-scanner.js");
		scanDiskForNewTasks = mod.scanDiskForNewTasks;
		invalidate = mod.invalidateDiskScanCache;
		invalidate();
	});

	describe("analyzeTask — invalid directory branch (L180-182)", () => {
		test("skips a task directory whose ui_messages.json fs.access rejects", async () => {
			// 'bad-task' has no readable ui_messages.json → analyzeTask returns null → excluded.
			mockReaddir.mockResolvedValue(["good-task", "bad-task"]);
			mockAccess.mockImplementation((p: string) => {
				if (String(p).includes("bad-task")) return Promise.reject(new Error("ENOENT"));
				return Promise.resolve();
			});

			const result = await scanDiskForNewTasks(new Map());

			// Only good-task survives; bad-task skipped via L181 `return null`.
			expect(result.map(s => s.taskId)).toEqual(["good-task"]);
			expect(result).toHaveLength(1);
		});
	});

	describe("analyzeTask — workspace mismatch branch (L184-186)", () => {
		test("filters out a task whose truthy workspace differs from the filter", async () => {
			mockReaddir.mockResolvedValue(["ws-match", "ws-other"]);
			// ws-other carries a truthy workspace 'other-ws' in its metadata.
			mockReadFile.mockImplementation(async (p: string) => {
				if (String(p).includes("ws-other") && String(p).endsWith("task_metadata.json")) {
					return JSON.stringify({ workspace: "other-ws" });
				}
				if (String(p).endsWith("task_metadata.json")) return JSON.stringify({ workspace: "want-this" });
				return JSON.stringify([
					{ text: "first", ts: 1_700_000_000_000 },
					{ text: "last", ts: 1_700_000_001_000 },
				]);
			});

			const result = await scanDiskForNewTasks(new Map(), "want-this");

			// ws-match kept (workspace === filter); ws-other dropped via L185 `return null`.
			expect(result.map(s => s.taskId)).toEqual(["ws-match"]);
			expect(result).toHaveLength(1);
		});

		test("KEEPS a task whose workspace is empty (falsy) even under a filter", async () => {
			// Guards the conjunct: `&& skeleton.metadata.workspace` — empty workspace must NOT be filtered.
			mockReaddir.mockResolvedValue(["no-ws-task"]);
			// metadata workspace stays '' (default mockReadFile returns '{}' for metadata).

			const result = await scanDiskForNewTasks(new Map(), "want-this");

			expect(result.map(s => s.taskId)).toEqual(["no-ws-task"]);
		});
	});

	describe("TTL cache-hit path (L129-137)", () => {
		test("second call within TTL returns cached results without re-scanning", async () => {
			mockReaddir.mockResolvedValue(["cached-task"]);
			const statCalls = { n: 0 };
			// FIXED mtime so the directory looks unchanged across calls.
			mockStat.mockImplementation(() => {
				statCalls.n++;
				return Promise.resolve({ mtimeMs: 1_700_000_000_000 });
			});

			// First call: full scan → populates module cache (lastScanResults).
			const first = await scanDiskForNewTasks(new Map());
			expect(first.map(s => s.taskId)).toEqual(["cached-task"]);

			// Add cached-task to the existingCache so the second call's filter shows it's
			// reading from lastScanResults (not re-scanning).
			const cacheWithTask = new Map(first.map(s => [s.taskId, s] as const));
			const second = await scanDiskForNewTasks(cacheWithTask);

			// TTL hit (L129) → returns cached filtered against existingCache → empty.
			expect(second).toEqual([]);
		});

		test("TTL cache hit applies workspace filter to cached results (L131-135)", async () => {
			mockReaddir.mockResolvedValue(["task-a"]);
			mockReadFile.mockImplementation(async (p: string) => {
				if (String(p).endsWith("task_metadata.json")) return JSON.stringify({ workspace: "ws-a" });
				return JSON.stringify([
					{ text: "first", ts: 1_700_000_000_000 },
					{ text: "last", ts: 1_700_000_001_000 },
				]);
			});
			mockStat.mockResolvedValue({ mtimeMs: 1_700_000_000_000 });

			// First call: full scan, populates cache with task-a (workspace ws-a).
			await scanDiskForNewTasks(new Map(), "ws-a");

			// Second call within TTL, different workspace filter → cached result filtered out.
			const second = await scanDiskForNewTasks(new Map(), "ws-b");
			expect(second).toEqual([]);
		});
	});
});
