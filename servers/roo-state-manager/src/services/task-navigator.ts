import { ConversationSkeleton } from '../types/conversation.js';
export interface TreeNode extends ConversationSkeleton {
  children: TreeNode[];
}

export class TaskNavigator {
  private conversationCache: Map<string, ConversationSkeleton>;

  public constructor(cache: Map<string, ConversationSkeleton>) {
    this.conversationCache = cache;
  }
  
  public getAllTasks(): ConversationSkeleton[] {
    return Array.from(this.conversationCache.values());
  }

  public getTaskParent(taskId: string): ConversationSkeleton | null {
    const childConversation = this.conversationCache.get(taskId);
    if (!childConversation?.parentTaskId) {
      return null;
    }
    return this.conversationCache.get(childConversation.parentTaskId) || null;
  }

  public getTaskChildren(taskId: string): ConversationSkeleton[] {
    const children: ConversationSkeleton[] = [];
    for (const skeleton of this.conversationCache.values()) {
        if (skeleton.parentTaskId === taskId) {
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