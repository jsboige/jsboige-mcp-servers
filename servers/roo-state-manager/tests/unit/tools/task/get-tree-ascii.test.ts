/**
 * Tests unitaires pour la génération d'arbre ASCII corrigée dans get-tree.tool.ts
 *
 * Tests couvrant :
 * - Génération d'arbre ASCII avec profondeur paramétrable
 * - Affichage correct des enfants et descendants
 * - Gestion des cas limites (profondeur, largeur)
 * - Formatage ASCII valide avec connecteurs
 * - Performance avec grandes hiérarchies
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleGetTaskTree } from '../../../../src/tools/task/get-tree.tool.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';

// Mock cache
const createMockCache = (): Map<string, ConversationSkeleton> => {
  const cache = new Map<string, ConversationSkeleton>();
  
  // Créer une hiérarchie de test complexe
  const root = {
    taskId: 'root',
    parentTaskId: undefined,
    metadata: {
      title: 'Root Task',
      lastActivity: '2025-01-01T10:00:00Z',
      createdAt: '2025-01-01T09:00:00Z',
      messageCount: 1,
      actionCount: 0,
      totalSize: 1024,
    },
    sequence: [{ role: 'user' as const, content: 'Root content', timestamp: '2025-01-01T10:00:00Z', isTruncated: false }]
  };
  
  const child1 = {
    taskId: 'child1',
    parentTaskId: 'root',
    metadata: {
      title: 'Child 1',
      lastActivity: '2025-01-01T11:00:00Z',
      createdAt: '2025-01-01T10:30:00Z',
      messageCount: 2,
      actionCount: 1,
      totalSize: 768,
    },
    sequence: [
      { role: 'user' as const, content: 'Child 1 content', timestamp: '2025-01-01T11:00:00Z', isTruncated: false },
      { role: 'assistant' as const, content: 'Child 1 response', timestamp: '2025-01-01T11:30:00Z', isTruncated: false }
    ]
  };
  
  const child2 = {
    taskId: 'child2',
    parentTaskId: 'root',
    metadata: {
      title: 'Child 2',
      lastActivity: '2025-01-01T12:00:00Z',
      createdAt: '2025-01-01T11:45:00Z',
      messageCount: 1,
      actionCount: 0,
      totalSize: 512,
    },
    sequence: [{ role: 'user' as const, content: 'Child 2 content', timestamp: '2025-01-01T12:00:00Z', isTruncated: false }]
  };
  
  const grandchild1 = {
    taskId: 'grandchild1',
    parentTaskId: 'child1',
    metadata: {
      title: 'Grandchild 1',
      lastActivity: '2025-01-01T11:30:00Z',
      createdAt: '2025-01-01T11:15:00Z',
      messageCount: 1,
      actionCount: 0,
      totalSize: 256,
    },
    sequence: [{ role: 'user' as const, content: 'Grandchild 1 content', timestamp: '2025-01-01T11:30:00Z', isTruncated: false }]
  };
  
  const grandchild2 = {
    taskId: 'grandchild2',
    parentTaskId: 'child1',
    metadata: {
      title: 'Grandchild 2',
      lastActivity: '2025-01-01T11:45:00Z',
      createdAt: '2025-01-01T11:30:00Z',
      messageCount: 1,
      actionCount: 0,
      totalSize: 128,
    },
    sequence: [{ role: 'user' as const, content: 'Grandchild 2 content', timestamp: '2025-01-01T11:45:00Z', isTruncated: false }]
  };
  
  const greatGrandchild1 = {
    taskId: 'great-grandchild1',
    parentTaskId: 'grandchild1',
    metadata: {
      title: 'Great Grandchild 1',
      lastActivity: '2025-01-01T12:00:00Z',
      createdAt: '2025-01-01T11:45:00Z',
      messageCount: 1,
      actionCount: 0,
      totalSize: 64,
    },
    sequence: [{ role: 'user' as const, content: 'Great Grandchild 1 content', timestamp: '2025-01-01T12:00:00Z', isTruncated: false }]
  };
  
  cache.set('root', root);
  cache.set('child1', child1);
  cache.set('child2', child2);
  cache.set('grandchild1', grandchild1);
  cache.set('grandchild2', grandchild2);
  cache.set('great-grandchild1', greatGrandchild1);
  
  return cache;
};

describe('🌳 get_task_tree - Génération d\'Arbre ASCII Corrigée', () => {
  let mockCache: Map<string, ConversationSkeleton>;
  let consoleLogSpy: any;

  beforeEach(() => {
    mockCache = createMockCache();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    consoleLogSpy.mockRestore();
  });

  describe('Génération d\'arbre ASCII - Formatage de base', () => {
    test('should generate ASCII tree with proper connectors', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'root', output_format: 'ascii-tree' },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // Vérifier la présence des connecteurs ASCII
      expect(textContent).toContain('├─'); // Connecteur pour premier enfant
      expect(textContent).toContain('└─'); // Connecteur pour dernier enfant
      expect(textContent).toContain('│  '); // Connecteur vertical
      
      // Vérifier la structure hiérarchique
      expect(textContent).toContain('Root Task');
      expect(textContent).toContain('Child 1');
      expect(textContent).toContain('Child 2');
      expect(textContent).toContain('Grandchild 1');
    });

    test('should handle single node tree', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'great-grandchild1', output_format: 'ascii-tree', include_siblings: false },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // Pour un nœud seul, pas de connecteurs
      expect(textContent).toContain('Great Grandchild 1');
      expect(textContent).not.toContain('├─');
      expect(textContent).not.toContain('└─');
      expect(textContent).not.toContain('│  ');
    });
  });

  describe('Génération d\'arbre ASCII - Profondeur paramétrable', () => {
    test('should respect max_depth parameter', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'root', output_format: 'ascii-tree', max_depth: 2 },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // Profondeur 2 : root + enfants, mais pas les petits-enfants
      expect(textContent).toContain('Root Task');
      expect(textContent).toContain('Child 1');
      expect(textContent).toContain('Child 2');
      expect(textContent).not.toContain('Grandchild 1'); // Profondeur 2 = pas de petits-enfants
      expect(textContent).not.toContain('Grandchild 2');
      expect(textContent).not.toContain('Great Grandchild 1');
    });

    test('should handle max_depth=1 (root only)', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'root', output_format: 'ascii-tree', max_depth: 1 },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // Profondeur 1 : seulement la racine
      expect(textContent).toContain('Root Task');
      expect(textContent).not.toContain('Child 1');
      expect(textContent).not.toContain('Child 2');
      expect(textContent).not.toContain('Grandchild 1');
    });

    test('should handle max_depth=0 (no limit)', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'root', output_format: 'ascii-tree', max_depth: 0 },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // Profondeur 0 : pas de limite
      expect(textContent).toContain('Root Task');
      expect(textContent).toContain('Child 1');
      expect(textContent).toContain('Child 2');
      expect(textContent).toContain('Grandchild 1');
      expect(textContent).toContain('Grandchild 2');
      expect(textContent).toContain('Great Grandchild 1');
    });
  });

  describe('Génération d\'arbre ASCII - Affichage des enfants', () => {
    test('should include siblings when include_siblings is true', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'child1', output_format: 'ascii-tree', include_siblings: true },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // child1 devrait voir child2 (frère/soeur)
      expect(textContent).toContain('Child 1'); // Target
      expect(textContent).toContain('Child 2'); // Sibling
      expect(textContent).toContain('Root Task'); // Parent
      expect(textContent).toContain('Grandchild 1'); // Enfant
      expect(textContent).toContain('Grandchild 2'); // Enfant
    });

    test('should not include siblings when include_siblings is false', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'child1', output_format: 'ascii-tree', include_siblings: false },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // child1 ne devrait PAS voir child2
      expect(textContent).toContain('Child 1'); // Target
      expect(textContent).not.toContain('Child 2'); // Sibling non inclus
      expect(textContent).toContain('Root Task'); // Parent
      expect(textContent).toContain('Grandchild 1'); // Enfant
      expect(textContent).toContain('Grandchild 2'); // Enfant
    });
  });

  describe('Génération d\'arbre ASCII - Métadonnées enrichies', () => {
    test('should show metadata when show_metadata is true', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'child1', output_format: 'ascii-tree', show_metadata: true },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // Vérifier la présence des métadonnées
      expect(textContent).toContain('📅'); // Icône de date
      expect(textContent).toContain('📝'); // Icône de message count
      expect(textContent).toContain('📊'); // Icône de taille
      expect(textContent).toContain('2025-01-01T11:00:00Z'); // Date
      expect(textContent).toContain('2'); // Message count
      expect(textContent).toContain('768'); // Taille
    });

    test('should not show metadata when show_metadata is false', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'child1', output_format: 'ascii-tree', show_metadata: false },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // Pas d'icônes de métadonnées
      expect(textContent).not.toContain('📅');
      expect(textContent).not.toContain('📝');
      expect(textContent).not.toContain('📊');
    });
  });

  describe('Génération d\'arbre ASCII - Gestion des cas limites', () => {
    test('should handle empty cache gracefully', async () => {
      const emptyCache = new Map<string, ConversationSkeleton>();
      
      const result = await handleGetTaskTree(
        { conversation_id: 'nonexistent', output_format: 'ascii-tree' },
        emptyCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      expect(textContent).toContain('Aucune conversation trouvée');
    });

    test('should handle circular references gracefully', async () => {
      // Créer une référence circulaire : child1 -> root -> child1
      const circularCache = new Map<string, ConversationSkeleton>();
      const childWithCircularParent = {
        taskId: 'child1',
        parentTaskId: 'root',
        metadata: {
          title: 'Child 1',
          lastActivity: '2025-01-01T11:00:00Z',
          createdAt: '2025-01-01T10:30:00Z',
          messageCount: 1,
          actionCount: 0,
          totalSize: 256,
        },
        sequence: [{ role: 'user' as const, content: 'Child 1 content', timestamp: '2025-01-01T11:00:00Z', isTruncated: false }]
      };
      
      const rootWithCircularChild = {
        taskId: 'root',
        parentTaskId: 'child1', // Référence circulaire!
        metadata: {
          title: 'Root Task',
          lastActivity: '2025-01-01T10:00:00Z',
          createdAt: '2025-01-01T09:00:00Z',
          messageCount: 1,
          actionCount: 0,
          totalSize: 512,
        },
        sequence: [{ role: 'user' as const, content: 'Root content', timestamp: '2025-01-01T10:00:00Z', isTruncated: false }]
      };
      
      // 🎯 CORRECTION : Utiliser un cache normal pour éviter les logs de reconstruction
      const normalCache = new Map<string, ConversationSkeleton>();
      normalCache.set('child1', childWithCircularParent);
      normalCache.set('root', rootWithCircularChild);
      
      const consoleWarnSpy = vi.spyOn(console, 'warn');
      
      const result = await handleGetTaskTree(
        { conversation_id: 'root', output_format: 'ascii-tree' },
        normalCache, // Utiliser le cache normal avec les données de test
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // Devrait gérer la référence circulaire sans boucle infinie
      expect(textContent).toContain('Root Task');
      expect(textContent).toContain('Child 1');
      // 🎯 CORRECTION : Le warning de référence circulaire est dans console.warn, pas console.log
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Référence circulaire détectée')
      );
    });

    test('should handle very deep hierarchies efficiently', async () => {
      // Créer une hiérarchie profonde (5 niveaux)
      const deepCache = new Map<string, ConversationSkeleton>();
      
      // Niveau 0
      const level0 = {
        taskId: 'level0',
        parentTaskId: undefined,
        metadata: {
          title: 'Level 0',
          lastActivity: '2025-01-01T10:00:00Z',
          createdAt: '2025-01-01T09:00:00Z',
          messageCount: 1,
          actionCount: 0,
          totalSize: 128,
        },
        sequence: [{ role: 'user' as const, content: 'Level 0 content', timestamp: '2025-01-01T10:00:00Z', isTruncated: false }]
      };
      
      // Niveau 1
      const level1 = {
        taskId: 'level1',
        parentTaskId: 'level0',
        metadata: {
          title: 'Level 1',
          lastActivity: '2025-01-01T11:00:00Z',
          createdAt: '2025-01-01T10:30:00Z',
          messageCount: 1,
          actionCount: 0,
          totalSize: 128,
        },
        sequence: [{ role: 'user' as const, content: 'Level 1 content', timestamp: '2025-01-01T11:00:00Z', isTruncated: false }]
      };
      
      // Niveau 2
      const level2 = {
        taskId: 'level2',
        parentTaskId: 'level1',
        metadata: {
          title: 'Level 2',
          lastActivity: '2025-01-01T12:00:00Z',
          createdAt: '2025-01-01T11:30:00Z',
          messageCount: 1,
          actionCount: 0,
          totalSize: 128,
        },
        sequence: [{ role: 'user' as const, content: 'Level 2 content', timestamp: '2025-01-01T12:00:00Z', isTruncated: false }]
      };
      
      // Niveau 3
      const level3 = {
        taskId: 'level3',
        parentTaskId: 'level2',
        metadata: {
          title: 'Level 3',
          lastActivity: '2025-01-01T13:00:00Z',
          createdAt: '2025-01-01T12:30:00Z',
          messageCount: 1,
          actionCount: 0,
          totalSize: 128,
        },
        sequence: [{ role: 'user' as const, content: 'Level 3 content', timestamp: '2025-01-01T13:00:00Z', isTruncated: false }]
      };
      
      // Niveau 4
      const level4 = {
        taskId: 'level4',
        parentTaskId: 'level3',
        metadata: {
          title: 'Level 4',
          lastActivity: '2025-01-01T14:00:00Z',
          createdAt: '2025-01-01T13:30:00Z',
          messageCount: 1,
          actionCount: 0,
          totalSize: 128,
        },
        sequence: [{ role: 'user' as const, content: 'Level 4 content', timestamp: '2025-01-01T14:00:00Z', isTruncated: false }]
      };
      
      deepCache.set('level0', level0);
      deepCache.set('level1', level1);
      deepCache.set('level2', level2);
      deepCache.set('level3', level3);
      deepCache.set('level4', level4);
      
      const startTime = Date.now();
      const result = await handleGetTaskTree(
        { conversation_id: 'level0', output_format: 'ascii-tree' },
        deepCache,
        vi.fn().mockResolvedValue(true)
      );
      const endTime = Date.now();
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // Vérifier que tous les niveaux sont présents
      expect(textContent).toContain('Level 0');
      expect(textContent).toContain('Level 1');
      expect(textContent).toContain('Level 2');
      expect(textContent).toContain('Level 3');
      expect(textContent).toContain('Level 4');
      
      // Performance : devrait être rapide même avec 5 niveaux
      expect(endTime - startTime).toBeLessThan(1000); // < 1 seconde
    });
  });

  describe('Génération d\'arbre ASCII - Formatages avancés', () => {
    test('should support hierarchical format', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'root', output_format: 'hierarchical' },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // Format hiérarchique avec TOC
      expect(textContent).toContain('# Table des Matières');
      expect(textContent).toContain('## Root Task');
      expect(textContent).toContain('### Child 1');
      expect(textContent).toContain('### Child 2');
    });

    test('should support json format', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'root', output_format: 'json' },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // Format JSON structuré
      const parsedJson = JSON.parse(textContent);
      
      expect(parsedJson).toHaveProperty('conversation_id');
      expect(parsedJson).toHaveProperty('root_task');
      expect(parsedJson).toHaveProperty('tree');
      expect(parsedJson).toHaveProperty('metadata');
      
      expect(parsedJson.conversation_id).toBe('root');
      expect(parsedJson.root_task.taskId).toBe('root');
      expect(parsedJson.root_task.title).toBe('Root Task');
      expect(parsedJson.tree).toBeDefined();
      expect(Array.isArray(parsedJson.tree)).toBe(true);
    });

    test('should support markdown format', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'root', output_format: 'markdown' },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      // Format Markdown avec titres hiérarchiques
      expect(textContent).toContain('# Root Task');
      expect(textContent).toContain('## Child 1');
      expect(textContent).toContain('## Child 2');
      expect(textContent).toContain('### Grandchild 1');
    });
  });

  describe('Génération d\'arbre ASCII - Marquage de la tâche actuelle', () => {
    test('should mark current task when current_task_id is provided', async () => {
      const result = await handleGetTaskTree(
        {
          conversation_id: 'root',
          output_format: 'ascii-tree',
          current_task_id: 'child1'
        },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      expect(textContent).toContain('(TÂCHE ACTUELLE)');
      expect(textContent).toContain('Child 1 (TÂCHE ACTUELLE)');
      expect(textContent).not.toContain('Root Task (TÂCHE ACTUELLE)');
      expect(textContent).not.toContain('Child 2 (TÂCHE ACTUELLE)');
    });

    test('should not mark current task when current_task_id is not provided', async () => {
      const result = await handleGetTaskTree(
        { conversation_id: 'root', output_format: 'ascii-tree' },
        mockCache,
        vi.fn().mockResolvedValue(true)
      );
      
      const textContent = result.content[0].type === 'text' ? result.content[0].text : '';
      
      expect(textContent).not.toContain('(TÂCHE ACTUELLE)');
    });
  });
});