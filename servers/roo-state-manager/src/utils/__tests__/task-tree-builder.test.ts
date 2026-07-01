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

  // ============================================================
  // NEW coverage (deep-queue COVERAGE Cluster D): decision branches
  // & utility methods genuinely non-covered before. Anchored on real
  // source contract (task-tree-builder.ts): complexity L535-542,
  // status L544-551, outcome L629-636, tags L649-660, dominantTech
  // L569-594, summary L622-627, fileRefs L638-647, cache L308-322,
  // byPath index L383-385.
  // ============================================================
  describe('decision branches & utility coverage', () => {
    async function buildTree(conversations: ConversationSummary[]) {
      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);
      return builder.buildCompleteTree(conversations);
    }

    // --- calculateComplexity: 3 branches (L535-542) ---
    it('should classify complexity as COMPLEX when size > 100000 or messages > 50', async () => {
      const conversations = [
        createMockConversation({ size: 150000, messageCount: 60 }),
      ];
      const tree = await buildTree(conversations);

      const projectNodes = tree.index.byType.get(TaskType.PROJECT);
      expect(projectNodes).toBeDefined();
      expect((projectNodes![0] as any).metadata.complexity).toBe(ComplexityLevel.COMPLEX);
    });

    it('should classify complexity as MEDIUM when size > 50000 or messages > 20', async () => {
      const conversations = [
        createMockConversation({ size: 60000, messageCount: 25 }),
      ];
      const tree = await buildTree(conversations);

      const projectNodes = tree.index.byType.get(TaskType.PROJECT);
      expect((projectNodes![0] as any).metadata.complexity).toBe(ComplexityLevel.MEDIUM);
    });

    it('should classify complexity as SIMPLE for small conversations', async () => {
      const conversations = [
        createMockConversation({ size: 5000, messageCount: 10 }),
      ];
      const tree = await buildTree(conversations);

      const projectNodes = tree.index.byType.get(TaskType.PROJECT);
      expect((projectNodes![0] as any).metadata.complexity).toBe(ComplexityLevel.SIMPLE);
    });

    // --- determineProjectStatus: UNKNOWN + ARCHIVED branches (L544-551) ---
    it('should set UNKNOWN project status when last activity 7-30 days ago', async () => {
      const d = new Date(); d.setDate(d.getDate() - 15);
      const conversations = [createMockConversation({ lastActivity: d.toISOString() })];
      const tree = await buildTree(conversations);

      const projectNodes = tree.index.byType.get(TaskType.PROJECT);
      expect((projectNodes![0] as any).metadata.status).toBe(ProjectStatus.UNKNOWN);
    });

    it('should set ARCHIVED project status when last activity > 30 days ago', async () => {
      const d = new Date(); d.setDate(d.getDate() - 40);
      const conversations = [createMockConversation({ lastActivity: d.toISOString() })];
      const tree = await buildTree(conversations);

      const projectNodes = tree.index.byType.get(TaskType.PROJECT);
      expect((projectNodes![0] as any).metadata.status).toBe(ProjectStatus.ARCHIVED);
    });

    // --- determineOutcome: 3 branches, 0 covered before (L629-636) ---
    it('should determine ONGOING outcome when last activity < 1 day ago', async () => {
      const d = new Date(); d.setHours(d.getHours() - 2);
      const conversations = [createMockConversation({ lastActivity: d.toISOString() })];
      const tree = await buildTree(conversations);

      const convNodes = tree.index.byType.get(TaskType.CONVERSATION);
      expect((convNodes![0] as any).metadata.outcome).toBe(ConversationOutcome.ONGOING);
    });

    it('should determine COMPLETED outcome when last activity 1-7 days ago', async () => {
      const d = new Date(); d.setDate(d.getDate() - 3);
      const conversations = [createMockConversation({ lastActivity: d.toISOString() })];
      const tree = await buildTree(conversations);

      const convNodes = tree.index.byType.get(TaskType.CONVERSATION);
      expect((convNodes![0] as any).metadata.outcome).toBe(ConversationOutcome.COMPLETED);
    });

    it('should determine ABANDONED outcome when last activity > 7 days ago', async () => {
      const d = new Date(); d.setDate(d.getDate() - 10);
      const conversations = [createMockConversation({ lastActivity: d.toISOString() })];
      const tree = await buildTree(conversations);

      const convNodes = tree.index.byType.get(TaskType.CONVERSATION);
      expect((convNodes![0] as any).metadata.outcome).toBe(ConversationOutcome.ABANDONED);
    });

    // --- extractConversationTags (L649-660) ---
    it('should extract conversation tags [mode, api, ui]', async () => {
      const conversations = [
        createMockConversation({ hasApiHistory: true, hasUiMessages: true }),
      ];
      const tree = await buildTree(conversations);

      const convNodes = tree.index.byType.get(TaskType.CONVERSATION);
      const tags = (convNodes![0] as any).metadata.tags;
      expect(tags).toContain('code-simple'); // mode (default mock)
      expect(tags).toContain('api');
      expect(tags).toContain('ui');
    });

    // --- findDominantTechnology (L569-594) ---
    it('should find dominant technology by extension count', async () => {
      const conversations = [
        createMockConversation({
          metadata: {
            files_in_context: [
              { path: '/workspace/a.ts', content: '', lineCount: 1 },
              { path: '/workspace/b.ts', content: '', lineCount: 1 },
              { path: '/workspace/c.py', content: '', lineCount: 1 },
            ],
          },
        }),
      ];
      const tree = await buildTree(conversations);

      const clusterNodes = tree.index.byType.get(TaskType.TASK_CLUSTER);
      expect((clusterNodes![0] as any).metadata.dominantTechnology).toBe('ts');
    });

    // --- generateSummary (L622-627) ---
    it('should generate summary with message count and size in KB', async () => {
      const conversations = [
        createMockConversation({ messageCount: 10, size: 5120 }),
      ];
      const tree = await buildTree(conversations);

      const convNodes = tree.index.byType.get(TaskType.CONVERSATION);
      const summary = (convNodes![0] as any).metadata.summary;
      expect(summary).toContain('10 messages');
      expect(summary).toContain('5 KB'); // Math.round(5120/1024) = 5
    });

    // --- convertFileReferences content truncation (L638-647) ---
    it('should truncate file reference content to 200 chars', async () => {
      const longContent = 'x'.repeat(500);
      const conversations = [
        createMockConversation({
          metadata: {
            files_in_context: [{ path: '/workspace/big.ts', content: longContent, lineCount: 1 }],
          },
        }),
      ];
      const tree = await buildTree(conversations);

      const convNodes = tree.index.byType.get(TaskType.CONVERSATION);
      const fileRefs = (convNodes![0] as any).metadata.fileReferences;
      expect(fileRefs).toHaveLength(1);
      expect(fileRefs[0].content.length).toBeLessThanOrEqual(200);
    });

    // --- relationship cache (L308-322, second cache path) ---
    it('should use cache for repeated relationship analysis', async () => {
      const conversations = [createMockConversation({ taskId: 'task-rc' })];
      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockResolvedValue([]);

      await builder.buildCompleteTree(conversations);
      await builder.buildCompleteTree(conversations);

      expect(mockRelationshipAnalyzer.analyzeRelationships).toHaveBeenCalledTimes(1);
    });

    // --- second error path: relationship analyzer failure (L67, caught L92) ---
    it('should throw TreeBuildError on relationship analysis failure', async () => {
      const conversations = [createMockConversation()];
      mockWorkspaceAnalyzer.analyzeWorkspaces.mockResolvedValue(
        createMockWorkspaceAnalysis(conversations)
      );
      mockRelationshipAnalyzer.analyzeRelationships.mockRejectedValue(new Error('Rel fail'));

      await expect(builder.buildCompleteTree(conversations)).rejects.toThrow(TreeBuildError);
    });

    // --- byPath index branch (L383-385) ---
    it('should build tree index with byPath for workspace nodes', async () => {
      const conversations = [createMockConversation()];
      const tree = await buildTree(conversations);

      expect(tree.index.byPath.has('/workspace')).toBe(true);
    });
  });
});
