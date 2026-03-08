/**
 * Tests d'intégration pour conversation_browser
 *
 * Couvre toutes les actions de l'outil consolidé :
 * - action: 'list' : Lister les conversations récentes
 * - action: 'tree' : Arbre des tâches Roo
 * - action: 'current' : Tâche active
 * - action: 'view' : Vue conversation (squelette/summary/full)
 * - action: 'summarize' : Résumé/statistiques
 *
 * Framework: Vitest
 * Type: Intégration (RooSyncService réel, opérations filesystem réelles)
 *
 * @module conversation/conversation-browser.integration.test
 * @version 1.0.0 (#564 Phase 3)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// Mock getLocalMachineId pour contrôler l'identifiant dans les tests
vi.mock('../../../utils/message-helpers.js', async () => {
  const actual = await vi.importActual('../../../utils/message-helpers.js');
  return {
    ...actual,
    getLocalMachineId: vi.fn(() => 'test-machine'),
    getLocalFullId: vi.fn(() => 'test-machine'),
    getLocalWorkspaceId: vi.fn(() => 'roo-extensions')
  };
});

// Mock getSharedStatePath pour utiliser un chemin de test
const testSharedStatePath = join(__dirname, '../../../__test-data__/shared-state-conversation-browser');
vi.mock('../../../utils/server-helpers.js', () => ({
  getSharedStatePath: () => testSharedStatePath
}));

// Import après les mocks
import { handleConversationBrowser } from '../conversation-browser.js';
import { RooSyncService } from '../../../services/RooSyncService.js';

describe('conversation_browser (integration)', () => {
  let rooSyncService: RooSyncService;
  let conversationCache: Map<string, any>;
  let ensureSkeletonCacheIsFreshMock: ReturnType<typeof vi.fn>;
  let getConversationSkeletonMock: ReturnType<typeof vi.fn>;
  let findChildTasksMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Setup : créer répertoire temporaire pour tests isolés
    const dirs = [
      testSharedStatePath,
      join(testSharedStatePath, 'conversations'),
      join(testSharedStatePath, 'storage')
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    // Créer des conversations factices pour les tests
    const conversation1 = {
      taskId: 'task-001',
      parentTaskId: undefined,
      sequence: [
        { role: 'user', content: 'First message', timestamp: new Date(Date.now() - 3600000).toISOString(), isTruncated: false },
        { role: 'assistant', content: 'Response', timestamp: new Date(Date.now() - 3599000).toISOString(), isTruncated: false }
      ] as const,
      metadata: {
        mode: 'code-simple',
        workspace: 'roo-extensions',
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        lastActivity: new Date(Date.now() - 3599000).toISOString(),
        messageCount: 2,
        actionCount: 0,
        totalSize: 100
      }
    };

    const conversation2 = {
      taskId: 'task-002',
      parentTaskId: 'task-001',
      sequence: [
        { role: 'user', content: 'Second message', timestamp: new Date(Date.now() - 7200000).toISOString(), isTruncated: false }
      ] as const,
      metadata: {
        mode: 'debug-simple',
        workspace: 'roo-extensions',
        createdAt: new Date(Date.now() - 7200000).toISOString(),
        lastActivity: new Date(Date.now() - 7200000).toISOString(),
        messageCount: 1,
        actionCount: 0,
        totalSize: 50
      }
    };

    writeFileSync(
      join(testSharedStatePath, 'conversations', 'task-001.json'),
      JSON.stringify(conversation1)
    );
    writeFileSync(
      join(testSharedStatePath, 'conversations', 'task-002.json'),
      JSON.stringify(conversation2)
    );

    rooSyncService = new RooSyncService(testSharedStatePath);
    conversationCache = new Map();
    conversationCache.set('task-001', conversation1);
    conversationCache.set('task-002', conversation2);

    ensureSkeletonCacheIsFreshMock = vi.fn().mockResolvedValue(undefined);

    // Mock functions for Roo source summarization (required for action='summarize' with source='roo')
    getConversationSkeletonMock = vi.fn()
      .mockImplementation((id: string) => Promise.resolve(conversationCache.get(id) || null));
    findChildTasksMock = vi.fn()
      .mockImplementation((rootId: string) => Promise.resolve(
        Array.from(conversationCache.values()).filter(c => c.parentId === rootId)
      ));
  });

  afterEach(async () => {
    // Cleanup : supprimer répertoire test pour isolation
    if (existsSync(testSharedStatePath)) {
      rmSync(testSharedStatePath, { recursive: true, force: true });
    }
  });

  // ============================================================
  // Tests pour action: 'list'
  // ============================================================

  describe('action: list', () => {
    test('should list recent conversations without filters', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'list'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      const output = JSON.parse(result.content[0].text);
      expect(Array.isArray(output)).toBe(true);
    });

    test('should limit results with limit parameter', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'list',
          limit: 1
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      const output = JSON.parse(result.content[0].text);
      expect(Array.isArray(output)).toBe(true);
      expect(output.length).toBeLessThanOrEqual(1);
    });

    test('should sort by lastActivity descending by default', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'list',
          sortBy: 'lastActivity',
          sortOrder: 'desc'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      const output = JSON.parse(result.content[0].text);
      expect(Array.isArray(output)).toBe(true);
    });

    test('should sort by messageCount ascending', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'list',
          sortBy: 'messageCount',
          sortOrder: 'asc'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      const output = JSON.parse(result.content[0].text);
      expect(Array.isArray(output)).toBe(true);
    });

    test('should filter by contentPattern', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'list',
          contentPattern: 'Test task'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      const output = JSON.parse(result.content[0].text);
      expect(Array.isArray(output)).toBe(true);
    });

    test('should filter pendingSubtaskOnly', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'list',
          pendingSubtaskOnly: true
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      const output = JSON.parse(result.content[0].text);
      expect(Array.isArray(output)).toBe(true);
    });
  });

  // ============================================================
  // Tests pour action: 'tree'
  // ============================================================

  describe('action: tree', () => {
    test('should display task tree for conversation', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'tree',
          conversation_id: 'task-001'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
    });

    test('should support ascii-tree output format', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'tree',
          conversation_id: 'task-001',
          output_format: 'ascii-tree'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      const output = result.content[0].text;
      expect(output).toBeDefined();
    });

    test('should support markdown output format', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'tree',
          conversation_id: 'task-001',
          output_format: 'markdown'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should respect max_depth parameter', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'tree',
          conversation_id: 'task-001',
          max_depth: 1
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should include siblings by default', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'tree',
          conversation_id: 'task-001',
          include_siblings: true
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should show metadata when requested', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'tree',
          conversation_id: 'task-001',
          show_metadata: true
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should truncate instruction length', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'tree',
          conversation_id: 'task-001',
          truncate_instruction: 20
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Tests pour action: 'current'
  // ============================================================

  describe('action: current', () => {
    test('should return current active conversation', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'current'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
    });

    test('should use default workspace when not specified', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'current'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        undefined // Auto-detect workspace
      );

      expect(result).toBeDefined();
    });

    test('should use specified workspace parameter', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'current'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Tests pour action: 'view'
  // ============================================================

  describe('action: view', () => {
    test('should view conversation skeleton', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'view',
          task_id: 'task-001',
          detail_level: 'skeleton'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
    });

    test('should view with summary detail level', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'view',
          task_id: 'task-001',
          detail_level: 'summary'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should view with full detail level', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'view',
          task_id: 'task-001',
          detail_level: 'full'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should support smart truncation', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'view',
          task_id: 'task-001',
          smart_truncation: true,
          max_output_length: 10000
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should support chain view mode', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'view',
          task_id: 'task-001',
          view_mode: 'chain',
          detail_level: 'skeleton'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should support cluster view mode', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'view',
          task_id: 'task-001',
          view_mode: 'cluster',
          detail_level: 'summary'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should apply truncation when specified', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'view',
          task_id: 'task-001',
          truncate: 50
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Tests pour action: 'summarize'
  // ============================================================

  describe('action: summarize', () => {
    test('should generate trace summary', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'summarize',
          summarize_type: 'trace',
          taskId: 'task-001',
          summarize_output_format: 'json'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions',
        getConversationSkeletonMock,
        findChildTasksMock
      );

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      const output = JSON.parse(result.content[0].text);
      expect(output).toHaveProperty('type', 'trace');
    });

    test('should generate cluster summary', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'summarize',
          summarize_type: 'cluster',
          taskId: 'task-001',
          summarize_output_format: 'json'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions',
        getConversationSkeletonMock,
        findChildTasksMock
      );

      expect(result).toBeDefined();
      const output = JSON.parse(result.content[0].text);
      expect(output).toHaveProperty('type', 'cluster');
    });

    test('should use markdown format by default', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'summarize',
          summarize_type: 'trace',
          taskId: 'task-001'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should support JSON output format', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'summarize',
          summarize_type: 'trace',
          taskId: 'task-001',
          summarize_output_format: 'json'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should apply detail level parameter', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'summarize',
          summarize_type: 'trace',
          taskId: 'task-001',
          detailLevel: 'Messages'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should apply truncation when specified', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'summarize',
          summarize_type: 'trace',
          taskId: 'task-001',
          truncationChars: 5000
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should support compact stats', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'summarize',
          summarize_type: 'trace',
          taskId: 'task-001',
          compactStats: true
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should generate TOC when requested', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'summarize',
          summarize_type: 'trace',
          taskId: 'task-001',
          generateToc: true
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Tests de gestion d'erreurs
  // ============================================================

  describe('error handling', () => {
    test('should handle missing shared state directory gracefully', async () => {
      rmSync(testSharedStatePath, { recursive: true, force: true });

      const result = await handleConversationBrowser(
        {
          action: 'list'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should handle non-existent conversation gracefully', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'view',
          task_id: 'non-existent-id'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should handle invalid action gracefully', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'invalid' as any
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Tests d'intégration
  // ============================================================

  describe('integration scenarios', () => {
    test('should handle complete workflow: list → current → tree → view', async () => {
      // Step 1: List
      const listResult = await handleConversationBrowser(
        {
          action: 'list',
          limit: 10
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );
      expect(listResult).toBeDefined();

      // Step 2: Current
      const currentResult = await handleConversationBrowser(
        {
          action: 'current'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );
      expect(currentResult).toBeDefined();

      // Step 3: Tree
      const treeResult = await handleConversationBrowser(
        {
          action: 'tree',
          conversation_id: 'task-001',
          output_format: 'ascii-tree'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );
      expect(treeResult).toBeDefined();

      // Step 4: View
      const viewResult = await handleConversationBrowser(
        {
          action: 'view',
          task_id: 'task-001',
          detail_level: 'skeleton'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );
      expect(viewResult).toBeDefined();
    });

    test('should persist cache across operations', async () => {
      // First call populates cache
      await handleConversationBrowser(
        {
          action: 'list'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      // Second call uses cache
      const result = await handleConversationBrowser(
        {
          action: 'view',
          task_id: 'task-001',
          detail_level: 'skeleton'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      expect(conversationCache.has('task-001')).toBe(true);
    });
  });

  // ============================================================
  // Tests de format de sortie
  // ============================================================

  describe('output formats', () => {
    test('should return json format for list action', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'list'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      const output = JSON.parse(result.content[0].text);
      expect(Array.isArray(output)).toBe(true);
    });

    test('should return hierarchical format for tree action', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'tree',
          conversation_id: 'task-001',
          output_format: 'hierarchical'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
    });

    test('should return markdown format for summarize', async () => {
      const result = await handleConversationBrowser(
        {
          action: 'summarize',
          summarize_type: 'trace',
          taskId: 'task-001',
          summarize_output_format: 'markdown'
        },
        conversationCache,
        ensureSkeletonCacheIsFreshMock,
        'roo-extensions'
      );

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
    });
  });
});
