import { describe, it, expect, beforeEach, vi } from 'vitest';
import { viewConversationTree } from '../../../src/tools/view-conversation-tree.js';
import { ConversationSkeleton } from '../../../src/types/conversation.js';

// Mock fs (promises as fs)
vi.mock('fs', () => {
    const mockWriteFile = vi.fn();
    const mockMkdir = vi.fn();
    return {
        promises: {
            writeFile: mockWriteFile,
            mkdir: mockMkdir,
        },
    };
});

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
    let mockWriteFile: any;
    let mockMkdir: any;

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
        
        // Récupérer les mocks fs
        const fsModule: any = await vi.importMock('fs');
        mockWriteFile = fsModule.promises.writeFile;
        mockMkdir = fsModule.promises.mkdir;
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

    it('should truncate long content when max_output_length is exceeded', async () => {
        const longContent = 'line\n'.repeat(50);
        mockCache.set('long_task', createMockSkeleton('long_task', undefined, 'Long Task', '2025-01-02T00:00:00Z', longContent));
        
        const result = await viewConversationTree.handler({ task_id: 'long_task', max_output_length: 200 }, mockCache);
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        expect(textContent).toContain('[...]');
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
});
