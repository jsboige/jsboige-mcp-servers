import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { viewConversationTree } from '../../../src/tools/view-conversation-tree.js';
import { ConversationSkeleton } from '../../../src/types/conversation.js';
import { ClaudeStorageDetector } from '../../../src/utils/claude-storage-detector.js';

// Mock fs (promises as fs) - use vi.hoisted to create mock references before mock definition
const { mockWriteFile, mockMkdir } = vi.hoisted(() => ({
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs', () => ({
    promises: {
        writeFile: mockWriteFile,
        mkdir: mockMkdir,
    },
}));

const createMockSkeleton = (taskId: string, parentTaskId?: string, title?: string, lastActivity?: string, sequenceContent: string = ''): ConversationSkeleton => ({
    taskId,
    parentTaskId,
    metadata: {
        title: title || `Task ${taskId}`,
        lastActivity: lastActivity || new Date().toISOString(),
        createdAt: new Date().toISOString(),
        messageCount: 1,
        actionCount: 0,
        totalSize: 100,
    },
    sequence: [{ role: 'user', content: sequenceContent, timestamp: new Date().toISOString(), isTruncated: false }],
});

describe('view_conversation_tree Tool', () => {
    let mockCache: Map<string, ConversationSkeleton>;

    beforeEach(async () => {
        mockCache = new Map<string, ConversationSkeleton>();
        const root = createMockSkeleton('root', undefined, 'Root Task', '2025-01-01T10:00:00Z', 'root content');
        const child1 = createMockSkeleton('child1', 'root', 'Child 1', '2025-01-01T11:00:00Z', 'child1 content');
        const child2 = createMockSkeleton('child2', 'root', 'Child 2', '2025-01-01T12:00:00Z', 'child2 content');
        const grandchild1 = createMockSkeleton('grandchild1', 'child1', 'Grandchild 1', '2025-01-01T11:30:00Z', 'grandchild content');
        mockCache.set('root', root);
        mockCache.set('child1', child1);
        mockCache.set('child2', child2);
        mockCache.set('grandchild1', grandchild1);

        vi.clearAllMocks();
    });

    it('should display a single task in single mode', async () => {
        const result = await viewConversationTree.handler({ task_id: 'child1', view_mode: 'single' }, mockCache);
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        expect(textContent).toContain('Task: Child 1 (ID: child1)');
        expect(textContent).not.toContain('Task: Root Task');
    });

    it('should display task and its parent in chain mode', async () => {
        const result = await viewConversationTree.handler({ task_id: 'grandchild1', view_mode: 'chain' }, mockCache);
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        expect(textContent).toContain('Task: Root Task');
        expect(textContent).toContain('Task: Child 1');
        expect(textContent).toContain('Task: Grandchild 1');
    });

    it('should automatically select latest task if no task_id is provided', async () => {
        const result = await viewConversationTree.handler({}, mockCache);
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        // Child 2 is latest
        expect(textContent).toContain('Task: Child 2');
    });

    it('should truncate long content via legacy path when smart_truncation is explicitly disabled', async () => {
        // #901: skeleton snippet increased from 50→300 chars, so content must exceed 300 chars
        // #1244 Couche 2.5: smart_truncation now defaults to true; this test explicitly opts into
        // the legacy path via smart_truncation: false to preserve coverage of its 'Sortie estimée'
        // marker. max_output_length must be large enough to fit within the hard-cap header window
        // (2000 chars preserved) so the legacy marker is not clipped by the final safety net.
        const longContent = 'This is a long line of content for testing truncation behavior.\n'.repeat(50);
        mockCache.set('long_task', createMockSkeleton('long_task', undefined, 'Long Task', '2025-01-02T00:00:00Z', longContent));

        const result = await viewConversationTree.handler({ task_id: 'long_task', max_output_length: 1500, smart_truncation: false }, mockCache);
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';

        // Mode skeleton uses substring(0, 300) + '...' for content > 300 chars
        // Legacy truncation adds 'Sortie estimée' when output exceeds max_output_length
        const hasTruncationMarker = textContent.includes('[...]') || textContent.includes('...');
        expect(hasTruncationMarker).toBe(true);
        expect(textContent).toContain('Sortie estimée');
    });

    it('should respect detail_level skeleton mode', async () => {
        // Ajouter une action mockée pour tester le comportement skeleton
        const taskWithAction = createMockSkeleton('task_with_action', undefined, 'Task With Action', '2025-01-01T10:00:00Z', 'test content');
        taskWithAction.sequence.push({
            type: 'command',
            name: 'test_tool',
            status: 'success',
            timestamp: '2025-01-01T10:01:00Z',
            parameters: { param1: 'value1', param2: 'value2' }
        });
        mockCache.set('task_with_action', taskWithAction);

        const result = await viewConversationTree.handler({ task_id: 'task_with_action', detail_level: 'skeleton' }, mockCache);
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        expect(textContent).toContain('Detail: skeleton');
        expect(textContent).toContain('test_tool] → success');
        // En mode skeleton, les paramètres ne doivent pas être affichés
        expect(textContent).not.toContain('Params:');
    });

    it('should respect detail_level summary mode', async () => {
        // Ajouter une action mockée pour tester le comportement summary
        const taskWithAction = createMockSkeleton('task_with_action', undefined, 'Task With Action', '2025-01-01T10:00:00Z', 'test content');
        taskWithAction.sequence.push({
            type: 'command',
            name: 'test_tool',
            status: 'success',
            timestamp: '2025-01-01T10:01:00Z',
            parameters: { param1: 'value1', param2: 'value2' }
        });
        mockCache.set('task_with_action', taskWithAction);

        const result = await viewConversationTree.handler({ task_id: 'task_with_action', detail_level: 'summary' }, mockCache);
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        expect(textContent).toContain('Detail: summary');
        expect(textContent).toContain('test_tool] → success');
        // En mode summary, les paramètres doivent être affichés
        expect(textContent).toContain('Params:');
        expect(textContent).toContain('param1');
    });

    it('should respect detail_level full mode', async () => {
        // Ajouter une action mockée pour tester le comportement full
        const taskWithAction = createMockSkeleton('task_with_action', undefined, 'Task With Action', '2025-01-01T10:00:00Z', 'test content');
        taskWithAction.sequence.push({
            type: 'command',
            name: 'test_tool',
            status: 'success',
            timestamp: '2025-01-01T10:01:00Z',
            parameters: { param1: 'value1', param2: 'value2' },
            content_size: 150,
            line_count: 5
        });
        mockCache.set('task_with_action', taskWithAction);

        const result = await viewConversationTree.handler({ task_id: 'task_with_action', detail_level: 'full' }, mockCache);
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        expect(textContent).toContain('Detail: full');
        expect(textContent).toContain('test_tool] → success');
        // En mode full, les paramètres et les métadonnées doivent être affichés
        expect(textContent).toContain('Params:');
        expect(textContent).toContain('Content Size: 150');
        expect(textContent).toContain('Line Count: 5');
    });

    it('should handle cluster mode correctly', async () => {
        const result = await viewConversationTree.handler({ task_id: 'child1', view_mode: 'cluster' }, mockCache);
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        expect(textContent).toContain('Mode: cluster');
        expect(textContent).toContain('Task: Root Task'); // Parent
        expect(textContent).toContain('Task: Child 1'); // Target task
        expect(textContent).toContain('Task: Child 2'); // Sibling
    });

    it('should save to file when output_file is provided', async () => {
        mockMkdir.mockResolvedValue(undefined);
        mockWriteFile.mockResolvedValue(undefined);
        
        const result = await viewConversationTree.handler({ task_id: 'child1', output_file: '/test/output.md' }, mockCache);
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        expect(mockMkdir).toHaveBeenCalled();
        expect(mockWriteFile).toHaveBeenCalled();
        expect(textContent).toContain('sauvegardé');
    });

    it('should throw error for non-existent task', async () => {
        try {
            await viewConversationTree.handler({ task_id: 'non_existent' }, mockCache);
            throw new Error('Expected error to be thrown');
        } catch (error: any) {
            expect(error.message).toContain("Task with ID 'non_existent' not found in cache.");
        }
    });

    it('should throw error when cache is empty and no task_id provided', async () => {
        const emptyCache = new Map<string, ConversationSkeleton>();

        try {
            await viewConversationTree.handler({}, emptyCache);
            throw new Error('Expected error to be thrown');
        } catch (error: any) {
            expect(error.message).toContain("Cache is empty and no task_id was provided. Cannot determine latest task.");
        }
    });

    // =========================================================================
    // #1244 — Pipeline repair (couches 2.5, 2.6, 2.7)
    // =========================================================================
    describe('#1244 — pipeline repair', () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        // --- Couche 2.5: smart_truncation defaults to true --------------------
        it('[#1244 2.5] smart_truncation defaults to true (no Sortie estimée marker from smart path)', async () => {
            const longContent = 'Line of detailed content for default-smart-path assertion.\n'.repeat(200);
            mockCache.set('smart_default_task', createMockSkeleton(
                'smart_default_task',
                undefined,
                'Smart Default Task',
                '2025-01-02T00:00:00Z',
                longContent,
            ));

            // No explicit smart_truncation flag → should go through smart path
            const result = await viewConversationTree.handler(
                { task_id: 'smart_default_task', max_output_length: 8000 },
                mockCache,
            );
            const textContent = result.content[0].type === 'text' ? result.content[0].text : '';

            // Legacy marker MUST NOT be present
            expect(textContent).not.toContain('Sortie estimée');
            // Task header should still be present
            expect(textContent).toContain('Smart Default Task');
        });

        // --- Couche 2.5: hard cap enforces max_output_length ------------------
        it('[#1244 2.5] hard cap enforces max_output_length even with long content', async () => {
            // Build a very long skeleton that would otherwise blow past 8 KB
            const hugeContent = 'word '.repeat(30_000); // ~150 KB of content
            mockCache.set('huge_task', createMockSkeleton(
                'huge_task',
                undefined,
                'Huge Task',
                '2025-01-02T00:00:00Z',
                hugeContent,
            ));

            const MAX = 8_000;
            const result = await viewConversationTree.handler(
                { task_id: 'huge_task', max_output_length: MAX, detail_level: 'full' },
                mockCache,
            );
            const textContent = result.content[0].type === 'text' ? result.content[0].text : '';

            // Hard cap should clamp total length at or below max_output_length
            // (applyHardCap uses ContentTruncator.hardCapString with headerKeepChars, which
            // guarantees the final string length ≤ max_output_length).
            expect(textContent.length).toBeLessThanOrEqual(MAX);
        });

        // --- Couche 2.6: pagination → messageRange header ---------------------
        it('[#1244 2.6] messageStart/messageEnd return messageRange header with navigation hints', async () => {
            const paginatedTask: ConversationSkeleton = {
                taskId: 'paged_task',
                parentTaskId: undefined,
                metadata: {
                    title: 'Paged Task',
                    lastActivity: '2025-01-02T00:00:00Z',
                    createdAt: '2025-01-02T00:00:00Z',
                    messageCount: 5,
                    actionCount: 0,
                    totalSize: 500,
                },
                sequence: [
                    { role: 'user',      content: 'msg 0', timestamp: '2025-01-02T00:00:00Z', isTruncated: false },
                    { role: 'assistant', content: 'msg 1', timestamp: '2025-01-02T00:01:00Z', isTruncated: false },
                    { role: 'user',      content: 'msg 2', timestamp: '2025-01-02T00:02:00Z', isTruncated: false },
                    { role: 'assistant', content: 'msg 3', timestamp: '2025-01-02T00:03:00Z', isTruncated: false },
                    { role: 'user',      content: 'msg 4', timestamp: '2025-01-02T00:04:00Z', isTruncated: false },
                ],
            };
            mockCache.set('paged_task', paginatedTask);

            const result = await viewConversationTree.handler(
                { task_id: 'paged_task', messageStart: 1, messageEnd: 3, view_mode: 'single' },
                mockCache,
            );
            const textContent = result.content[0].type === 'text' ? result.content[0].text : '';

            // Should include the messageRange metadata header from injectMessageRangeMetadata
            expect(textContent).toContain('messageRange:');
            expect(textContent).toContain('start: 1');
            expect(textContent).toContain('end: 3');
            expect(textContent).toContain('total: 5');
            expect(textContent).toContain('truncated: true');

            // And at least one of the navigation hints (next page or previous page)
            const hasNavHint =
                textContent.includes('messageStart: 3') || // page suivante
                textContent.includes('messageStart: 0');   // debut
            expect(hasNavHint).toBe(true);
        });

        // --- Couche 2.7: Claude task_id dispatches to ClaudeStorageDetector ----
        it('[#1244 2.7] Claude task_id dispatches to ClaudeStorageDetector.analyzeConversation', async () => {
            // Mock Claude storage discovery + conversation loading. Production code uses
            // `await import('../utils/claude-storage-detector.js')` which goes through the
            // Node module cache, so spying on the statically-imported ClaudeStorageDetector
            // intercepts the dynamic-import result as well.
            const detectSpy = vi.spyOn(ClaudeStorageDetector, 'detectStorageLocations').mockResolvedValue([
                {
                    path: '/home/user/.claude/projects/myproject-abc',
                    projectPath: '/home/user/.claude/projects/myproject-abc',
                    globalPath: '/home/user/.claude',
                    sessionFiles: ['session.jsonl'],
                } as any,
            ]);

            const analyzeSpy = vi.spyOn(ClaudeStorageDetector, 'analyzeConversation').mockResolvedValue({
                taskId: 'claude-myproject-abc',
                parentTaskId: undefined,
                metadata: {
                    title: 'Claude Dispatched Task',
                    lastActivity: '2025-01-02T00:00:00Z',
                    createdAt: '2025-01-02T00:00:00Z',
                    messageCount: 1,
                    actionCount: 0,
                    totalSize: 42,
                    source: 'claude-code',
                    dataSource: 'claude',
                } as any,
                sequence: [
                    { role: 'user', content: 'hello from claude session', timestamp: '2025-01-02T00:00:00Z', isTruncated: false },
                ],
            } as any);

            // Inject a shell skeleton in cache with empty sequence but messageCount > 0
            // so the lazy-load branch fires on first handler call.
            const claudeShell: ConversationSkeleton = {
                taskId: 'claude-myproject-abc',
                parentTaskId: undefined,
                metadata: {
                    title: 'Claude Dispatched Task (shell)',
                    lastActivity: '2025-01-02T00:00:00Z',
                    createdAt: '2025-01-02T00:00:00Z',
                    messageCount: 5, // > 0 → triggers lazy load
                    actionCount: 0,
                    totalSize: 0,
                    source: 'claude-code',
                    dataSource: 'claude',
                } as any,
                sequence: [], // empty → triggers lazy load
            };
            mockCache.set('claude-myproject-abc', claudeShell);

            await viewConversationTree.handler(
                { task_id: 'claude-myproject-abc', view_mode: 'single' },
                mockCache,
            );

            expect(detectSpy).toHaveBeenCalled();
            expect(analyzeSpy).toHaveBeenCalledWith(
                'claude-myproject-abc',
                '/home/user/.claude/projects/myproject-abc',
            );
        });
    });
});
