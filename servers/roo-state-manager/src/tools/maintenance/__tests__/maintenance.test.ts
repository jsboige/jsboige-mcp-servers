/**
 * Tests pour l'outil consolidé maintenance (CONS-13)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// Define mock functions at top level
const mockHandleBuildSkeletonCache = vi.fn();
const mockDiagnoseHandler = vi.fn();
const mockRepairHandler = vi.fn();

vi.mock('../../cache/build-skeleton-cache.tool.js', () => ({
    handleBuildSkeletonCache: mockHandleBuildSkeletonCache
}));

vi.mock('../../repair/diagnose-conversation-bom.tool.js', () => ({
    diagnoseConversationBomTool: {
        handler: mockDiagnoseHandler
    }
}));

vi.mock('../../repair/repair-conversation-bom.tool.js', () => ({
    repairConversationBomTool: {
        handler: mockRepairHandler
    }
}));

describe('maintenance tool (CONS-13)', () => {
    let handleMaintenance: typeof import('../maintenance.js').handleMaintenance;
    let maintenanceToolDefinition: typeof import('../maintenance.js').maintenanceToolDefinition;
    let mockConversationCache: Map<string, ConversationSkeleton>;

    beforeEach(async () => {
        vi.clearAllMocks();

        // Re-setup mock return values
        mockHandleBuildSkeletonCache.mockResolvedValue({
            content: [{ type: 'text', text: 'Cache rebuilt successfully' }]
        });
        mockDiagnoseHandler.mockResolvedValue({
            content: [{ type: 'text', text: '# Diagnostic BOM\n\n**Fichiers analysés:** 10\n**Fichiers corrompus:** 0' }]
        });
        mockRepairHandler.mockResolvedValue({
            content: [{ type: 'text', text: '# Réparation BOM\n\n**Fichiers réparés:** 0' }]
        });

        const mod = await import('../maintenance.js');
        handleMaintenance = mod.handleMaintenance;
        maintenanceToolDefinition = mod.maintenanceToolDefinition;
        mockConversationCache = new Map();
    });

    describe('Tool definition', () => {
        test('should have correct name', () => {
            expect(maintenanceToolDefinition.name).toBe('maintenance');
        });

        test('should have description', () => {
            expect(maintenanceToolDefinition.description).toBeTruthy();
        });

        test('should require action parameter', () => {
            expect(maintenanceToolDefinition.inputSchema.required).toContain('action');
        });

        test('should have action enum with all 3 actions', () => {
            const actionProp = maintenanceToolDefinition.inputSchema.properties.action as any;
            expect(actionProp.enum).toContain('cache_rebuild');
            expect(actionProp.enum).toContain('diagnose_bom');
            expect(actionProp.enum).toContain('repair_bom');
        });

        test('should have cache-specific optional properties', () => {
            const props = maintenanceToolDefinition.inputSchema.properties;
            expect(props.force_rebuild).toBeDefined();
            expect(props.workspace_filter).toBeDefined();
            expect(props.task_ids).toBeDefined();
        });

        test('should have BOM-specific optional properties', () => {
            const props = maintenanceToolDefinition.inputSchema.properties;
            expect(props.fix_found).toBeDefined();
            expect(props.dry_run).toBeDefined();
        });
    });

    describe('action=cache_rebuild', () => {
        test('should delegate to handleBuildSkeletonCache', async () => {
            const result = await handleMaintenance(
                { action: 'cache_rebuild' },
                mockConversationCache
            );

            expect(mockHandleBuildSkeletonCache).toHaveBeenCalledWith(
                { force_rebuild: undefined, workspace_filter: undefined, task_ids: undefined },
                mockConversationCache,
                undefined
            );
            expect(result.content[0]).toHaveProperty('type', 'text');
            expect((result.content[0] as any).text).toContain('Cache rebuilt');
        });

        test('should pass force_rebuild option', async () => {
            await handleMaintenance(
                { action: 'cache_rebuild', force_rebuild: true },
                mockConversationCache
            );

            expect(mockHandleBuildSkeletonCache).toHaveBeenCalledWith(
                expect.objectContaining({ force_rebuild: true }),
                mockConversationCache,
                undefined
            );
        });

        test('should pass workspace_filter option', async () => {
            await handleMaintenance(
                { action: 'cache_rebuild', workspace_filter: '/test/workspace' },
                mockConversationCache
            );

            expect(mockHandleBuildSkeletonCache).toHaveBeenCalledWith(
                expect.objectContaining({ workspace_filter: '/test/workspace' }),
                mockConversationCache,
                undefined
            );
        });

        test('should pass task_ids option', async () => {
            await handleMaintenance(
                { action: 'cache_rebuild', task_ids: ['task1', 'task2'] },
                mockConversationCache
            );

            expect(mockHandleBuildSkeletonCache).toHaveBeenCalledWith(
                expect.objectContaining({ task_ids: ['task1', 'task2'] }),
                mockConversationCache,
                undefined
            );
        });
    });

    describe('action=diagnose_bom', () => {
        test('should delegate to diagnoseConversationBomTool handler', async () => {
            const result = await handleMaintenance(
                { action: 'diagnose_bom' },
                mockConversationCache
            );

            expect(mockDiagnoseHandler).toHaveBeenCalledWith({
                fix_found: undefined
            });
            expect((result.content[0] as any).text).toContain('Diagnostic BOM');
        });

        test('should pass fix_found option', async () => {
            await handleMaintenance(
                { action: 'diagnose_bom', fix_found: true },
                mockConversationCache
            );

            expect(mockDiagnoseHandler).toHaveBeenCalledWith({
                fix_found: true
            });
        });
    });

    describe('action=repair_bom', () => {
        test('should delegate to repairConversationBomTool handler', async () => {
            const result = await handleMaintenance(
                { action: 'repair_bom' },
                mockConversationCache
            );

            expect(mockRepairHandler).toHaveBeenCalledWith({
                dry_run: undefined
            });
            expect((result.content[0] as any).text).toContain('Réparation BOM');
        });

        test('should pass dry_run option', async () => {
            await handleMaintenance(
                { action: 'repair_bom', dry_run: true },
                mockConversationCache
            );

            expect(mockRepairHandler).toHaveBeenCalledWith({
                dry_run: true
            });
        });
    });

    describe('invalid action', () => {
        test('should return error for unknown action', async () => {
            const result = await handleMaintenance(
                { action: 'unknown' as any },
                mockConversationCache
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('Action inconnue');
        });
    });
});
