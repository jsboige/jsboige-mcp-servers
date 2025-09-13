import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { TaskNavigator } from '../src/services/task-navigator.js';
// Mock du cache manager global
jest.mock('../src/utils/cache-manager', () => ({
    globalCacheManager: {
        get: jest.fn(),
        set: jest.fn(),
        clear: jest.fn(),
    },
}));
// Helper pour créer des données de test
const createMockConversation = (taskId, parentTaskId, title) => ({
    taskId,
    parentTaskId,
    metadata: {
        title: title || `Task ${taskId}`,
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        messageCount: 10,
        actionCount: 5,
        totalSize: 2048,
    },
    sequence: [], // Séquence vide pour les tests de navigation
});
describe('TaskNavigator', () => {
    let taskNavigator;
    let cache;
    beforeEach(() => {
        cache = new Map();
        taskNavigator = new TaskNavigator(cache);
        jest.clearAllMocks();
    });
    // Données de test
    const rootTask = createMockConversation('root');
    const child1Task = createMockConversation('child1', 'root');
    const child2Task = createMockConversation('child2', 'root');
    const grandchild1Task = createMockConversation('grandchild1', 'child1');
    // Configuration des mocks du cache
    const setupCacheMocks = () => {
        cache.set('root', rootTask);
        cache.set('child1', child1Task);
        cache.set('child2', child2Task);
        cache.set('grandchild1', grandchild1Task);
    };
    describe('getTaskParent', () => {
        beforeEach(setupCacheMocks);
        it('should return the parent task when parentTaskId exists', async () => {
            const parent = await taskNavigator.getTaskParent('child1');
            expect(parent).toEqual(rootTask);
        });
        it('should return null if the task has no parentTaskId', async () => {
            const parent = await taskNavigator.getTaskParent('root');
            expect(parent).toBeNull();
        });
        it('should return null if the task does not exist', async () => {
            const parent = await taskNavigator.getTaskParent('non-existent');
            expect(parent).toBeNull();
        });
        it('should return null if the parent task does not exist in cache', async () => {
            const orphanTask = createMockConversation('orphan', 'non-existent-parent');
            // Le mock principal gère déjà ce cas s'il ne trouve pas la clé.
            // On s'assure juste que 'non-existent-parent' n'est pas dans le mock
            cache.set('orphan', orphanTask);
            const parent = await taskNavigator.getTaskParent('orphan');
            expect(parent).toBeNull();
        });
    });
    describe('getTaskChildren', () => {
        beforeEach(setupCacheMocks);
        it('should return direct children of a task', async () => {
            const children = await taskNavigator.getTaskChildren('root');
            expect(children).toHaveLength(2);
            expect(children).toContainEqual(child1Task);
            expect(children).toContainEqual(child2Task);
        });
        it('should return an empty array for a task with no children', async () => {
            const children = await taskNavigator.getTaskChildren('grandchild1');
            expect(children).toHaveLength(0);
        });
        it('should return an empty array if the children index is empty or null', async () => {
            const children = await taskNavigator.getTaskChildren('task-with-empty-index');
            expect(children).toHaveLength(0);
        });
    });
    describe('getTaskTree', () => {
        beforeEach(setupCacheMocks);
        it('should build a complete task tree from a root taskId', async () => {
            const tree = await taskNavigator.getTaskTree('root');
            expect(tree).not.toBeNull();
            expect(tree?.taskId).toBe('root');
            expect(tree?.children).toHaveLength(2);
            const child1Node = tree?.children.find((c) => c.taskId === 'child1');
            const child2Node = tree?.children.find((c) => c.taskId === 'child2');
            expect(child1Node).toBeDefined();
            expect(child2Node).toBeDefined();
            expect(child1Node?.children).toHaveLength(1);
            expect(child1Node?.children[0].taskId).toBe('grandchild1');
            expect(child1Node?.children[0].children).toEqual([]);
            expect(child2Node?.children).toEqual([]);
        });
        it('should return a tree with a single node if the task has no children', async () => {
            const tree = await taskNavigator.getTaskTree('grandchild1');
            expect(tree).not.toBeNull();
            expect(tree?.taskId).toBe('grandchild1');
            expect(tree?.children).toEqual([]);
        });
        it('should return null if the root task is not found', async () => {
            const tree = await taskNavigator.getTaskTree('non-existent-root');
            expect(tree).toBeNull();
        });
    });
});
//# sourceMappingURL=task-navigator.test.js.map