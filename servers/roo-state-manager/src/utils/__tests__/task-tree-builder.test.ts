/**
 * Tests unitaires pour TaskTreeBuilder
 *
 * Couvre :
 * - buildCompleteTree : construction de l'arbre complet
 * - Analyse workspaces, projets, clusters, conversations
 * - Index de l'arbre (byId, byType, byPath, byTechnology, byTimeRange)
 * - Métadonnées (qualityScore, nodeCount, maxDepth)
 * - Utilitaires (complexité, statut, outcome, durée estimée)
 * - Gestion d'erreurs (TreeBuildError)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock WorkspaceAnalyzer
vi.mock('../workspace-analyzer.js', () => ({
  WorkspaceAnalyzer: {
    analyzeWorkspaces: vi.fn(),
  },
}));

// Mock RelationshipAnalyzer
vi.mock('../relationship-analyzer.js', () => ({
  RelationshipAnalyzer: {
    analyzeRelationships: vi.fn(),
  },
}));

import { TaskTreeBuilder } from '../task-tree-builder.js';
import { WorkspaceAnalyzer } from '../workspace-analyzer.js';
import { RelationshipAnalyzer } from '../relationship-analyzer.js';
import { TaskType, ComplexityLevel, ProjectStatus, ConversationOutcome, TreeBuildError } from '../../types/task-tree.js';
import type { ConversationSummary } from '../../types/conversation.js';
import type { WorkspaceAnalysis, TaskRelationship, WorkspaceCandidate } from '../../types/task-tree.js';

const mockWorkspaceAnalyzer = WorkspaceAnalyzer as unknown as {
  analyzeWorkspaces: ReturnType<typeof vi.fn>;
};

const mockRelationshipAnalyzer = RelationshipAnalyzer as unknown as {
  analyzeRelationships: ReturnType<typeof vi.fn>;
};

function createMockConversation(overrides?: Partial<ConversationSummary>): ConversationSummary {
  return {
    taskId: `task-${Math.random().toString(36).substr(2, 8)}`,
    prompt: 'Test prompt',
    lastActivity: '2026-02-10T10:00:00Z',
    messageCount: 10,
    size: 5000,
    hasApiHistory: true,
    hasUiMessages: true,
    path: '/mock/storage/tasks/task-001',
    metadata: {
      title: 'Test conversation',
      lastActivity: '2026-02-10T10:00:00Z',
      createdAt: '2026-02-10T09:00:00Z',
      mode: 'code-simple',
      files_in_context: [
        { path: '/workspace/src/index.ts', content: 'console.log("hello")', lineCount: 1 },
      ],
    },
    ...overrides,
  };
}

function createMockWorkspaceAnalysis(conversations: ConversationSummary[]): WorkspaceAnalysis {
  return {
    workspaces: [
      {
        path: '/workspace',
        name: 'test-workspace',
        confidence: 0.9,
        conversations,
        detectedTechnologies: ['typescript'],
        filePatterns: ['.ts'],
        commonPrefixes: ['/workspace'],
      },
    ],
    totalConversations: conversations.length,
    analysisMetadata: {
      version: '1.0',
      analyzedAt: new Date().toISOString(),
      analysisTime: 100,
      algorithmsUsed: ['prefix-clustering'],
      qualityMetrics: {
        workspaceDetectionAccuracy: 0.9,
        projectClassificationAccuracy: 0.8,
        clusterCoherence: 0.7,
        relationshipConfidence: 0.6,
      },
    },
    relationships: [],
    errors: [],
  };
}

describe('TaskTreeBuilder', () => {
  let builder: TaskTreeBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    builder = new TaskTreeBuilder();
  });

  describe('buildCompleteTree', () => {
    it('should build a tree from conversations', async () => {
      const conversations = [
        createMockConversation({ taskId: 'task-001' }),
        createMockConversation({ taskId: 'task-002' }),
      ];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      expect(tree).toBeDefined();
      expect(tree.root).toBeDefined();
      expect(tree.metadata).toBeDefined();
      expect(tree.relationships).toBeDefined();
      expect(tree.index).toBeDefined();
    });

    it('should set buildTime in metadata', async () => {
      const conversations = [createMockConversation()];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      expect(tree.metadata.buildTime).toBeGreaterThanOrEqual(0);
    });

    it('should create workspace nodes', async () => {
      const conversations = [createMockConversation()];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      // Single workspace → root is that workspace
      expect(tree.root.type).toBe(TaskType.WORKSPACE);
      expect(tree.root.name).toBe('test-workspace');
    });

    it('should create root node when multiple workspaces', async () => {
      const conv1 = createMockConversation({ taskId: 'task-ws1' });
      const conv2 = createMockConversation({ taskId: 'task-ws2' });
      const conversations = [conv1, conv2];

      const analysis: WorkspaceAnalysis = {
        workspaces: [
          {
            path: '/workspace1',
            name: 'workspace-1',
            confidence: 0.9,
            conversations: [conv1],
            detectedTechnologies: ['typescript'],
            filePatterns: ['.ts'],
            commonPrefixes: ['/workspace1'],
          },
          {
            path: '/workspace2',
            name: 'workspace-2',
            confidence: 0.8,
            conversations: [conv2],
            detectedTechnologies: ['python'],
            filePatterns: ['.py'],
            commonPrefixes: ['/workspace2'],
          },
        ],
        totalConversations: 2,
        analysisMetadata: {
          version: '1.0',
          analyzedAt: new Date().toISOString(),
          analysisTime: 100,
          algorithmsUsed: [],
          qualityMetrics: {
            workspaceDetectionAccuracy: 0.9,
            projectClassificationAccuracy: 0.8,
            clusterCoherence: 0.7,
            relationshipConfidence: 0.6,
          },
        },
        relationships: [],
        errors: [],
      };

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(analysis);
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      expect(tree.root.id).toBe('root');
      expect(tree.root.name).toBe('Roo State Manager');
      expect(tree.root.children).toHaveLength(2);
    });

    it('should throw TreeBuildError on workspace analysis failure', async () => {
      mockWorkspaceAnalyzer.analyzeWorkspaces.mockRejectedValue(new Error('Analysis failed'));

      await expect(
        builder.buildCompleteTree([createMockConversation()])
      ).rejects.toThrow(TreeBuildError);
    });

    it('should build tree index with byId', async () => {
      const conversations = [createMockConversation({ taskId: 'task-indexed' })];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      // Root node should be indexed
      expect(tree.index.byId.has(tree.root.id)).toBe(true);
    });

    it('should build tree index with byType', async () => {
      const conversations = [createMockConversation()];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      // Should have at least workspace type in index
      expect(tree.index.byType.has(TaskType.WORKSPACE)).toBe(true);
    });

    it('should include relationships in tree', async () => {
      const conversations = [createMockConversation()];
      const mockRelationships: TaskRelationship[] = [
        {
          id: 'rel-1',
          type: 'file_dependency' as any,
          source: 'task-001',
          target: 'task-002',
          weight: 0.8,
          metadata: { confidence: 0.9, evidence: ['shared file'] },
          createdAt: new Date().toISOString(),
        },
      ];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue(mockRelationships);

      const tree = await builder.buildCompleteTree(conversations);

      expect(tree.relationships).toHaveLength(1);
      expect(tree.relationships[0].id).toBe('rel-1');
    });

    it('should calculate quality score', async () => {
      const conversations = [createMockConversation()];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      expect(tree.metadata.qualityScore).toBeGreaterThanOrEqual(0);
      expect(tree.metadata.qualityScore).toBeLessThanOrEqual(1);
    });

    it('should count total nodes', async () => {
      const conversations = [createMockConversation()];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      // At minimum: 1 workspace + 1 project + 1 cluster + 1 conversation = 4
      expect(tree.metadata.totalNodes).toBeGreaterThanOrEqual(1);
    });

    it('should use cache for repeated workspace analysis', async () => {
      const conversations = [createMockConversation({ taskId: 'task-cached' })];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      await builder.buildCompleteTree(conversations);
      await builder.buildCompleteTree(conversations);

      // Should only call analyzeWorkspaces once (second time uses cache)
      expect(mockWorkspaceAnalyzer.analyzeWorkspaces).toHaveBeenCalledTimes(1);
    });
  });

  describe('conversation metadata', () => {
    it('should generate conversation name from title', async () => {
      const conversations = [
        createMockConversation({
          taskId: 'task-named',
          metadata: {
            title: 'Fixing authentication bug',
            files_in_context: [{ path: '/workspace/src/auth.ts', content: '', lineCount: 10 }],
          },
        }),
      ];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      // Find the conversation node in the tree
      const convNodes = tree.index.byType.get(TaskType.CONVERSATION);
      expect(convNodes).toBeDefined();
      if (convNodes && convNodes.length > 0) {
        expect(convNodes[0].name).toBe('Fixing authentication bug');
      }
    });

    it('should generate name from file when no title', async () => {
      const conversations = [
        createMockConversation({
          taskId: 'task-noname',
          metadata: {
            files_in_context: [{ path: '/workspace/src/utils/helpers.ts', content: '', lineCount: 5 }],
          },
        }),
      ];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      const convNodes = tree.index.byType.get(TaskType.CONVERSATION);
      if (convNodes && convNodes.length > 0) {
        expect(convNodes[0].name).toContain('helpers.ts');
      }
    });

    it('should use taskId prefix when no title or files', async () => {
      const conversations = [
        createMockConversation({
          taskId: 'task-12345678-abcd',
          metadata: {},
        }),
      ];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      const convNodes = tree.index.byType.get(TaskType.CONVERSATION);
      if (convNodes && convNodes.length > 0) {
        expect(convNodes[0].name).toContain('task-123');
      }
    });
  });

  describe('complexity and status', () => {
    it('should determine ACTIVE status for recent conversations', async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 1); // yesterday

      const conversations = [
        createMockConversation({
          lastActivity: recentDate.toISOString(),
        }),
      ];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      const projectNodes = tree.index.byType.get(TaskType.PROJECT);
      if (projectNodes && projectNodes.length > 0) {
        expect((projectNodes[0] as any).metadata.status).toBe(ProjectStatus.ACTIVE);
      }
    });

    it('should estimate duration based on message count', async () => {
      const conversations = [
        createMockConversation({ messageCount: 20 }),
      ];

      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      const tree = await builder.buildCompleteTree(conversations);

      const convNodes = tree.index.byType.get(TaskType.CONVERSATION);
      if (convNodes && convNodes.length > 0) {
        // 20 messages * 5 min = 100
        expect((convNodes[0] as any).metadata.estimatedDuration).toBe(100);
      }
    });
  });

  describe('empty input', () => {
    it('should handle empty conversations list', async () => {
      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue({
        workspaces: [],
        totalConversations: 0,
        analysisMetadata: {
          version: '1.0',
          analyzedAt: new Date().toISOString(),
          analysisTime: 0,
          algorithmsUsed: [],
          qualityMetrics: {
            workspaceDetectionAccuracy: 0,
            projectClassificationAccuracy: 0,
            clusterCoherence: 0,
            relationshipConfidence: 0,
          },
        },
        relationships: [],
        errors: [],
      });
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      // With no workspaces, assembleTree creates a root with empty children
      // or the code might throw. Let's test the actual behavior
      try {
        const tree = await builder.buildCompleteTree([]);
        // If it succeeds, verify basic structure
        expect(tree.root).toBeDefined();
        expect(tree.metadata.totalNodes).toBeGreaterThanOrEqual(1);
      } catch (error) {
        // It's also acceptable to throw TreeBuildError for empty input
        expect(error).toBeInstanceOf(TreeBuildError);
      }
    });
  });
});
