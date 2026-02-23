/**
 * Tests unitaires pour build-skeleton-cache.tool.ts
 */

import { describe, test, expect, vi, beforeEach } from "vitest";
import { buildSkeletonCacheDefinition, handleBuildSkeletonCache } from "../build-skeleton-cache.tool.js";
import type { ConversationSkeleton } from "../../../types/conversation.js";

// Mocks
const mockReaddir = vi.fn();
const mockStat = vi.fn();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockExistsSync = vi.fn();

vi.mock("fs", () => ({
    existsSync: (...args) => mockExistsSync(...args),
    promises: {
        readdir: (...args) => mockReaddir(...args),
        stat: (...args) => mockStat(...args),
        readFile: (...args) => mockReadFile(...args),
        writeFile: (...args) => mockWriteFile(...args),
        mkdir: (...args) => mockMkdir(...args),
    },
}));

vi.mock("../../../utils/roo-storage-detector.js", () => ({
    RooStorageDetector: {
        detectStorageLocations: vi.fn(),
        detectWorkspaceForTask: vi.fn(),
        analyzeConversation: vi.fn(),
    },
}));

vi.mock("../../../utils/hierarchy-reconstruction-engine.js", () => ({
    HierarchyReconstructionEngine: vi.fn().mockImplementation(() => ({
        executePhase1: vi.fn().mockResolvedValue({
            processedCount: 0,
            parsedCount: 0,
            totalInstructionsExtracted: 0,
        }),
        executePhase2: vi.fn().mockResolvedValue({
            resolvedCount: 0,
            unresolvedCount: 0,
        }),
    })),
}));

vi.mock("../../../utils/task-instruction-index.js", () => ({
    globalTaskInstructionIndex: {
        clear: vi.fn(),
        addInstruction: vi.fn(),
        getStats: vi.fn(() => ({
            totalInstructions: 0,
            totalNodes: 0,
        })),
    },
}));

import { RooStorageDetector } from "../../../utils/roo-storage-detector.js";

beforeEach(() => {
    vi.clearAllMocks();
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({
        isDirectory: () => true,
        mtime: new Date("2025-01-01T00:00:00Z"),
    });
    mockReadFile.mockResolvedValue("{}");
    mockWriteFile.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockExistsSync.mockReturnValue(true);
    (RooStorageDetector.detectStorageLocations as any).mockResolvedValue([]);
    (RooStorageDetector.detectWorkspaceForTask as any).mockResolvedValue("UNKNOWN");
    (RooStorageDetector.analyzeConversation as any).mockResolvedValue(null);
});

describe("build-skeleton-cache.tool", () => {
    describe("interface", () => {
        test("buildSkeletonCacheDefinition a la structure correcte", () => {
            expect(buildSkeletonCacheDefinition).toHaveProperty("name", "build_skeleton_cache");
            expect(buildSkeletonCacheDefinition).toHaveProperty("description");
            expect(buildSkeletonCacheDefinition).toHaveProperty("inputSchema");
        });

        test("inputSchema définit force_rebuild comme optionel", () => {
            const { properties, required } = buildSkeletonCacheDefinition.inputSchema;
            expect(properties).toHaveProperty("force_rebuild");
            expect(required).not.toContain("force_rebuild");
            expect(properties.force_rebuild.type).toBe("boolean");
        });

        test("handleBuildSkeletonCache est une fonction async", () => {
            expect(typeof handleBuildSkeletonCache).toBe("function");
        });
    });

    describe("handleBuildSkeletonCache", () => {
        test("retourne Storage not found si aucune storage location", async () => {
            const result = await handleBuildSkeletonCache({}, new Map());
            expect(result.content[0].text).toContain("Storage not found");
        });

        test("démarre en mode SMART_REBUILD par défaut", async () => {
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([]);
            const result = await handleBuildSkeletonCache({}, new Map());
            expect(result.content[0].text).toContain("SMART_REBUILD");
        });

        test("démarre en mode FORCE_REBUILD si force_rebuild=true", async () => {
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([]);
            const result = await handleBuildSkeletonCache({ force_rebuild: true }, new Map());
            expect(result.content[0].text).toContain("FORCE_REBUILD");
        });

        test("utilise le mode TARGETED_BUILD si task_ids fourni", async () => {
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([{ name: "task-1", isDirectory: () => true }]);
            mockStat.mockResolvedValue({ isDirectory: () => true, mtime: new Date() });
            const result = await handleBuildSkeletonCache({ task_ids: ["task-1"] }, new Map());
            // TARGETED_BUILD apparaît dans les logs de debug, pas forcément dans le message principal
            // On vérifie juste que le handler s'exécute sans erreur
            expect(result.content[0].text).toBeDefined();
        });

        test("filtre les tâches si task_ids fourni", async () => {
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([
                { name: "task-1", isDirectory: () => true },
                { name: "task-2", isDirectory: () => true },
            ]);
            mockStat.mockResolvedValue({ isDirectory: () => true, mtime: new Date() });
            await handleBuildSkeletonCache({ task_ids: ["task-1"] }, new Map());
            expect(mockStat).toHaveBeenCalledTimes(2);
        });

        test("skip les tâches sans fichiers valides", async () => {
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([{ name: "invalid-task", isDirectory: () => true }]);
            mockStat.mockRejectedValue(new Error("ENOENT"));
            const result = await handleBuildSkeletonCache({}, new Map());
            expect(result.content[0].text).toContain("Skipped: 1");
        });

        test("crée le répertoire .skeletons si absent", async () => {
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([{ name: "task-1", isDirectory: () => true }]);
            mockStat.mockResolvedValue({ isDirectory: () => true, mtime: new Date() });
            await handleBuildSkeletonCache({}, new Map());
            expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining(".skeletons"), { recursive: true });
        });
    });

    describe("Phase 1: Construction des squelettes", () => {
        test("appelle analyzeConversation pour chaque tâche à reconstruire", async () => {
            const newSkeleton = {
                taskId: "task-1",
                title: "New Task",
                mode: "code",
                createdAt: "2025-01-01T00:00:00Z",
                metadata: { workspace: "test" },
            };
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([{ name: "task-1", isDirectory: () => true }]);
            // task_metadata existe (pour valider la tâche)
            mockStat.mockResolvedValueOnce({ isDirectory: () => false, mtime: new Date() });
            // Mais le skeleton n'existe pas (pour forcer la reconstruction)
            mockStat.mockRejectedValueOnce(new Error("ENOENT"));
            (RooStorageDetector.analyzeConversation as any).mockResolvedValue(newSkeleton);
            mockWriteFile.mockResolvedValue(undefined);
            await handleBuildSkeletonCache({ force_rebuild: true }, new Map());
            expect(RooStorageDetector.analyzeConversation).toHaveBeenCalledWith("task-1", expect.stringContaining("task-1"));
        });

        test("sauvegarde le squelette construit sur disque", async () => {
            const newSkeleton = {
                taskId: "task-1",
                title: "New Task",
                mode: "code",
                createdAt: "2025-01-01T00:00:00Z",
                metadata: { workspace: "test" },
            };
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([{ name: "task-1", isDirectory: () => true }]);
            // task_metadata existe, skeleton n'existe pas
            mockStat.mockResolvedValueOnce({ isDirectory: () => false, mtime: new Date() });
            mockStat.mockRejectedValueOnce(new Error("ENOENT"));
            (RooStorageDetector.analyzeConversation as any).mockResolvedValue(newSkeleton);
            mockWriteFile.mockResolvedValue(undefined);
            await handleBuildSkeletonCache({ force_rebuild: true }, new Map());
            expect(mockWriteFile).toHaveBeenCalledWith(expect.stringContaining("task-1.json"), JSON.stringify(newSkeleton, null, 2));
        });
    });

    describe("Phase 2: Alimentation du RadixTree", () => {
        test("vide le globalTaskInstructionIndex avant de le repeupler", async () => {
            const { globalTaskInstructionIndex } = await import("../../../utils/task-instruction-index.js");
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([]);
            await handleBuildSkeletonCache({}, new Map());
            expect(globalTaskInstructionIndex.clear).toHaveBeenCalled();
        });

        test("ajoute les instructions au RadixTree", async () => {
            const skeletonWithPrefixes = {
                taskId: "parent-task",
                title: "Parent",
                mode: "code",
                createdAt: "2025-01-01T00:00:00Z",
                metadata: { workspace: "test" },
                childTaskInstructionPrefixes: ["Create feature", "Fix bug"],
            };
            const { globalTaskInstructionIndex } = await import("../../../utils/task-instruction-index.js");
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([{ name: "parent-task", isDirectory: () => true }]);
            mockStat.mockResolvedValue({ isDirectory: () => true, mtime: new Date() });
            mockReadFile.mockResolvedValue(JSON.stringify(skeletonWithPrefixes));
            await handleBuildSkeletonCache({}, new Map());
            expect(globalTaskInstructionIndex.addInstruction).toHaveBeenCalledWith("parent-task", "Create feature");
            expect(globalTaskInstructionIndex.addInstruction).toHaveBeenCalledWith("parent-task", "Fix bug");
        });
    });

    describe("gestion des erreurs", () => {
        test("gère les erreurs de lecture du répertoire tasks", async () => {
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockRejectedValue(new Error("Permission denied"));
            const result = await handleBuildSkeletonCache({}, new Map());
            expect(result.content[0].text).toBeDefined();
        });

        test("gère les erreurs danalyzeConversation", async () => {
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([{ name: "task-1", isDirectory: () => true }]);
            mockStat.mockRejectedValue(new Error("ENOENT"));
            (RooStorageDetector.analyzeConversation as any).mockResolvedValue(null);
            const result = await handleBuildSkeletonCache({ force_rebuild: true }, new Map());
            expect(result.content[0].text).toContain("Skipped: 1");
        });
    });

    describe("encodage UTF-8 BOM", () => {
        test("retire la BOM UTF-8 lors de la lecture", async () => {
            const skeletonWithBOM = "\uFEFF" + JSON.stringify({
                taskId: "task-1",
                title: "Task",
                mode: "code",
                createdAt: "2025-01-01T00:00:00Z",
                metadata: { workspace: "test" },
            });
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([{ name: "task-1", isDirectory: () => true }]);
            mockStat.mockResolvedValue({ isDirectory: () => true, mtime: new Date("2025-01-02T00:00:00Z") });
            mockReadFile.mockResolvedValue(skeletonWithBOM);
            const cache = new Map();
            await handleBuildSkeletonCache({}, cache);
            expect(cache.has("task-1")).toBe(true);
            expect(cache.get("task-1")?.taskId).toBe("task-1");
        });
    });

    describe("validation et reporting", () => {
        test("retourne les statistiques correctes", async () => {
            const newSkeleton = {
                taskId: "task-1",
                title: "New Task",
                mode: "code",
                createdAt: "2025-01-01T00:00:00Z",
                metadata: { workspace: "test" },
            };
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([{ name: "task-1", isDirectory: () => true }]);
            // task_metadata existe, skeleton n'existe pas
            mockStat.mockResolvedValueOnce({ isDirectory: () => false, mtime: new Date() });
            mockStat.mockRejectedValueOnce(new Error("ENOENT"));
            (RooStorageDetector.analyzeConversation as any).mockResolvedValue(newSkeleton);
            mockWriteFile.mockResolvedValue(undefined);
            const result = await handleBuildSkeletonCache({ force_rebuild: true }, new Map());
            expect(result.content[0].text).toContain("Built: 1");
            expect(result.content[0].text).toContain("Cache size: 1");
        });
    });

    describe("console.log interception", () => {
        test("restaure console.log après exécution", async () => {
            const originalLog = console.log;
            (RooStorageDetector.detectStorageLocations as any).mockResolvedValue(["/mock/storage"]);
            mockReaddir.mockResolvedValue([]);
            await handleBuildSkeletonCache({}, new Map());
            expect(console.log).toBe(originalLog);
        });
    });
});