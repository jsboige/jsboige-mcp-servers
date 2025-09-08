import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { RooStateManagerServer } from '../src/index.js';
import { ConversationSkeleton } from '../src/types/conversation.js';


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
    let server: RooStateManagerServer;

    beforeEach(() => {
        server = new RooStateManagerServer();
        const mockCache = new Map<string, ConversationSkeleton>();
        const root = createMockSkeleton('root', undefined, 'Root Task', '2025-01-01T10:00:00Z', 'root content');
        const child1 = createMockSkeleton('child1', 'root', 'Child 1', '2025-01-01T11:00:00Z', 'child1 content');
        const child2 = createMockSkeleton('child2', 'root', 'Child 2', '2025-01-01T12:00:00Z', 'child2 content');
        const grandchild1 = createMockSkeleton('grandchild1', 'child1', 'Grandchild 1', '2025-01-01T11:30:00Z', 'grandchild content');
        mockCache.set('root', root);
        mockCache.set('child1', child1);
        mockCache.set('child2', child2);
        mockCache.set('grandchild1', grandchild1);
        // @ts-ignore - Remplacer le cache privé pour le test
        server['conversationCache'] = mockCache;
    });

    it('should display a single task in single mode', () => {
        // @ts-ignore
        const result = server['handleViewConversationTree']({ task_id: 'child1', view_mode: 'single' });
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        expect(textContent).toContain('Task: Child 1 (ID: child1)');
        expect(textContent).not.toContain('Task: Root Task');
    });

    it('should display the task and its parent in chain mode', () => {
        // @ts-ignore
        const result = server['handleViewConversationTree']({ task_id: 'grandchild1', view_mode: 'chain' });
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        expect(textContent).toContain('Task: Root Task');
        expect(textContent).toContain('Task: Child 1');
        expect(textContent).toContain('Task: Grandchild 1');
    });

    it('should automatically select the latest task if no task_id is provided', () => {
        // @ts-ignore
        const result = server['handleViewConversationTree']({});
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        // Child 2 is the latest
        expect(textContent).toContain('Task: Child 2');
    });

    it('should truncate long content when max_output_length is exceeded', () => {
        const longContent = 'line\n'.repeat(50);
        // @ts-ignore
        server['conversationCache'].set('long_task', createMockSkeleton('long_task', undefined, 'Long Task', '2025-01-02T00:00:00Z', longContent));
        
        // @ts-ignore
        const result = server['handleViewConversationTree']({ task_id: 'long_task', max_output_length: 200 });
        const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
        
        expect(textContent).toContain('[...]');
        expect(textContent).toContain('Sortie estimée');
    });
});