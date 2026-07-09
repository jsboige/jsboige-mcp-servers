/**
 * Coverage test for build-skeleton-cache.tool.ts — multi-tier #1244 Couche 1.4.
 *
 * Lane S (po-2026) of ai-01 [DISPATCH] Vein D (coverage, 72h). Pattern C3: 1 file = 1 PR.
 *
 * The existing build-skeleton-cache.test.ts (35 tests) covers the Roo-only
 * happy/invalidation paths but NEVER exercises the multi-tier loading
 * introduced by #1244 (Tier 2 Claude sessions, Tier 3 GDrive archives, the
 * `reindex` force-enqueue, and the per-tier response format). These branches
 * are ~150 LOC of genuinely uncovered code (fresh measure: 51% lines / 70%
 * branches). This file covers them.
 *
 * Anchored on real source contract: build-skeleton-cache.tool.ts @ 92e8af62.
 *
 * @module tools/cache/__tests__/build-skeleton-cache.coverage
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { handleBuildSkeletonCache } from "../build-skeleton-cache.tool.js";
import type { ConversationSkeleton } from "../../../types/conversation.js";

// ---- hoisted mocks ----
const {
	mockReaddir, mockStat, mockReadFile, mockWriteFile, mockMkdir, mockExistsSync,
	mockDetectStorageLocations, mockDetectWorkspaceForTask, mockAnalyzeConversation,
	mockClaudeDetect, mockClaudeAnalyze,
	mockListArchivedTasks, mockReadArchivedTask, mockArchiveToSkeleton,
	mockDualWrite, mockSaveSkeletonIndex, mockGlobalIndex,
} = vi.hoisted(() => ({
	mockReaddir: vi.fn(),
	mockStat: vi.fn(),
	mockReadFile: vi.fn(),
	mockWriteFile: vi.fn(),
	mockMkdir: vi.fn(),
	mockExistsSync: vi.fn(),
	mockDetectStorageLocations: vi.fn(),
	mockDetectWorkspaceForTask: vi.fn(),
	mockAnalyzeConversation: vi.fn(),
	mockClaudeDetect: vi.fn(),
	mockClaudeAnalyze: vi.fn(),
	mockListArchivedTasks: vi.fn(),
	mockReadArchivedTask: vi.fn(),
	mockArchiveToSkeleton: vi.fn(),
	mockDualWrite: vi.fn(),
	mockSaveSkeletonIndex: vi.fn(),
	mockGlobalIndex: { clear: vi.fn(), addInstruction: vi.fn(), getStats: vi.fn(() => ({ totalInstructions: 0, totalNodes: 0 })) },
}));

// fs — preserve real helpers for temp dirs if ever needed; override the used ones.
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return {
		...actual,
		existsSync: (...args: any[]) => mockExistsSync(...args),
		promises: {
			...actual.promises,
			readdir: (...args: any[]) => mockReaddir(...args),
			stat: (...args: any[]) => mockStat(...args),
			readFile: (...args: any[]) => mockReadFile(...args),
			writeFile: (...args: any[]) => mockWriteFile(...args),
			mkdir: (...args: any[]) => mockMkdir(...args),
		},
	};
});

vi.mock("../../../utils/roo-storage-detector.js", () => ({
	RooStorageDetector: {
		detectStorageLocations: mockDetectStorageLocations,
		detectWorkspaceForTask: mockDetectWorkspaceForTask,
		analyzeConversation: mockAnalyzeConversation,
	},
}));

// Dynamically-imported modules inside the handler (tier 2/3, dual-write, index).
vi.mock("../../../utils/claude-storage-detector.js", () => ({
	ClaudeStorageDetector: {
		detectStorageLocations: mockClaudeDetect,
		analyzeConversation: mockClaudeAnalyze,
	},
}));
vi.mock("../../../services/task-archiver/index.js", () => ({
	TaskArchiver: {
		listArchivedTasks: mockListArchivedTasks,
		readArchivedTask: mockReadArchivedTask,
	},
}));
vi.mock("../../../services/archive-skeleton-builder.js", () => ({
	archiveToSkeleton: mockArchiveToSkeleton,
}));
vi.mock("../../../services/unified-store/dual-write.js", () => ({
	dualWriteConversationToStore: (...args: any[]) => mockDualWrite(...args),
}));
vi.mock("../../../services/background-services.js", () => ({
	saveSkeletonIndex: (...args: any[]) => mockSaveSkeletonIndex(...args),
	toHeader: (s: any) => ({ taskId: s.taskId }),
}));
vi.mock("../../../utils/hierarchy-reconstruction-engine.js", () => ({
	HierarchyReconstructionEngine: vi.fn().mockImplementation(() => ({
		executePhase1: vi.fn().mockResolvedValue({ processedCount: 0, parsedCount: 0, totalInstructionsExtracted: 0 }),
		executePhase2: vi.fn().mockResolvedValue({ resolvedCount: 0, unresolvedCount: 0 }),
	})),
}));
vi.mock("../../../utils/task-instruction-index.js", () => ({
	globalTaskInstructionIndex: mockGlobalIndex,
}));

beforeEach(() => {
	vi.clearAllMocks();
	// Sensible defaults: empty Roo storage, all fs ops succeed.
	mockDetectStorageLocations.mockResolvedValue([]);
	mockDetectWorkspaceForTask.mockResolvedValue("UNKNOWN");
	mockAnalyzeConversation.mockResolvedValue(null);
	mockReaddir.mockResolvedValue([]);
	mockStat.mockResolvedValue({ isDirectory: () => true, mtime: new Date("2025-01-01T00:00:00Z") });
	mockReadFile.mockResolvedValue("{}");
	mockWriteFile.mockResolvedValue(undefined);
	mockMkdir.mockResolvedValue(undefined);
	mockExistsSync.mockReturnValue(true);
	// Fire-and-forget side-effects: must resolve to a thenable (handler calls .catch()).
	mockDualWrite.mockResolvedValue(undefined);
	mockSaveSkeletonIndex.mockResolvedValue(undefined);
});

describe("build-skeleton-cache multi-tier loading (#1244 Couche 1.4)", () => {
	describe("Tier 2 — Claude Code local sessions (L490-530)", () => {
		test("loads Claude session skeleton when sequence non-empty (L508-519)", async () => {
			mockClaudeDetect.mockResolvedValue([{ projectPath: "/home/.claude/projects/proj-A" }]);
			const claudeSkeleton = {
				taskId: "claude-proj-A",
				sequence: [{ role: "user", content: "hi" }],
				metadata: {},
			} as any;
			mockClaudeAnalyze.mockResolvedValue(claudeSkeleton);

			const result: any = await handleBuildSkeletonCache(
				{ sources: ["claude"] } as any,
				new Map()
			);

			const text: string = result.content[0].text;
			expect(text).toContain("Tier2(claude): loaded=1");
			expect(mockClaudeAnalyze).toHaveBeenCalledWith("claude-proj-A", "/home/.claude/projects/proj-A");
		});

		test("skips Claude session whose taskId already in cache (collision, L503-506)", async () => {
			// Pre-seed the cache so the tier-2 collision branch fires.
			// NOTE: handleBuildSkeletonCache clears the cache at entry, so we cannot
			// pre-seed. Instead we make Roo load first (sources includes 'roo'),
			// producing a task that collides with a Claude taskId.
			mockDetectStorageLocations.mockResolvedValue(["/roo/storage"]);
			// Roo storage has one task dir whose analyzeConversation yields taskId
			// matching the Claude-derived taskId 'claude-proj-B'.
			mockReaddir.mockImplementation(async (p: string) => {
				if (String(p).endsWith("tasks")) {
					return [{ name: "claude-proj-B", isDirectory: () => true }];
				}
				if (String(p).endsWith("proj-B")) {
					// task dir contents — minimal
					return [];
				}
				return [];
			});
			mockStat.mockImplementation(async (p: string) => {
				// metadata/api/ui file exists for the Roo task
				return { isDirectory: () => false, mtime: new Date("2025-06-01T00:00:00Z") };
			});
			mockReadFile.mockImplementation(async (p: string) => {
				if (String(p).endsWith(".json") && String(p).includes(".skeletons")) {
					// existing up-to-date skeleton for the Roo task
					return JSON.stringify({ taskId: "claude-proj-B", sequence: [{ role: "user", content: "x" }] });
				}
				return "{}";
			});
			mockAnalyzeConversation.mockResolvedValue({ taskId: "claude-proj-B", sequence: [{ role: "user", content: "x" }], childTaskInstructionPrefixes: [] });

			// Claude side returns the SAME taskId → collision → tier2Skipped++
			mockClaudeDetect.mockResolvedValue([{ projectPath: "/home/.claude/projects/proj-B" }]);
			mockClaudeAnalyze.mockResolvedValue({ taskId: "claude-proj-B", sequence: [{ role: "user", content: "y" }], metadata: {} });

			const result: any = await handleBuildSkeletonCache(
				{ sources: ["roo", "claude"], force_rebuild: true } as any,
				new Map()
			);

			const text: string = result.content[0].text;
			expect(text).toContain("Tier2(claude):");
			expect(text).toMatch(/skipped=1/);
		});

		test("skips Claude session with empty sequence (L511 guard)", async () => {
			mockClaudeDetect.mockResolvedValue([{ projectPath: "/home/.claude/projects/empty" }]);
			// sequence null/empty → skeleton not added, tier2Loaded stays 0
			mockClaudeAnalyze.mockResolvedValue({ taskId: "claude-empty", sequence: [], metadata: {} });

			const result: any = await handleBuildSkeletonCache(
				{ sources: ["claude"] } as any,
				new Map()
			);

			const text: string = result.content[0].text;
			expect(text).toContain("Tier2(claude): loaded=0");
		});

		test("records tier2Errors when analyzeConversation throws (L521-524)", async () => {
			mockClaudeDetect.mockResolvedValue([{ projectPath: "/home/.claude/projects/bad" }]);
			mockClaudeAnalyze.mockRejectedValue(new Error("parse explosion"));

			const result: any = await handleBuildSkeletonCache(
				{ sources: ["claude"] } as any,
				new Map()
			);

			const text: string = result.content[0].text;
			expect(text).toContain("Tier2(claude):");
			expect(text).toMatch(/errors=1/);
		});
	});

	describe("Tier 3 — cross-machine GDrive archives (L535-575)", () => {
		test("loads archive skeleton via TaskArchiver + archiveToSkeleton (L541-562)", async () => {
			mockListArchivedTasks.mockResolvedValue(["archived-task-1"]);
			mockReadArchivedTask.mockResolvedValue({ taskId: "archived-task-1", messages: [] } as any);
			const archiveSkeleton = { taskId: "archived-task-1", sequence: [{ role: "user", content: "z" }] } as any;
			mockArchiveToSkeleton.mockReturnValue(archiveSkeleton);

			const result: any = await handleBuildSkeletonCache(
				{ sources: ["archive"] } as any,
				new Map()
			);

			const text: string = result.content[0].text;
			expect(text).toContain("Tier3(archive): loaded=1");
			expect(mockArchiveToSkeleton).toHaveBeenCalled();
		});

		test("counts tier3Errors when readArchivedTask returns null (L553-556)", async () => {
			mockListArchivedTasks.mockResolvedValue(["ghost-archive"]);
			mockReadArchivedTask.mockResolvedValue(null);

			const result: any = await handleBuildSkeletonCache(
				{ sources: ["archive"] } as any,
				new Map()
			);

			const text: string = result.content[0].text;
			expect(text).toMatch(/Tier3\(archive\):.*errors=1/);
		});

		test("skips archive whose taskId already in cache (collision, L547-550)", async () => {
			// Roo loads task 'dup-id' first, then archive tries same id → tier3Skipped.
			mockDetectStorageLocations.mockResolvedValue(["/roo/storage"]);
			mockReaddir.mockImplementation(async (p: string) => {
				if (String(p).endsWith("tasks")) return [{ name: "dup-id", isDirectory: () => true }];
				return [];
			});
			mockStat.mockResolvedValue({ isDirectory: () => false, mtime: new Date("2025-06-01T00:00:00Z") });
			mockReadFile.mockImplementation(async (p: string) => {
				if (String(p).includes(".skeletons") && String(p).endsWith(".json")) {
					return JSON.stringify({ taskId: "dup-id", sequence: [{ role: "user", content: "x" }] });
				}
				return "{}";
			});
			mockAnalyzeConversation.mockResolvedValue({ taskId: "dup-id", sequence: [{ role: "user", content: "x" }], childTaskInstructionPrefixes: [] });

			mockListArchivedTasks.mockResolvedValue(["dup-id"]);
			mockReadArchivedTask.mockResolvedValue({ taskId: "dup-id", messages: [] } as any);
			mockArchiveToSkeleton.mockReturnValue({ taskId: "dup-id", sequence: [{ role: "user", content: "z" }] } as any);

			const result: any = await handleBuildSkeletonCache(
				{ sources: ["roo", "archive"], force_rebuild: true } as any,
				new Map()
			);

			const text: string = result.content[0].text;
			expect(text).toMatch(/Tier3\(archive\):.*skipped=1/);
		});
	});

	describe("reindex force-enqueue (L200-206)", () => {
		test("reindex=true enqueues to Qdrant even when indexing globally disabled", async () => {
			mockClaudeDetect.mockResolvedValue([{ projectPath: "/home/.claude/projects/r" }]);
			mockClaudeAnalyze.mockResolvedValue({ taskId: "claude-r", sequence: [{ role: "user", content: "x" }], metadata: {} });

			const queue = new Set<string>();
			const state = {
				qdrantIndexQueue: queue,
				isQdrantIndexingEnabled: false, // globally off
			} as any;

			await handleBuildSkeletonCache(
				{ sources: ["claude"], reindex: true } as any,
				new Map(),
				state
			);

			// reindex=true bypasses the isQdrantIndexingEnabled gate (L203).
			expect(queue.has("claude-r")).toBe(true);
		});

		test("reindex omitted + indexing disabled → NO enqueue", async () => {
			mockClaudeDetect.mockResolvedValue([{ projectPath: "/home/.claude/projects/nr" }]);
			mockClaudeAnalyze.mockResolvedValue({ taskId: "claude-nr", sequence: [{ role: "user", content: "x" }], metadata: {} });

			const queue = new Set<string>();
			const state = { qdrantIndexQueue: queue, isQdrantIndexingEnabled: false } as any;

			await handleBuildSkeletonCache(
				{ sources: ["claude"] } as any,
				new Map(),
				state
			);

			expect(queue.has("claude-nr")).toBe(false);
		});
	});

	describe("multi-tier response format (L966-974)", () => {
		test("appends per-tier stats only when claude/archive sources active", async () => {
			mockClaudeDetect.mockResolvedValue([{ projectPath: "/c/p1" }]);
			mockClaudeAnalyze.mockResolvedValue({ taskId: "claude-p1", sequence: [{ role: "user", content: "x" }], metadata: {} });
			mockListArchivedTasks.mockResolvedValue(["a1"]);
			mockReadArchivedTask.mockResolvedValue({ taskId: "a1", messages: [] } as any);
			mockArchiveToSkeleton.mockReturnValue({ taskId: "a1", sequence: [{ role: "user", content: "z" }] } as any);

			const result: any = await handleBuildSkeletonCache(
				{ sources: ["claude", "archive"] } as any,
				new Map()
			);

			const text: string = result.content[0].text;
			// Both tiers active → both labels present.
			expect(text).toContain("Tier2(claude): loaded=1");
			expect(text).toContain("Tier3(archive): loaded=1");
			expect(text).toContain("sources=claude+archive");
		});

		test("does NOT append tier labels for roo-only sources", async () => {
			mockDetectStorageLocations.mockResolvedValue(["/roo"]);
			mockReaddir.mockResolvedValue([]);

			const result: any = await handleBuildSkeletonCache({}, new Map());

			const text: string = result.content[0].text;
			expect(text).not.toContain("Tier2(claude)");
			expect(text).not.toContain("Tier3(archive)");
		});
	});
});
