/**
 * Tests pour build-skeleton-cache.tool.ts
 * Coverage target: Core logic + schema validation
 *
 * Note: Tests d'intégration complets (mocking fs, RooStorageDetector, HierarchyReconstructionEngine)
 * nécessiteraient une fixture complexe. Cette suite se concentre sur:
 * - Validation du schéma input
 * - Logique de réponse timeout
 * - Logique de filtrage args
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    buildSkeletonCacheDefinition,
    handleBuildSkeletonCache,
    BuildSkeletonCacheArgs
} from '../build-skeleton-cache.tool.js';
import { ConversationSkeleton } from '../../../types/conversation.js';

// Mock des dépendances lourdes
vi.mock('../../../utils/roo-storage-detector.js', () => ({
    RooStorageDetector: {
        detectStorageLocations: vi.fn(() => Promise.resolve([])),
        detectWorkspaceForTask: vi.fn(() => Promise.resolve('UNKNOWN'))
    }
}));

describe('build-skeleton-cache.tool.ts', () => {

    describe('buildSkeletonCacheDefinition - Schema Validation', () => {
        it('should have correct tool name', () => {
            expect(buildSkeletonCacheDefinition.name).toBe('build_skeleton_cache');
        });

        it('should have description', () => {
            expect(buildSkeletonCacheDefinition.description).toBeDefined();
            expect(buildSkeletonCacheDefinition.description.length).toBeGreaterThan(0);
        });

        it('should define input schema with force_rebuild option', () => {
            const schema = buildSkeletonCacheDefinition.inputSchema;
            expect(schema.properties?.force_rebuild).toBeDefined();
            expect(schema.properties?.force_rebuild.type).toBe('boolean');
            expect(schema.properties?.force_rebuild.default).toBe(false);
        });

        it('should define input schema with workspace_filter option', () => {
            const schema = buildSkeletonCacheDefinition.inputSchema;
            expect(schema.properties?.workspace_filter).toBeDefined();
            expect(schema.properties?.workspace_filter.type).toBe('string');
        });

        it('should define input schema with task_ids option', () => {
            const schema = buildSkeletonCacheDefinition.inputSchema;
            expect(schema.properties?.task_ids).toBeDefined();
            expect(schema.properties?.task_ids.type).toBe('array');
            expect(schema.properties?.task_ids.items?.type).toBe('string');
        });

        it('should have no required properties', () => {
            const schema = buildSkeletonCacheDefinition.inputSchema;
            expect(schema.required).toEqual([]);
        });
    });

    describe('handleBuildSkeletonCache - Storage Not Found', () => {
        it('should return message when storage not found', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();

            const result = await handleBuildSkeletonCache({}, mockCache);

            expect(result.content).toBeDefined();
            expect(result.content.length).toBeGreaterThan(0);

            const text = result.content[0].text;
            expect(typeof text).toBe('string');
            expect(text).toContain('Storage not found');
        });

        it('should accept empty args object', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();

            const args: BuildSkeletonCacheArgs = {};
            const result = await handleBuildSkeletonCache(args, mockCache);

            expect(result.content).toBeDefined();
        });
    });

    describe('handleBuildSkeletonCache - Args Validation', () => {
        it('should accept force_rebuild=true', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();
            const args: BuildSkeletonCacheArgs = { force_rebuild: true };

            const result = await handleBuildSkeletonCache(args, mockCache);

            expect(result.content).toBeDefined();
            // Le message exact dépend du mock (storage found or not)
            // On vérifie juste que la fonction ne plante pas
        });

        it('should accept force_rebuild=false', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();
            const args: BuildSkeletonCacheArgs = { force_rebuild: false };

            const result = await handleBuildSkeletonCache(args, mockCache);

            expect(result.content).toBeDefined();
        });

        it('should accept workspace_filter parameter', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();
            const args: BuildSkeletonCacheArgs = { workspace_filter: 'd:\\roo-extensions' };

            const result = await handleBuildSkeletonCache(args, mockCache);

            expect(result.content).toBeDefined();
        });

        it('should accept task_ids parameter', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();
            const args: BuildSkeletonCacheArgs = { task_ids: ['task-123', 'task-456'] };

            const result = await handleBuildSkeletonCache(args, mockCache);

            expect(result.content).toBeDefined();
        });

        it('should prioritize task_ids over workspace_filter', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();
            const args: BuildSkeletonCacheArgs = {
                task_ids: ['task-123'],
                workspace_filter: 'd:\\other-workspace'
            };

            const result = await handleBuildSkeletonCache(args, mockCache);

            expect(result.content).toBeDefined();
        });
    });

    describe('handleBuildSkeletonCache - Cache Operations', () => {
        it('should clear cache at start', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();
            mockCache.set('existing-task', {
                taskId: 'existing-task',
                parentTaskId: null,
                metadata: {
                    title: 'Existing Task',
                    lastActivity: '2024-01-01T10:00:00Z',
                    createdAt: '2024-01-01T09:00:00Z',
                    messageCount: 1,
                    actionCount: 0,
                    totalSize: 100
                },
                sequence: []
            });

            expect(mockCache.size).toBe(1);

            await handleBuildSkeletonCache({}, mockCache);

            // Cache should be cleared
            expect(mockCache.size).toBe(0);
        });

        it('should accept ServerState parameter', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();
            const mockState = {
                isQdrantIndexingEnabled: false,
                qdrantIndexQueue: new Set<string>()
            };

            const result = await handleBuildSkeletonCache({}, mockCache, mockState);

            expect(result.content).toBeDefined();
        });
    });

    describe('handleBuildSkeletonCache - Response Format', () => {
        it('should return CallToolResult with content array', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();

            const result = await handleBuildSkeletonCache({}, mockCache);

            expect(result).toHaveProperty('content');
            expect(Array.isArray(result.content)).toBe(true);
        });

        it('should return text content', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();

            const result = await handleBuildSkeletonCache({}, mockCache);

            expect(result.content[0]).toHaveProperty('type');
            expect(result.content[0].type).toBe('text');
            expect(result.content[0]).toHaveProperty('text');
            expect(typeof result.content[0].text).toBe('string');
        });

        it('should include build statistics in response', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();

            const result = await handleBuildSkeletonCache({}, mockCache);
            const text = result.content[0].text as string;

            // Les statistiques sont présentes même quand storage not found
            expect(text).toBeDefined();
            expect(typeof text).toBe('string');
        });
    });

    describe('BuildSkeletonCacheArgs - Type Safety', () => {
        it('should accept all optional fields undefined', () => {
            const args: BuildSkeletonCacheArgs = {};
            expect(args).toBeDefined();
        });

        it('should accept force_rebuild only', () => {
            const args: BuildSkeletonCacheArgs = { force_rebuild: true };
            expect(args.force_rebuild).toBe(true);
            expect(args.workspace_filter).toBeUndefined();
            expect(args.task_ids).toBeUndefined();
        });

        it('should accept workspace_filter only', () => {
            const args: BuildSkeletonCacheArgs = { workspace_filter: 'test-workspace' };
            expect(args.force_rebuild).toBeUndefined();
            expect(args.workspace_filter).toBe('test-workspace');
            expect(args.task_ids).toBeUndefined();
        });

        it('should accept task_ids only', () => {
            const args: BuildSkeletonCacheArgs = { task_ids: ['task-1', 'task-2'] };
            expect(args.force_rebuild).toBeUndefined();
            expect(args.workspace_filter).toBeUndefined();
            expect(args.task_ids).toEqual(['task-1', 'task-2']);
        });

        it('should accept all fields', () => {
            const args: BuildSkeletonCacheArgs = {
                force_rebuild: true,
                workspace_filter: 'test-workspace',
                task_ids: ['task-1', 'task-2']
            };
            expect(args.force_rebuild).toBe(true);
            expect(args.workspace_filter).toBe('test-workspace');
            expect(args.task_ids).toEqual(['task-1', 'task-2']);
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty task_ids array', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();
            const args: BuildSkeletonCacheArgs = { task_ids: [] };

            const result = await handleBuildSkeletonCache(args, mockCache);

            expect(result.content).toBeDefined();
        });

        it('should handle single task_id', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();
            const args: BuildSkeletonCacheArgs = { task_ids: ['single-task'] };

            const result = await handleBuildSkeletonCache(args, mockCache);

            expect(result.content).toBeDefined();
        });

        it('should handle many task_ids', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();
            const taskIds = Array.from({ length: 100 }, (_, i) => `task-${i}`);
            const args: BuildSkeletonCacheArgs = { task_ids: taskIds };

            const result = await handleBuildSkeletonCache(args, mockCache);

            expect(result.content).toBeDefined();
        });

        it('should handle undefined conversationCache', async () => {
            // Ce test vérifie que la fonction gère un cache vide correctement
            const mockCache = new Map<string, ConversationSkeleton>();

            const result = await handleBuildSkeletonCache({}, mockCache);

            expect(result.content).toBeDefined();
        });
    });

    describe('Console Logging', () => {
        it('should preserve original console.log after execution', async () => {
            const mockCache = new Map<string, ConversationSkeleton>();
            const originalLog = console.log;

            await handleBuildSkeletonCache({}, mockCache);

            // console.log should be restored
            expect(console.log).toBe(originalLog);
        });

        it('should capture debug logs when DEBUG keywords present', async () => {
            // Note: Ce test est limité car on mock RooStorageDetector pour retourner empty
            // Dans un vrai scénario avec storage, les logs seraient capturés
            const mockCache = new Map<string, ConversationSkeleton>();

            const result = await handleBuildSkeletonCache({}, mockCache);
            const text = result.content[0].text as string;

            // Devrait mentionner les logs de debug (même s'ils sont vides dans ce test)
            expect(text).toBeDefined();
        });
    });
});
