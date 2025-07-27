import { ConversationSkeleton } from '../types/conversation.js';
import { globalCacheManager, CacheManager } from '../utils/cache-manager.js';

export interface TreeNode extends ConversationSkeleton {
  children: TreeNode[];
}

export class TaskNavigator {
  private static instance: TaskNavigator;
  private cacheManager: CacheManager;

  private constructor() {
    this.cacheManager = globalCacheManager;
  }

  public static getInstance(): TaskNavigator {
    if (!TaskNavigator.instance) {
      TaskNavigator.instance = new TaskNavigator();
    }
    return TaskNavigator.instance;
  }

  /**
   * Retrieves the parent of a given task.
   * @param taskId The ID of the task to find the parent for.
   * @returns The parent task's ConversationSkeleton, or null if not found.
   */
  public async getTaskParent(taskId: string): Promise<ConversationSkeleton | null> {
    const childConversation = await this.cacheManager.get<ConversationSkeleton>(`conversation:${taskId}`);
    if (!childConversation?.parentTaskId) {
      return null;
    }

    return await this.cacheManager.get<ConversationSkeleton>(`conversation:${childConversation.parentTaskId}`);
  }

  /**
   * Retrieves the direct children of a given task.
   * @param taskId The ID of the task to find children for.
   * @returns An array of ConversationSkeleton for the children tasks.
   */
  public async getTaskChildren(taskId: string): Promise<ConversationSkeleton[]> {
    const childrenIds = await this.cacheManager.get<string[]>(`children-index:${taskId}`);
    if (!childrenIds) {
      return [];
    }

    const childrenPromises = childrenIds.map(childId =>
      this.cacheManager.get<ConversationSkeleton>(`conversation:${childId}`)
    );

    const children = await Promise.all(childrenPromises);
    return children.filter((child): child is ConversationSkeleton => child !== null);
  }

  /**
   * Retrieves the full task tree starting from a given task.
   * @param taskId The ID of the root task of the tree.
   * @returns The TreeNode object representing the task tree.
   */
  public async getTaskTree(taskId: string): Promise<TreeNode | null> {
    const rootSkeleton = await this.cacheManager.get<ConversationSkeleton>(`conversation:${taskId}`);
    if (!rootSkeleton) {
      return null;
    }

    const rootNode: TreeNode = {
      ...rootSkeleton,
      children: []
    };

    const buildTree = async (node: TreeNode) => {
      const children = await this.getTaskChildren(node.taskId);
      for (const child of children) {
        const childNode: TreeNode = {
          ...child,
          children: []
        };
        node.children.push(childNode);
        await buildTree(childNode);
      }
    };

    await buildTree(rootNode);
    return rootNode;
  }
}