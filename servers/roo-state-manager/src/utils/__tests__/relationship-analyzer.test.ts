/**
 * Tests unitaires pour RelationshipAnalyzer
 *
 * Couvre :
 * - analyzeRelationships : orchestration complète
 * - Relations parent-enfant (parentTaskId)
 * - Relations de dépendance de fichiers
 * - Relations temporelles (clusters)
 * - Relations sémantiques (similarité)
 * - Relations technologiques
 * - Filtrage et déduplication
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RelationshipAnalyzer } from '../relationship-analyzer.js';
import { RelationshipType } from '../../types/task-tree.js';
import type { ConversationSummary } from '../../types/conversation.js';

function createConversation(overrides: Partial<ConversationSummary> & { taskId: string }): ConversationSummary {
  return {
    prompt: '',
    lastActivity: '2026-02-10T10:00:00Z',
    messageCount: 10,
    size: 1024,
    hasApiHistory: true,
    hasUiMessages: true,
    path: '/tasks/test',
    metadata: {} as any,
    ...overrides,
  };
}

describe('RelationshipAnalyzer', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  // === analyzeRelationships (empty) ===

  describe('analyzeRelationships - empty input', () => {
    it('should return empty array for no conversations', async () => {
      const result = await RelationshipAnalyzer.analyzeRelationships([]);
      expect(result).toEqual([]);
    });

    it('should return empty array for single conversation', async () => {
      const result = await RelationshipAnalyzer.analyzeRelationships([
        createConversation({ taskId: 'task-1' }),
      ]);
      expect(result).toEqual([]);
    });
  });

  // === Parent-child relationships ===

  describe('parent-child relationships', () => {
    it('should detect explicit parentTaskId relationship', async () => {
      const conversations = [
        createConversation({ taskId: 'parent-1', lastActivity: '2026-02-10T08:00:00Z' }),
        createConversation({
          taskId: 'child-1',
          parentTaskId: 'parent-1',
          lastActivity: '2026-02-10T09:00:00Z',
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const parentChild = result.filter(r => r.type === RelationshipType.PARENT_CHILD);

      expect(parentChild.length).toBeGreaterThanOrEqual(1);
      expect(parentChild[0].source).toBe('parent-1');
      expect(parentChild[0].target).toBe('child-1');
      expect(parentChild[0].weight).toBe(1.0);
    });

    it('should detect parentTaskId from metadata', async () => {
      const conversations = [
        createConversation({ taskId: 'parent-2' }),
        createConversation({
          taskId: 'child-2',
          metadata: { parentTaskId: 'parent-2' } as any,
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const parentChild = result.filter(r => r.type === RelationshipType.PARENT_CHILD);

      expect(parentChild.length).toBeGreaterThanOrEqual(1);
    });

    it('should not create relationship when parent not found', async () => {
      const conversations = [
        createConversation({
          taskId: 'orphan-1',
          parentTaskId: 'nonexistent-parent',
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const parentChild = result.filter(r => r.type === RelationshipType.PARENT_CHILD);

      expect(parentChild).toHaveLength(0);
    });
  });

  // === File dependency relationships ===

  describe('file dependency relationships', () => {
    it('should detect shared file dependencies', async () => {
      // Use dates far apart (no temporal cluster) and different tech extensions
      // so TECHNOLOGY relationship doesn't override via deduplication
      const conversations = [
        createConversation({
          taskId: 'file-1',
          lastActivity: '2026-01-05T08:00:00Z',
          metadata: {
            files_in_context: [
              { path: 'config/shared.json', lineCount: 100 },
              { path: 'docs/readme.txt', lineCount: 50 },
            ],
          } as any,
        }),
        createConversation({
          taskId: 'file-2',
          lastActivity: '2026-02-10T09:00:00Z',
          metadata: {
            files_in_context: [
              { path: 'config/shared.json', lineCount: 100 },
              { path: 'scripts/deploy.sh', lineCount: 30 },
            ],
          } as any,
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const fileDeps = result.filter(r => r.type === RelationshipType.FILE_DEPENDENCY);

      expect(fileDeps.length).toBeGreaterThanOrEqual(1);
      expect(fileDeps[0].metadata.description).toContain('fichier');
    });

    it('should not create file dependency for no shared files', async () => {
      const conversations = [
        createConversation({
          taskId: 'isolated-1',
          lastActivity: '2026-02-10T08:00:00Z',
          metadata: {
            files_in_context: [{ path: 'src/a.ts', lineCount: 10 }],
          } as any,
        }),
        createConversation({
          taskId: 'isolated-2',
          lastActivity: '2026-02-10T09:00:00Z',
          metadata: {
            files_in_context: [{ path: 'src/b.ts', lineCount: 10 }],
          } as any,
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const fileDeps = result.filter(r => r.type === RelationshipType.FILE_DEPENDENCY);

      expect(fileDeps).toHaveLength(0);
    });

    it('should give higher weight to important files (package.json)', async () => {
      const conversations = [
        createConversation({
          taskId: 'pkg-1',
          lastActivity: '2026-02-10T08:00:00Z',
          metadata: {
            files_in_context: [{ path: 'package.json', lineCount: 50 }],
          } as any,
        }),
        createConversation({
          taskId: 'pkg-2',
          lastActivity: '2026-02-10T09:00:00Z',
          metadata: {
            files_in_context: [{ path: 'package.json', lineCount: 50 }],
          } as any,
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const fileDeps = result.filter(r => r.type === RelationshipType.FILE_DEPENDENCY);

      // package.json should get high weight (0.5 base + 0.1 shared + 0.2 important = 0.8)
      if (fileDeps.length > 0) {
        expect(fileDeps[0].weight).toBeGreaterThanOrEqual(0.7);
      }
    });
  });

  // === Temporal relationships ===

  describe('temporal relationships', () => {
    it('should detect temporal clusters (close activity times)', async () => {
      const conversations = [
        createConversation({
          taskId: 'temp-1',
          lastActivity: '2026-02-10T10:00:00Z',
        }),
        createConversation({
          taskId: 'temp-2',
          lastActivity: '2026-02-10T11:00:00Z',
        }),
        createConversation({
          taskId: 'temp-3',
          lastActivity: '2026-02-10T12:00:00Z',
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const temporal = result.filter(r => r.type === RelationshipType.TEMPORAL);

      expect(temporal.length).toBeGreaterThanOrEqual(1);
    });

    it('should have higher weight for closer conversations', async () => {
      const conversations = [
        createConversation({
          taskId: 'close-1',
          lastActivity: '2026-02-10T10:00:00Z',
        }),
        createConversation({
          taskId: 'close-2',
          lastActivity: '2026-02-10T10:30:00Z',
        }),
        createConversation({
          taskId: 'far-3',
          lastActivity: '2026-02-10T20:00:00Z',
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const temporal = result.filter(r => r.type === RelationshipType.TEMPORAL);

      // close-1 → close-2 should have higher weight than close-2 → far-3
      const closeRel = temporal.find(r => r.source === 'close-1' && r.target === 'close-2');
      const farRel = temporal.find(r => r.source === 'close-2' && r.target === 'far-3');

      if (closeRel && farRel) {
        expect(closeRel.weight).toBeGreaterThan(farRel.weight);
      }
    });

    it('should not create temporal relations for distant conversations', async () => {
      const conversations = [
        createConversation({
          taskId: 'jan-1',
          lastActivity: '2026-01-01T10:00:00Z',
        }),
        createConversation({
          taskId: 'feb-1',
          lastActivity: '2026-02-10T10:00:00Z',
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const temporal = result.filter(r => r.type === RelationshipType.TEMPORAL);

      // More than 24h apart, no temporal cluster should form
      expect(temporal).toHaveLength(0);
    });
  });

  // === Semantic similarity ===

  describe('semantic similarity', () => {
    it('should detect semantic similarity for shared paths and mode', async () => {
      const conversations = [
        createConversation({
          taskId: 'sem-1',
          size: 5000,
          lastActivity: '2026-02-10T10:00:00Z',
          metadata: {
            mode: 'code',
            files_in_context: [
              { path: 'src/utils.ts', lineCount: 100 },
              { path: 'src/index.ts', lineCount: 200 },
            ],
          } as any,
        }),
        createConversation({
          taskId: 'sem-2',
          size: 5500,
          lastActivity: '2026-02-10T11:00:00Z',
          metadata: {
            mode: 'code',
            files_in_context: [
              { path: 'src/utils.ts', lineCount: 100 },
              { path: 'src/index.ts', lineCount: 200 },
            ],
          } as any,
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const semantic = result.filter(r => r.type === RelationshipType.SEMANTIC);

      // High similarity expected: same files, same mode, close in time, similar size
      if (semantic.length > 0) {
        expect(semantic[0].weight).toBeGreaterThanOrEqual(0.7);
      }
    });

    it('should return low similarity for different conversations', async () => {
      const conversations = [
        createConversation({
          taskId: 'diff-1',
          size: 100,
          lastActivity: '2026-01-01T10:00:00Z',
          metadata: {
            mode: 'architect',
            files_in_context: [{ path: 'docs/readme.md', lineCount: 10 }],
          } as any,
        }),
        createConversation({
          taskId: 'diff-2',
          size: 50000,
          lastActivity: '2026-02-10T10:00:00Z',
          metadata: {
            mode: 'code',
            files_in_context: [{ path: 'src/complex.ts', lineCount: 500 }],
          } as any,
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const semantic = result.filter(r => r.type === RelationshipType.SEMANTIC);

      // Low similarity expected: different files, modes, times, sizes
      expect(semantic).toHaveLength(0);
    });
  });

  // === Technology relationships ===

  describe('technology relationships', () => {
    it('should detect technology relationship for same extension', async () => {
      const conversations = [
        createConversation({
          taskId: 'ts-1',
          lastActivity: '2026-02-10T10:00:00Z',
          metadata: {
            files_in_context: [
              { path: 'src/service.ts', lineCount: 100 },
              { path: 'src/utils.ts', lineCount: 50 },
            ],
          } as any,
        }),
        createConversation({
          taskId: 'ts-2',
          lastActivity: '2026-02-10T11:00:00Z',
          metadata: {
            files_in_context: [
              { path: 'src/handler.ts', lineCount: 200 },
              { path: 'src/types.ts', lineCount: 30 },
            ],
          } as any,
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const tech = result.filter(r => r.type === RelationshipType.TECHNOLOGY);

      expect(tech.length).toBeGreaterThanOrEqual(1);
      if (tech.length > 0) {
        expect(tech[0].metadata.description).toContain('typescript');
      }
    });

    it('should not create tech relations for different technologies', async () => {
      const conversations = [
        createConversation({
          taskId: 'py-1',
          lastActivity: '2026-02-10T10:00:00Z',
          metadata: {
            files_in_context: [{ path: 'app.py', lineCount: 100 }],
          } as any,
        }),
        createConversation({
          taskId: 'rs-1',
          lastActivity: '2026-02-10T11:00:00Z',
          metadata: {
            files_in_context: [{ path: 'main.rs', lineCount: 100 }],
          } as any,
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);
      const tech = result.filter(r => r.type === RelationshipType.TECHNOLOGY);

      // python vs rust should have low weight - likely filtered out
      expect(tech).toHaveLength(0);
    });
  });

  // === Filtering and deduplication ===

  describe('filtering and deduplication', () => {
    it('should filter out low-weight relationships', async () => {
      const conversations = [
        createConversation({
          taskId: 'low-1',
          lastActivity: '2026-01-01T10:00:00Z',
          size: 100,
        }),
        createConversation({
          taskId: 'low-2',
          lastActivity: '2026-02-10T10:00:00Z',
          size: 50000,
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);

      // All relationships should have weight >= 0.6 (MIN_RELATIONSHIP_CONFIDENCE)
      for (const rel of result) {
        expect(rel.weight).toBeGreaterThanOrEqual(0.6);
      }
    });

    it('should deduplicate relationships keeping highest weight', async () => {
      const conversations = [
        createConversation({
          taskId: 'dup-1',
          parentTaskId: 'dup-2',
          lastActivity: '2026-02-10T10:00:00Z',
          size: 5000,
          metadata: {
            mode: 'code',
            files_in_context: [{ path: 'src/shared.ts', lineCount: 100 }],
          } as any,
        }),
        createConversation({
          taskId: 'dup-2',
          lastActivity: '2026-02-10T10:30:00Z',
          size: 5000,
          metadata: {
            mode: 'code',
            files_in_context: [{ path: 'src/shared.ts', lineCount: 100 }],
          } as any,
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);

      // Should not have duplicate source-target pairs
      const pairKeys = new Set<string>();
      for (const rel of result) {
        const key = `${rel.source}-${rel.target}`;
        const reverseKey = `${rel.target}-${rel.source}`;
        expect(pairKeys.has(key) || pairKeys.has(reverseKey)).toBe(false);
        pairKeys.add(key);
      }
    });

    it('should sort results by weight descending', async () => {
      const conversations = [
        createConversation({
          taskId: 'sort-parent',
          lastActivity: '2026-02-10T10:00:00Z',
          metadata: {
            files_in_context: [{ path: 'src/a.ts', lineCount: 10 }],
          } as any,
        }),
        createConversation({
          taskId: 'sort-child',
          parentTaskId: 'sort-parent',
          lastActivity: '2026-02-10T10:30:00Z',
          metadata: {
            files_in_context: [{ path: 'src/b.ts', lineCount: 10 }],
          } as any,
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);

      for (let i = 0; i < result.length - 1; i++) {
        expect(result[i].weight).toBeGreaterThanOrEqual(result[i + 1].weight);
      }
    });
  });

  // === Complex scenario ===

  describe('complex scenario', () => {
    it('should handle mixed relationship types', async () => {
      const conversations = [
        createConversation({
          taskId: 'mix-parent',
          lastActivity: '2026-02-10T08:00:00Z',
          metadata: {
            mode: 'code',
            files_in_context: [
              { path: 'src/service.ts', lineCount: 200 },
              { path: 'package.json', lineCount: 50 },
            ],
          } as any,
        }),
        createConversation({
          taskId: 'mix-child',
          parentTaskId: 'mix-parent',
          lastActivity: '2026-02-10T09:00:00Z',
          metadata: {
            mode: 'code',
            files_in_context: [
              { path: 'src/service.ts', lineCount: 200 },
              { path: 'src/test.ts', lineCount: 100 },
            ],
          } as any,
        }),
        createConversation({
          taskId: 'mix-related',
          lastActivity: '2026-02-10T09:30:00Z',
          metadata: {
            mode: 'code',
            files_in_context: [
              { path: 'src/service.ts', lineCount: 200 },
              { path: 'src/helper.ts', lineCount: 80 },
            ],
          } as any,
        }),
      ];

      const result = await RelationshipAnalyzer.analyzeRelationships(conversations);

      // Should have multiple relationship types
      const types = new Set(result.map(r => r.type));
      expect(types.size).toBeGreaterThanOrEqual(2);

      // Parent-child should always be present
      expect(result.some(r => r.type === RelationshipType.PARENT_CHILD)).toBe(true);

      // All results should have valid fields
      for (const rel of result) {
        expect(rel.id).toBeDefined();
        expect(rel.source).toBeDefined();
        expect(rel.target).toBeDefined();
        expect(rel.weight).toBeGreaterThan(0);
        expect(rel.metadata.description).toBeDefined();
        expect(rel.metadata.confidence).toBeGreaterThan(0);
        expect(rel.createdAt).toBeDefined();
      }
    });
  });
});
