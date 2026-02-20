/**
 * Tests unitaires pour get-conversation-synthesis.tool.ts
 *
 * Couvre :
 * - handleGetConversationSynthesis : validation, format routing, file export
 * - generateRealSynthesis (via handler) : skeleton lookup, LLM pipeline, fallback
 * - writeAnalysisToFile (via handler) : JSON/markdown output
 * - populateConversationCache (via handler) : storage detection, skeleton loading
 * - Error handling : StateManagerError propagation, generic errors
 *
 * @module summary/get-conversation-synthesis.test
 * @version 1.0.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock setup with vi.hoisted for ESM compatibility
// ============================================================

const {
    mockMkdir,
    mockWriteFile,
    mockReaddir,
    mockReadFile,
    mockSynthesizeConversation,
    mockDetectStorageLocations,
} = vi.hoisted(() => ({
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockReaddir: vi.fn().mockResolvedValue([]),
    mockReadFile: vi.fn().mockResolvedValue('{}'),
    mockSynthesizeConversation: vi.fn(),
    mockDetectStorageLocations: vi.fn().mockResolvedValue([]),
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
    default: {
        mkdir: mockMkdir,
        writeFile: mockWriteFile,
        readdir: mockReaddir,
        readFile: mockReadFile,
    },
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    readdir: mockReaddir,
    readFile: mockReadFile,
}));

// Mock SynthesisOrchestratorService - use class to survive vi.clearAllMocks()
vi.mock('../../../services/synthesis/SynthesisOrchestratorService.js', () => ({
    SynthesisOrchestratorService: class {
        synthesizeConversation(...args: any[]) {
            return mockSynthesizeConversation(...args);
        }
    },
}));

// Mock NarrativeContextBuilderService
vi.mock('../../../services/synthesis/NarrativeContextBuilderService.js', () => ({
    NarrativeContextBuilderService: class {},
}));

// Mock LLMService
vi.mock('../../../services/synthesis/LLMService.js', () => ({
    LLMService: class {},
}));

// Mock RooStorageDetector
vi.mock('../../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: mockDetectStorageLocations,
    },
}));

import {
    handleGetConversationSynthesis,
    GetConversationSynthesisArgs,
} from '../get-conversation-synthesis.tool.js';
import { StateManagerError } from '../../../types/errors.js';
import { ConversationAnalysis } from '../../../models/synthesis/SynthesisModels.js';
import { ConversationSkeleton } from '../../../types/conversation.js';

// ============================================================
// Test data
// ============================================================

const sampleAnalysis: ConversationAnalysis = {
    taskId: 'task-123',
    analysisEngineVersion: '3.0.0',
    analysisTimestamp: '2026-02-20T10:00:00Z',
    llmModelId: 'gpt-4-turbo-synthesis',
    contextTrace: {
        rootTaskId: 'root-task',
        parentTaskId: 'parent-task',
        previousSiblingTaskIds: [],
    },
    objectives: { primaryGoal: 'Test task' },
    strategy: { approach: 'Direct' },
    quality: { completionScore: 9 },
    metrics: { totalMessages: 10, filesModified: 2, timeSpent: '1h' },
    synthesis: {
        initialContextSummary: 'Initial context for testing',
        finalTaskSummary: 'Final summary for testing',
    },
};

const sampleSkeleton: ConversationSkeleton = {
    taskId: 'task-123',
    metadata: {
        lastActivity: '2026-02-20T10:00:00Z',
        createdAt: '2026-02-20T09:00:00Z',
        messageCount: 10,
        actionCount: 5,
        totalSize: 1024,
        workspace: '/test/workspace',
    },
} as ConversationSkeleton;

// ============================================================
// Tests
// ============================================================

describe('handleGetConversationSynthesis', () => {
    let mockGetSkeleton: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});

        mockGetSkeleton = vi.fn().mockResolvedValue(sampleSkeleton);
        mockSynthesizeConversation.mockResolvedValue(sampleAnalysis);
        mockDetectStorageLocations.mockResolvedValue([]);
    });

    // ============================================================
    // Argument Validation
    // ============================================================
    describe('argument validation', () => {
        it('should throw StateManagerError when taskId is missing', async () => {
            const args = {} as GetConversationSynthesisArgs;

            await expect(
                handleGetConversationSynthesis(args, mockGetSkeleton)
            ).rejects.toThrow(StateManagerError);

            await expect(
                handleGetConversationSynthesis(args, mockGetSkeleton)
            ).rejects.toThrow('taskId est requis');
        });

        it('should throw StateManagerError when taskId is empty string', async () => {
            const args = { taskId: '' } as GetConversationSynthesisArgs;

            await expect(
                handleGetConversationSynthesis(args, mockGetSkeleton)
            ).rejects.toThrow('taskId est requis');
        });
    });

    // ============================================================
    // Conversation Not Found
    // ============================================================
    describe('conversation not found', () => {
        it('should throw CONVERSATION_NOT_FOUND when skeleton is null', async () => {
            mockGetSkeleton.mockResolvedValue(null);

            await expect(
                handleGetConversationSynthesis({ taskId: 'missing' }, mockGetSkeleton)
            ).rejects.toThrow('Conversation non trouvée: missing');
        });
    });

    // ============================================================
    // Format Selection
    // ============================================================
    describe('format selection', () => {
        it('should return full analysis object by default (json format)', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'task-123' },
                mockGetSkeleton
            );

            expect(result).toEqual(sampleAnalysis);
        });

        it('should return full analysis object with explicit json format', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'task-123', outputFormat: 'json' },
                mockGetSkeleton
            );

            expect(result).toEqual(sampleAnalysis);
        });

        it('should return finalTaskSummary for markdown format', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'task-123', outputFormat: 'markdown' },
                mockGetSkeleton
            );

            expect(result).toBe('Final summary for testing');
        });
    });

    // ============================================================
    // File Export
    // ============================================================
    describe('file export', () => {
        it('should write JSON to file when filePath specified', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'task-123', filePath: '/tmp/synthesis.json' },
                mockGetSkeleton
            );

            expect(typeof result).toBe('string');
            expect(result).toContain('exportée vers');
            expect(result).toContain('/tmp/synthesis.json');
            expect(mockMkdir).toHaveBeenCalledWith('/tmp', { recursive: true });
            expect(mockWriteFile).toHaveBeenCalledWith(
                '/tmp/synthesis.json',
                JSON.stringify(sampleAnalysis, null, 2),
                'utf-8'
            );
        });

        it('should write markdown to file when format is markdown', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'task-123', filePath: '/tmp/synthesis.md', outputFormat: 'markdown' },
                mockGetSkeleton
            );

            expect(typeof result).toBe('string');
            expect(result).toContain('format markdown');

            const writeCall = mockWriteFile.mock.calls[0];
            const content = writeCall[1] as string;
            expect(content).toContain('# Synth\u00e8se de Conversation - task-123');
            expect(content).toContain('Initial context for testing');
            expect(content).toContain('Final summary for testing');
            expect(content).toContain('3.0.0');
        });

        it('should create parent directory recursively', async () => {
            await handleGetConversationSynthesis(
                { taskId: 'task-123', filePath: '/deep/nested/dir/output.json' },
                mockGetSkeleton
            );

            expect(mockMkdir).toHaveBeenCalledWith('/deep/nested/dir', { recursive: true });
        });
    });

    // ============================================================
    // LLM Pipeline (via generateRealSynthesis)
    // ============================================================
    describe('LLM pipeline', () => {
        it('should call getConversationSkeleton with taskId', async () => {
            await handleGetConversationSynthesis(
                { taskId: 'task-123' },
                mockGetSkeleton
            );

            expect(mockGetSkeleton).toHaveBeenCalledWith('task-123');
        });

        it('should call synthesizeConversation on orchestrator', async () => {
            await handleGetConversationSynthesis(
                { taskId: 'task-123' },
                mockGetSkeleton
            );

            expect(mockSynthesizeConversation).toHaveBeenCalledWith('task-123');
        });

        it('should return fallback analysis when orchestrator throws', async () => {
            mockSynthesizeConversation.mockRejectedValue(new Error('LLM API failed'));

            const result = await handleGetConversationSynthesis(
                { taskId: 'task-123' },
                mockGetSkeleton
            );

            // generateRealSynthesis returns a fallback analysis (not throws)
            expect(result).toBeDefined();
            const analysis = result as ConversationAnalysis;
            expect(analysis.taskId).toBe('task-123');
            expect(analysis.analysisEngineVersion).toBe('3.0.0-error');
            expect(analysis.llmModelId).toBe('error-fallback');
            expect(analysis.synthesis.finalTaskSummary).toContain('LLM API failed');
        });
    });

    // ============================================================
    // populateConversationCache (via handler)
    // ============================================================
    describe('cache population', () => {
        it('should call RooStorageDetector during synthesis', async () => {
            await handleGetConversationSynthesis(
                { taskId: 'task-123' },
                mockGetSkeleton
            );

            expect(mockDetectStorageLocations).toHaveBeenCalled();
        });

        it('should load skeletons from detected storage locations', async () => {
            mockDetectStorageLocations.mockResolvedValue(['/storage/roo']);
            mockReaddir.mockResolvedValue(['task-a.json', 'task-b.json', 'readme.txt']);
            mockReadFile.mockResolvedValue(JSON.stringify({
                taskId: 'task-a',
                metadata: { messageCount: 5 }
            }));

            await handleGetConversationSynthesis(
                { taskId: 'task-123' },
                mockGetSkeleton
            );

            // Should have read .json files (not readme.txt)
            expect(mockReadFile).toHaveBeenCalled();
        });

        it('should handle storage detection returning empty', async () => {
            mockDetectStorageLocations.mockResolvedValue([]);

            // Should not throw
            const result = await handleGetConversationSynthesis(
                { taskId: 'task-123' },
                mockGetSkeleton
            );

            expect(result).toBeDefined();
        });

        it('should handle storage detection errors gracefully', async () => {
            mockDetectStorageLocations.mockRejectedValue(new Error('No storage'));

            // Should not throw from populateConversationCache - it catches internally
            const result = await handleGetConversationSynthesis(
                { taskId: 'task-123' },
                mockGetSkeleton
            );

            expect(result).toBeDefined();
        });

        it('should strip BOM from skeleton files', async () => {
            mockDetectStorageLocations.mockResolvedValue(['/storage']);
            mockReaddir.mockResolvedValue(['bom-file.json']);
            // UTF-8 BOM prefix
            const bomContent = '\uFEFF' + JSON.stringify({ taskId: 'bom-task', metadata: {} });
            mockReadFile.mockResolvedValue(bomContent);

            // Should not throw due to BOM
            const result = await handleGetConversationSynthesis(
                { taskId: 'task-123' },
                mockGetSkeleton
            );

            expect(result).toBeDefined();
        });

        it('should handle malformed skeleton files gracefully', async () => {
            mockDetectStorageLocations.mockResolvedValue(['/storage']);
            mockReaddir.mockResolvedValue(['bad.json']);
            mockReadFile.mockResolvedValue('not valid json{{{');

            // Should not throw - individual parse errors are caught
            const result = await handleGetConversationSynthesis(
                { taskId: 'task-123' },
                mockGetSkeleton
            );

            expect(result).toBeDefined();
        });

        it('should handle readdir errors for skeleton directory', async () => {
            mockDetectStorageLocations.mockResolvedValue(['/storage']);
            mockReaddir.mockRejectedValue(new Error('ENOENT'));

            // Should not throw - readdir errors caught per location
            const result = await handleGetConversationSynthesis(
                { taskId: 'task-123' },
                mockGetSkeleton
            );

            expect(result).toBeDefined();
        });
    });

    // ============================================================
    // Error Handling
    // ============================================================
    describe('error handling', () => {
        it('should propagate StateManagerError as-is', async () => {
            const customError = new StateManagerError(
                'Custom error',
                'CUSTOM_CODE',
                'TestService'
            );
            mockGetSkeleton.mockRejectedValue(customError);

            await expect(
                handleGetConversationSynthesis({ taskId: 'task-123' }, mockGetSkeleton)
            ).rejects.toThrow(customError);
        });

        it('should wrap generic Error in StateManagerError', async () => {
            mockGetSkeleton.mockRejectedValue(new Error('Network timeout'));

            try {
                await handleGetConversationSynthesis({ taskId: 'task-123' }, mockGetSkeleton);
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(StateManagerError);
                expect((error as StateManagerError).code).toBe('SYNTHESIS_RETRIEVAL_FAILED');
                expect((error as StateManagerError).message).toContain('Network timeout');
            }
        });

        it('should wrap non-Error in StateManagerError', async () => {
            mockGetSkeleton.mockRejectedValue('string error');

            try {
                await handleGetConversationSynthesis({ taskId: 'task-123' }, mockGetSkeleton);
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(StateManagerError);
                expect((error as StateManagerError).code).toBe('SYNTHESIS_RETRIEVAL_FAILED');
            }
        });
    });
});
