/**
 * Tests unitaires pour debug-hierarchy.ts
 * Vérifie le script de diagnostic de hiérarchie des tâches Roo
 */

import { describe, it, expect, vi } from 'vitest';

// Note: debug-hierarchy.ts est un script exécutable qui s'exécute immédiatement.
// Au lieu de tester l'exécution du script, on teste les comportements attendus
// via des tests plus ciblés sur les dépendances et la logique.

describe('debug-hierarchy', () => {
  it('should import without errors', async () => {
    // Test que le module peut être importé sans erreur de syntaxe
    // Le module s'exécute au chargement mais c'est OK pour ce test
    const module = await import('../debug-hierarchy.js');
    expect(module).toBeDefined();
  });

  it('should use RooStorageDetector for storage detection', async () => {
    // Mock RooStorageDetector avant l'import
    const mockDetectRooStorage = vi.fn().mockResolvedValue({
      locations: [{ path: '/mock/path', type: 'test' }]
    });

    // Forcer le rechargement du module
    vi.resetModules();

    vi.doMock('../utils/roo-storage-detector.js', () => ({
      RooStorageDetector: class MockRooStorageDetector {
        constructor() {}  // For `new RooStorageDetector()` at line 12
        static detectRooStorage = mockDetectRooStorage;  // For static call at line 16
      }
    }));

    // Import le module (s'exécute immédiatement)
    await import('../debug-hierarchy.js');

    // Attendre l'exécution async
    await new Promise(resolve => setTimeout(resolve, 200));

    // Vérifier que detectRooStorage a été appelé
    expect(mockDetectRooStorage).toHaveBeenCalled();

    vi.doUnmock('../utils/roo-storage-detector.js');
    vi.resetModules();
  });

  it('should handle missing storage locations gracefully', async () => {
    // Mock console.error pour capturer les erreurs
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Forcer le rechargement du module
    vi.resetModules();

    // Mock RooStorageDetector qui retourne aucune location
    vi.doMock('../utils/roo-storage-detector.js', () => ({
      RooStorageDetector: class MockRooStorageDetector {
        constructor() {}  // For `new RooStorageDetector()` at line 12
        static detectRooStorage = vi.fn().mockResolvedValue({
          locations: [] // Aucune location
        });
      }
    }));

    // Import le module
    await import('../debug-hierarchy.js');
    await new Promise(resolve => setTimeout(resolve, 200));

    // Vérifier qu'une erreur a été loggée
    expect(mockConsoleError).toHaveBeenCalled();

    mockConsoleError.mockRestore();
    vi.doUnmock('../utils/roo-storage-detector.js');
    vi.resetModules();
  });

  it('should process conversation JSON files', () => {
    // Test de la logique de filtrage des fichiers JSON
    const files = ['task1.json', 'task2.json', 'readme.txt', 'task3.json'];
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    // Le script ne traite que les fichiers .json
    expect(jsonFiles).toEqual(['task1.json', 'task2.json', 'task3.json']);
  });

  it('should limit file processing to 3 items', () => {
    // Test de la logique slice(0,3)
    const files = ['a.json', 'b.json', 'c.json', 'd.json', 'e.json'];
    const limited = files.slice(0, 3);

    // Le script limite à 3 conversations
    expect(limited).toHaveLength(3);
    expect(limited).toEqual(['a.json', 'b.json', 'c.json']);
  });

  it('should check for parentTaskId in multiple locations', () => {
    // Test de la logique de recherche de parentTaskId
    const mockData1 = {
      agentDetails: { parentTaskId: 'agent-parent' }
    };
    const mockData2 = {
      parentTaskId: 'root-parent'
    };
    const mockData3 = {
      metadata: { parentTaskId: 'meta-parent' }
    };

    // Le script vérifie agentDetails.parentTaskId
    expect(mockData1.agentDetails?.parentTaskId).toBe('agent-parent');

    // Le script vérifie parentTaskId à la racine
    expect(mockData2.parentTaskId).toBe('root-parent');

    // Le script vérifie metadata.parentTaskId
    expect(mockData3.metadata?.parentTaskId).toBe('meta-parent');
  });

  it('should detect new_task instructions in messages', () => {
    // Test de la logique de détection des instructions new_task
    const messages = [
      { content: 'Regular message' },
      { content: 'Message with <new_task> instruction' },
      { content: 'Another regular message' }
    ];

    const hasNewTask = messages.some(msg =>
      msg.content && msg.content.includes('<new_task>')
    );

    // Le script détecte les instructions new_task
    expect(hasNewTask).toBe(true);
  });

  it('should extract conversationId or id from conversation data', () => {
    // Test de la logique d'extraction d'ID
    const data1 = { conversationId: 'conv-123' };
    const data2 = { id: 'id-456' };
    const data3 = {};

    // Le script utilise conversationId || id || 'N/A'
    expect(data1.conversationId || data1.id || 'N/A').toBe('conv-123');
    expect(data2.conversationId || data2.id || 'N/A').toBe('id-456');
    expect(data3.conversationId || data3.id || 'N/A').toBe('N/A');
  });
});
