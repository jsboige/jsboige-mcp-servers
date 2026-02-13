/**
 * Tests unitaires pour l'outil conversation_browser (CONS-X #457)
 *
 * Consolide task_browse + view_conversation_tree + roosync_summarize → 1 outil
 *
 * Tests:
 * - Validation du paramètre action (requis, valeurs valides)
 * - Validation des paramètres spécifiques par action
 * - Dispatch correct vers chaque handler sous-jacent
 * - Gestion des erreurs
 */

import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import {
    conversationBrowserTool,
    handleConversationBrowser,
    ConversationBrowserArgs,
    ConversationBrowserAction
} from '../../../../src/tools/conversation/conversation-browser.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';

// Mock des handlers sous-jacents
vi.mock('../../../../src/tools/task/browse.js', () => ({
    handleTaskBrowse: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"action":"tree","dispatched":true}' }]
    })
}));

vi.mock('../../../../src/tools/view-conversation-tree.js', () => ({
    viewConversationTree: {
        name: 'view_conversation_tree',
        handler: vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'Conversation Tree (Mode: chain)' }]
        })
    }
}));

vi.mock('../../../../src/tools/summary/roosync-summarize.tool.js', () => ({
    handleRooSyncSummarize: vi.fn().mockResolvedValue('# Summary Result\nTrace summary content'),
    roosyncSummarizeTool: {
        name: 'roosync_summarize',
        description: 'mock',
        inputSchema: { type: 'object', properties: {}, required: [] }
    }
}));

// Import des mocks pour assertions
import { handleTaskBrowse } from '../../../../src/tools/task/browse.js';
import { viewConversationTree } from '../../../../src/tools/view-conversation-tree.js';
import { handleRooSyncSummarize } from '../../../../src/tools/summary/roosync-summarize.tool.js';

describe('conversation_browser - CONS-X (#457)', () => {
    let mockCache: Map<string, ConversationSkeleton>;
    let mockEnsureCache: Mock;
    let mockGetSkeleton: Mock;
    let mockFindChildTasks: Mock;

    beforeEach(() => {
        vi.clearAllMocks();
        // Re-setup mock implementations after clearAllMocks
        (handleTaskBrowse as Mock).mockResolvedValue({
            content: [{ type: 'text', text: '{"action":"tree","dispatched":true}' }]
        });
        (viewConversationTree.handler as Mock).mockResolvedValue({
            content: [{ type: 'text', text: 'Conversation Tree (Mode: chain)' }]
        });
        (handleRooSyncSummarize as Mock).mockResolvedValue('# Summary Result\nTrace summary content');

        mockCache = new Map();
        mockEnsureCache = vi.fn().mockResolvedValue(undefined);
        mockGetSkeleton = vi.fn().mockResolvedValue(null);
        mockFindChildTasks = vi.fn().mockResolvedValue([]);
    });

    // ===== Définition de l'outil =====

    describe('Définition de l\'outil', () => {
        it('devrait avoir le nom correct', () => {
            expect(conversationBrowserTool.name).toBe('conversation_browser');
        });

        it('devrait avoir les 4 actions dans le schema', () => {
            const actionProp = (conversationBrowserTool.inputSchema as any).properties.action;
            expect(actionProp.enum).toEqual(['tree', 'current', 'view', 'summarize']);
        });

        it('devrait avoir action comme seul champ requis', () => {
            expect((conversationBrowserTool.inputSchema as any).required).toEqual(['action']);
        });

        it('devrait contenir les paramètres des 3 outils originaux', () => {
            const props = Object.keys((conversationBrowserTool.inputSchema as any).properties);
            // Paramètres de task_browse
            expect(props).toContain('conversation_id');
            expect(props).toContain('max_depth');
            expect(props).toContain('show_metadata');
            // Paramètres de view_conversation_tree
            expect(props).toContain('task_id');
            expect(props).toContain('view_mode');
            expect(props).toContain('smart_truncation');
            // Paramètres de roosync_summarize
            expect(props).toContain('summarize_type');
            expect(props).toContain('taskId');
            expect(props).toContain('clusterMode');
        });
    });

    // ===== Validation des arguments =====

    describe('Validation des arguments', () => {
        it('devrait rejeter si action est manquant', async () => {
            const result = await handleConversationBrowser(
                {} as any,
                mockCache,
                mockEnsureCache
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('action');
        });

        it('devrait rejeter si action est invalide', async () => {
            const result = await handleConversationBrowser(
                { action: 'invalid' as any },
                mockCache,
                mockEnsureCache
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('invalide');
        });

        it('devrait rejeter action=tree sans conversation_id', async () => {
            const result = await handleConversationBrowser(
                { action: 'tree' },
                mockCache,
                mockEnsureCache
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('conversation_id');
        });

        it('devrait rejeter action=summarize sans summarize_type', async () => {
            const result = await handleConversationBrowser(
                { action: 'summarize', taskId: 'test-123' } as ConversationBrowserArgs,
                mockCache,
                mockEnsureCache
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('summarize_type');
        });

        it('devrait rejeter action=summarize sans taskId ni task_id', async () => {
            const result = await handleConversationBrowser(
                { action: 'summarize', summarize_type: 'trace' } as ConversationBrowserArgs,
                mockCache,
                mockEnsureCache
            );
            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('taskId');
        });

        it('devrait accepter action=current sans paramètres supplémentaires', async () => {
            const result = await handleConversationBrowser(
                { action: 'current' },
                mockCache,
                mockEnsureCache
            );
            expect(result.isError).toBeUndefined();
        });

        it('devrait accepter action=view sans paramètres supplémentaires', async () => {
            const result = await handleConversationBrowser(
                { action: 'view' },
                mockCache,
                mockEnsureCache
            );
            expect(result.isError).toBeUndefined();
        });
    });

    // ===== Dispatch action=tree =====

    describe('Dispatch action=tree', () => {
        it('devrait dispatcher vers handleTaskBrowse avec action=tree', async () => {
            await handleConversationBrowser(
                {
                    action: 'tree',
                    conversation_id: 'test-conv-123',
                    max_depth: 5,
                    show_metadata: true,
                    output_format: 'ascii-tree'
                },
                mockCache,
                mockEnsureCache,
                '/workspace'
            );

            expect(handleTaskBrowse).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'tree',
                    conversation_id: 'test-conv-123',
                    max_depth: 5,
                    show_metadata: true,
                    output_format: 'ascii-tree'
                }),
                mockCache,
                mockEnsureCache,
                '/workspace'
            );
        });

        it('devrait retourner le résultat de handleTaskBrowse', async () => {
            const result = await handleConversationBrowser(
                { action: 'tree', conversation_id: 'test-123' },
                mockCache,
                mockEnsureCache
            );

            expect((result.content[0] as any).text).toContain('dispatched');
        });
    });

    // ===== Dispatch action=current =====

    describe('Dispatch action=current', () => {
        it('devrait dispatcher vers handleTaskBrowse avec action=current', async () => {
            await handleConversationBrowser(
                { action: 'current', workspace: '/my/workspace' },
                mockCache,
                mockEnsureCache,
                '/context'
            );

            expect(handleTaskBrowse).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'current',
                    workspace: '/my/workspace'
                }),
                mockCache,
                mockEnsureCache,
                '/context'
            );
        });
    });

    // ===== Dispatch action=view =====

    describe('Dispatch action=view', () => {
        it('devrait dispatcher vers viewConversationTree.handler', async () => {
            await handleConversationBrowser(
                {
                    action: 'view',
                    task_id: 'task-456',
                    view_mode: 'cluster',
                    detail_level: 'summary',
                    smart_truncation: true,
                    max_output_length: 50000
                },
                mockCache,
                mockEnsureCache
            );

            expect(viewConversationTree.handler).toHaveBeenCalledWith(
                expect.objectContaining({
                    task_id: 'task-456',
                    view_mode: 'cluster',
                    detail_level: 'summary',
                    smart_truncation: true,
                    max_output_length: 50000
                }),
                mockCache
            );
        });

        it('devrait retourner le résultat de viewConversationTree', async () => {
            const result = await handleConversationBrowser(
                { action: 'view', task_id: 'test-789' },
                mockCache,
                mockEnsureCache
            );

            expect((result.content[0] as any).text).toContain('Conversation Tree');
        });
    });

    // ===== Dispatch action=summarize =====

    describe('Dispatch action=summarize', () => {
        it('devrait dispatcher vers handleRooSyncSummarize avec args convertis', async () => {
            await handleConversationBrowser(
                {
                    action: 'summarize',
                    summarize_type: 'trace',
                    taskId: 'task-sum-123',
                    source: 'roo',
                    summarize_output_format: 'html',
                    detailLevel: 'NoTools'
                },
                mockCache,
                mockEnsureCache,
                undefined,
                mockGetSkeleton,
                mockFindChildTasks
            );

            expect(handleRooSyncSummarize).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'trace',
                    taskId: 'task-sum-123',
                    source: 'roo',
                    outputFormat: 'html',
                    detailLevel: 'NoTools'
                }),
                mockGetSkeleton,
                mockFindChildTasks
            );
        });

        it('devrait wraper le résultat string en CallToolResult', async () => {
            const result = await handleConversationBrowser(
                {
                    action: 'summarize',
                    summarize_type: 'trace',
                    taskId: 'task-sum-456'
                },
                mockCache,
                mockEnsureCache,
                undefined,
                mockGetSkeleton,
                mockFindChildTasks
            );

            expect(result.isError).toBeUndefined();
            expect((result.content[0] as any).text).toContain('Summary Result');
        });

        it('devrait résoudre taskId depuis task_id si taskId absent', async () => {
            await handleConversationBrowser(
                {
                    action: 'summarize',
                    summarize_type: 'cluster',
                    task_id: 'from-task-id-field',
                    clusterMode: 'detailed'
                } as ConversationBrowserArgs,
                mockCache,
                mockEnsureCache,
                undefined,
                mockGetSkeleton,
                mockFindChildTasks
            );

            expect(handleRooSyncSummarize).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'cluster',
                    taskId: 'from-task-id-field',
                    clusterMode: 'detailed'
                }),
                mockGetSkeleton,
                mockFindChildTasks
            );
        });

        it('devrait passer les paramètres cluster correctement', async () => {
            await handleConversationBrowser(
                {
                    action: 'summarize',
                    summarize_type: 'cluster',
                    taskId: 'root-task',
                    childTaskIds: ['child-1', 'child-2'],
                    clusterMode: 'comparative',
                    includeClusterStats: true,
                    crossTaskAnalysis: true,
                    maxClusterDepth: 5,
                    clusterSortBy: 'size',
                    showTaskRelationships: false
                },
                mockCache,
                mockEnsureCache,
                undefined,
                mockGetSkeleton,
                mockFindChildTasks
            );

            expect(handleRooSyncSummarize).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'cluster',
                    taskId: 'root-task',
                    childTaskIds: ['child-1', 'child-2'],
                    clusterMode: 'comparative',
                    includeClusterStats: true,
                    crossTaskAnalysis: true,
                    maxClusterDepth: 5,
                    clusterSortBy: 'size',
                    showTaskRelationships: false
                }),
                mockGetSkeleton,
                mockFindChildTasks
            );
        });
    });

    // ===== Isolation des actions =====

    describe('Isolation des dispatches', () => {
        it('action=tree ne devrait PAS appeler view ou summarize', async () => {
            await handleConversationBrowser(
                { action: 'tree', conversation_id: 'test' },
                mockCache,
                mockEnsureCache
            );

            expect(handleTaskBrowse).toHaveBeenCalled();
            expect(viewConversationTree.handler).not.toHaveBeenCalled();
            expect(handleRooSyncSummarize).not.toHaveBeenCalled();
        });

        it('action=view ne devrait PAS appeler task_browse ou summarize', async () => {
            await handleConversationBrowser(
                { action: 'view' },
                mockCache,
                mockEnsureCache
            );

            expect(viewConversationTree.handler).toHaveBeenCalled();
            expect(handleTaskBrowse).not.toHaveBeenCalled();
            expect(handleRooSyncSummarize).not.toHaveBeenCalled();
        });

        it('action=summarize ne devrait PAS appeler task_browse ou view', async () => {
            await handleConversationBrowser(
                { action: 'summarize', summarize_type: 'trace', taskId: 'x' },
                mockCache,
                mockEnsureCache,
                undefined,
                mockGetSkeleton,
                mockFindChildTasks
            );

            expect(handleRooSyncSummarize).toHaveBeenCalled();
            expect(handleTaskBrowse).not.toHaveBeenCalled();
            expect(viewConversationTree.handler).not.toHaveBeenCalled();
        });
    });

    // ===== Gestion des erreurs =====

    describe('Gestion des erreurs', () => {
        it('devrait retourner isError=true si le handler sous-jacent throw', async () => {
            (handleTaskBrowse as Mock).mockRejectedValueOnce(new Error('Connection timeout'));

            const result = await handleConversationBrowser(
                { action: 'tree', conversation_id: 'fail-test' },
                mockCache,
                mockEnsureCache
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('Connection timeout');
        });

        it('devrait retourner isError=true si summarize throw', async () => {
            (handleRooSyncSummarize as Mock).mockRejectedValueOnce(new Error('Skeleton not found'));

            const result = await handleConversationBrowser(
                { action: 'summarize', summarize_type: 'trace', taskId: 'missing' },
                mockCache,
                mockEnsureCache,
                undefined,
                mockGetSkeleton,
                mockFindChildTasks
            );

            expect(result.isError).toBe(true);
            expect((result.content[0] as any).text).toContain('Skeleton not found');
        });
    });
});
