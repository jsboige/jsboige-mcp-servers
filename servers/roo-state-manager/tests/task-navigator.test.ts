import { TaskNavigator, TreeNode } from '../src/services/task-navigator.js';
import { globalCacheManager } from '../src/utils/cache-manager.js';
import { ConversationSummary, TaskMetadata } from '../src/types/conversation.js';
import { TaskMetadataWithParent } from '../src/services/task-navigator.js';

// Mock du cache manager global
jest.mock('../src/utils/cache-manager', () => ({
  globalCacheManager: {
    get: jest.fn(),
    set: jest.fn(),
    clear: jest.fn(),
  },
}));

// Helper pour créer des données de test
const createMockConversation = (
  taskId: string,
  parentTaskId?: string,
  title?: string
): ConversationSummary => ({
  taskId,
  path: `/tasks/${taskId}`,
  metadata: {
    taskId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'active',
    totalMessages: 10,
    title: title || `Task ${taskId}`,
    parentTaskId,
  } as TaskMetadataWithParent,
  messageCount: 10,
  lastActivity: new Date().toISOString(),
  hasApiHistory: true,
  hasUiMessages: true,
  size: 1024,
});

describe('TaskNavigator', () => {
  let taskNavigator: TaskNavigator;
  const mockedCacheGet = globalCacheManager.get as jest.Mock;

  beforeEach(() => {
    // Réinitialiser les mocks avant chaque test
    mockedCacheGet.mockReset();
    jest.clearAllMocks();
    taskNavigator = TaskNavigator.getInstance();
  });

  // Données de test
  const rootTask = createMockConversation('root');
  const child1Task = createMockConversation('child1', 'root');
  const child2Task = createMockConversation('child2', 'root');
  const grandchild1Task = createMockConversation('grandchild1', 'child1');

  // Configuration des mocks du cache
  const setupCacheMocks = () => {
    // Mocks pour les conversations
    mockedCacheGet.mockImplementation(async (key: string) => {
      if (key === 'conversation:root') return rootTask;
      if (key === 'conversation:child1') return child1Task;
      if (key === 'conversation:child2') return child2Task;
      if (key === 'conversation:grandchild1') return grandchild1Task;
      
      // Mocks pour l'index des enfants
      if (key === 'children-index:root') return ['child1', 'child2'];
      if (key === 'children-index:child1') return ['grandchild1'];

      return null;
    });
  };

  describe('getTaskParent', () => {
    beforeEach(setupCacheMocks);

    it('should return the parent task when parentTaskId exists', async () => {
      const parent = await taskNavigator.getTaskParent('child1');
      expect(parent).toEqual(rootTask);
      expect(mockedCacheGet).toHaveBeenCalledWith('conversation:child1');
      expect(mockedCacheGet).toHaveBeenCalledWith('conversation:root');
    });

    it('should return null if the task has no parentTaskId', async () => {
      const parent = await taskNavigator.getTaskParent('root');
      expect(parent).toBeNull();
      expect(mockedCacheGet).toHaveBeenCalledWith('conversation:root');
    });

    it('should return null if the task does not exist', async () => {
      mockedCacheGet.mockResolvedValueOnce(null);
      const parent = await taskNavigator.getTaskParent('non-existent');
      expect(parent).toBeNull();
    });

    it('should return null if the parent task does not exist in cache', async () => {
        const orphanTask = createMockConversation('orphan', 'non-existent-parent');
        mockedCacheGet.mockImplementation(async (key: string) => {
            if (key === 'conversation:orphan') return orphanTask;
            if (key === 'conversation:non-existent-parent') return null; // Parent non trouvé
            return null;
        });
        
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
        expect(mockedCacheGet).toHaveBeenCalledWith('children-index:root');
    });

    it('should return an empty array for a task with no children', async () => {
        const children = await taskNavigator.getTaskChildren('grandchild1');
        expect(children).toHaveLength(0);
        expect(mockedCacheGet).toHaveBeenCalledWith('children-index:grandchild1');
    });

    it('should return an empty array if the children index is empty or null', async () => {
        mockedCacheGet.mockImplementation(async (key: string) => {
            if (key === 'children-index:task-with-empty-index') return [];
            return null;
        });
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
        
        const child1Node = tree?.children.find((c: TreeNode) => c.taskId === 'child1');
        const child2Node = tree?.children.find((c: TreeNode) => c.taskId === 'child2');
        
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
        mockedCacheGet.mockResolvedValueOnce(null);
        const tree = await taskNavigator.getTaskTree('non-existent-root');
        expect(tree).toBeNull();
    });
  });
});