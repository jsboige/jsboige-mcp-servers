import type { StoredConversation } from './unified-store/types.js';

export interface TreeNode extends StoredConversation {
  children: TreeNode[];
}

export class TaskNavigator {
  private conversationCache: Map<string, StoredConversation>;

  public constructor(cache: Map<string, StoredConversation>) {
    this.conversationCache = cache;
  }
  
  public getAllTasks(): StoredConversation[] {
    return Array.from(this.conversationCache.values());
  }

  public getTaskParent(taskId: string): StoredConversation | null {
    const childConversation = this.conversationCache.get(taskId);
    const pId = (childConversation as any)?.parentId ?? (childConversation as any)?.parentTaskId;
    // Treat missing or sentinel ROOT as no parent
    if (!pId || pId === 'ROOT') {
      return null;
    }
    return this.conversationCache.get(pId) || null;
  }

  public getTaskChildren(taskId: string): StoredConversation[] {
    const children: StoredConversation[] = [];
    for (const skeleton of this.conversationCache.values()) {
      const pId = (skeleton as any)?.parentId ?? (skeleton as any)?.parentTaskId;
      if (pId === taskId) {
        children.push(skeleton);
      }
    }
    return children;
  }

  public getTaskTree(taskId: string): TreeNode | null {
    const rootSkeleton = this.conversationCache.get(taskId);
    if (!rootSkeleton) {
      return null;
    }

    const rootNode: TreeNode = {
      ...rootSkeleton,
      children: []
    };

    const buildTree = (node: TreeNode) => {
      const children = this.getTaskChildren(node.taskId);
      for (const child of children) {
        const childNode: TreeNode = {
          ...child,
          children: []
        };
        node.children.push(childNode);
        buildTree(childNode);
      }
    };

    buildTree(rootNode);
    return rootNode;
  }
}