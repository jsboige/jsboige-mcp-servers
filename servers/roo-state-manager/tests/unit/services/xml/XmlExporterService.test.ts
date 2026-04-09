/**
 * Tests pour XmlExporterService
 *
 * Ce service implémente l'export XML des conversations, tâches et projets
 * avec validation de sécurité et gestion de la profondeur maximale.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    XmlExporterService,
    type XmlExportOptions,
    type ProjectExportOptions
} from '../../../src/services/XmlExporterService.js';
import { ConversationSkeleton, MessageSkeleton } from '../../../src/types/conversation.js';
import { StateManagerError } from '../../../src/types/errors.js';

// Mock du logger
vi.mock('../../../src/utils/logger.js', () => ({
    createLogger: vi.fn(() => ({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }))
}));

describe('XmlExporterService', () => {
  let service: XmlExporterService;

  beforeEach(() => {
    service = new XmlExporterService();
  });

  describe('initialisation', () => {
    it('devrait initialiser correctement', () => {
      expect(service).toBeInstanceOf(XmlExporterService);
    });
  });

  describe('generateTaskXml', () => {
    const mockSkeleton: ConversationSkeleton = {
      taskId: 'task-123',
      parentTaskId: 'parent-456',
      metadata: {
        title: 'Test Task',
        lastActivity: '2024-01-01T10:00:00Z',
        createdAt: '2024-01-01T09:00:00Z',
        mode: 'code-simple',
        messageCount: 5,
        actionCount: 3,
        totalSize: 1024
      },
      sequence: [
        {
          role: 'user',
          timestamp: '2024-01-01T09:30:00Z',
          content: 'Hello world'
        },
        {
          type: 'tool_call',
          name: 'readFile',
          status: 'success',
          timestamp: '2024-01-01T09:31:00Z',
          parameters: { path: '/test.txt' },
          content_size: 100
        }
      ]
    };

    it('devrait générer du XML pour une tâche simple', () => {
      const xml = service.generateTaskXml(mockSkeleton);

      expect(xml).toContain('<task taskId="task-123" parentTaskId="parent-456">');
      expect(xml).toContain('<title>Test Task</title>');
      expect(xml).toContain('<message role="user" timestamp="2024-01-01T09:30:00Z">Hello world</message>');
      expect(xml).toContain('<action type="tool_call" name="readFile" status="success" timestamp="2024-01-01T09:31:00Z">');
    });

    it('devrait tronquer le contenu par défaut', () => {
      const longContent = 'x'.repeat(200);
      const skeleton = {
        ...mockSkeleton,
        sequence: [
          {
            role: 'user',
            timestamp: '2024-01-01T09:30:00Z',
            content: longContent
          }
        ]
      };

      const xml = service.generateTaskXml(skeleton);

      // Le contenu devrait être tronqué
      expect(xml).toContain('Hello world...'); // Vérifier le contenu tronqué
      expect(xml).not.toContain(longContent);
    });

    it('devrait inclure tout le contenu quand includeContent=true', () => {
      const longContent = 'x'.repeat(200);
      const skeleton = {
        ...mockSkeleton,
        sequence: [
          {
            role: 'user',
            timestamp: '2024-01-01T09:30:00Z',
            content: longContent
          }
        ]
      };

      const xml = service.generateTaskXml(skeleton, { includeContent: true });

      // Le contenu complet devrait être inclus
      expect(xml).toContain(longContent);
    });

    it('devrait gérer le XML non formaté', () => {
      const xml = service.generateTaskXml(mockSkeleton, { prettyPrint: false });

      expect(xml).toContain('<task taskId="task-123" parentTaskId="parent-456">');
      // Pas de sauts de ligne dans le XML non formaté
      expect(xml).not.toContain('\n    ');
    });

    it('devrait gérer une tâche sans parent', () => {
      const skeletonWithoutParent = {
        ...mockSkeleton,
        parentTaskId: undefined
      };

      const xml = service.generateTaskXml(skeletonWithoutParent);

      expect(xml).toContain('<task taskId="task-123">');
      expect(xml).not.toContain('parentTaskId');
    });

    it('devrait gérer une séquence vide', () => {
      const skeletonWithoutSequence = {
        ...mockSkeleton,
        sequence: []
      };

      const xml = service.generateTaskXml(skeletonWithoutSequence);

      expect(xml).toContain('<sequence/>');
    });
  });

  describe('generateConversationXml', () => {
    const rootSkeleton: ConversationSkeleton = {
      taskId: 'root-123',
      metadata: {
        title: 'Root Conversation',
        lastActivity: '2024-01-01T10:00:00Z',
        createdAt: '2024-01-01T09:00:00Z',
        mode: 'code-complex',
        messageCount: 10,
        actionCount: 5,
        totalSize: 2048
      },
      sequence: []
    };

    const childSkeleton: ConversationSkeleton = {
      taskId: 'child-456',
      parentTaskId: 'root-123',
      metadata: {
        title: 'Child Task',
        lastActivity: '2024-01-01T11:00:00Z',
        createdAt: '2024-01-01T10:00:00Z',
        mode: 'debug-simple',
        messageCount: 3,
        actionCount: 1,
        totalSize: 512
      },
      sequence: []
    };

    it('devrait générer du XML pour une conversation avec enfants', () => {
      const xml = service.generateConversationXml(rootSkeleton, [childSkeleton]);

      expect(xml).toContain('<conversation conversationId="root-123">');
      expect(xml).toContain('<rootTask>');
      expect(xml).toContain('<children>');
      expect(xml).toContain('<task taskId="child-456" parentTaskId="root-123">');
    });

    it('devrait limiter la profondeur avec maxDepth', () => {
      const xml = service.generateConversationXml(rootSkeleton, [childSkeleton], {
        maxDepth: 1
      });

      // La tâche enfant ne devrait pas être incluse
      expect(xml).not.toContain('child-456');
    });

    it('devrait générer une hiérarchie profonde', () => {
      const grandChild: ConversationSkeleton = {
        taskId: 'grandchild-789',
        parentTaskId: 'child-456',
        metadata: {
          title: 'Grandchild',
          lastActivity: '2024-01-01T12:00:00Z',
          createdAt: '2024-01-01T11:00:00Z',
          mode: 'debug-simple',
          messageCount: 1,
          actionCount: 0,
          totalSize: 128
        },
        sequence: []
      };

      const xml = service.generateConversationXml(rootSkeleton, [childSkeleton, grandChild], {
        maxDepth: 3
      });

      expect(xml).toContain('grandchild-789');
    });
  });

  describe('generateProjectXml', () => {
    const mockSkeletons: ConversationSkeleton[] = [
      {
        taskId: 'task-1',
        metadata: {
          title: 'Project Alpha',
          lastActivity: '2024-01-01T10:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          mode: 'code-simple',
          messageCount: 5,
          actionCount: 3,
          totalSize: 1024
        },
        sequence: []
      },
      {
        taskId: 'task-2',
        parentTaskId: 'task-1',
        metadata: {
          title: 'Subtask',
          lastActivity: '2024-01-01T11:00:00Z',
          createdAt: '2024-01-01T10:00:00Z',
          mode: 'debug-simple',
          messageCount: 2,
          actionCount: 1,
          totalSize: 512
        },
        sequence: []
      }
    ];

    it('devrait générer du XML pour un projet', () => {
      const xml = service.generateProjectXml(mockSkeletons, '/test/project');

      expect(xml).toContain('<projectExport>');
      expect(xml).toContain('<summary>');
      expect(xml).toContain('<conversationCount>1</conversationCount>');
      expect(xml).toContain('<totalTasks>2</totalTasks>');
      expect(xml).toContain('<conversations>');
      expect(xml).toContain('<conversation rootTaskId="task-1" title="Project Alpha" taskCount="2" lastActivity="2024-01-01T10:00:00Z"/>');
    });

    it('devrait filtrer par date de début', () => {
      const options: ProjectExportOptions = {
        startDate: '2024-01-01T11:00:00Z'
      };

      const xml = service.generateProjectXml(mockSkeletons, '/test/project', options);

      // Seule la tâche 2 devrait être incluse
      expect(xml).toContain('<conversation rootTaskId="task-2"');
      expect(xml).not.toContain('task-1');
    });

    it('devrait filtrer par date de fin', () => {
      const options: ProjectExportOptions = {
        endDate: '2024-01-01T10:30:00Z'
      };

      const xml = service.generateProjectXml(mockSkeletons, '/test/project', options);

      // Seule la tâche 1 devrait être incluse
      expect(xml).toContain('<conversation rootTaskId="task-1"');
      expect(xml).not.toContain('task-2');
    });

    it('devrait gérer un projet vide', () => {
      const xml = service.generateProjectXml([], '/empty/project');

      expect(xml).toContain('<conversationCount>0</conversationCount>');
      expect(xml).toContain('<totalTasks>0</totalTasks>');
      expect(xml).toContain('<conversations/>');
    });

    it('devrait calculer correctement la plage de dates', () => {
      const xml = service.generateProjectXml(mockSkeletons, '/test/project');

      expect(xml).toContain('<dateRange start="');
      expect(xml).toContain('end="');
      expect(xml).toContain('2024-01-01T09:00:00Z'); // Date la plus ancienne
      expect(xml).toContain('2024-01-01T11:00:00Z'); // Date la plus récente
    });
  });

  describe('validateFilePath', () => {
    it('devrait accepter un chemin relatif simple', () => {
      // Cette méthode est privée, on la teste via saveXmlToFile
      expect(() => {
        (service as any).validateFilePath('simple/path.xml');
      }).not.toThrow();
    });

    it('devrait rejeter les chemins avec ../', () => {
      expect(() => {
        (service as any).validateFilePath('../../malicious/path.xml');
      }).toThrow('Unsafe file path');
    });

    it('devrait rejeter les chemins absolus', () => {
      expect(() => {
        (service as any).validateFilePath('/absolute/path.xml');
      }).toThrow('Unsafe file path');

      expect(() => {
        (service as any).validateFilePath('C:\\\\absolute\\\\path.xml');
      }).toThrow('Unsafe file path');
    });

    it('devrait rejeter les caractères interdits', () => {
      expect(() => {
        (service as any).validateFilePath('path<with>invalid:chars|?*.xml');
      }).toThrow('Unsafe file path');
    });

    it('devrait rejeter les chemins trop longs', () => {
      const longPath = 'a'.repeat(300);
      expect(() => {
        (service as any).validateFilePath(longPath);
      }).toThrow('File path too long');
    });
  });

  describe('saveXmlToFile', () => {
    const mockXmlContent = '<test>content</test>';

    beforeEach(() => {
      // Mock fs/promises
      vi.doMock('fs/promises');
      vi.doMock('path');
    });

    it('devrait sauvegarder le XML dans un fichier', async () => {
      const mockFs = await import('fs/promises');
      const mockPath = await import('path');

      vi.spyOn(mockFs, 'mkdir').mockResolvedValue();
      vi.spyOn(mockFs, 'writeFile').mockResolvedValue();

      await service.saveXmlToFile(mockXmlContent, '/test/output.xml');

      expect(mockFs.mkdir).toHaveBeenCalledWith('/test', { recursive: true });
      expect(mockFs.writeFile).toHaveBeenCalledWith('/test/output.xml', mockXmlContent, 'utf-8');
    });

    it('devrait créer le répertoire parent si nécessaire', async () => {
      const mockFs = await import('fs/promises');
      const mockPath = await import('path');

      vi.spyOn(mockFs, 'mkdir').mockResolvedValue();
      vi.spyOn(mockFs, 'writeFile').mockResolvedValue();

      await service.saveXmlToFile(mockXmlContent, '/test/deep/nested/file.xml');

      expect(mockFs.mkdir).toHaveBeenCalledWith('/test/deep/nested', { recursive: true });
    });

    it('devrait rejeter les chemins non sécurisés', async () => {
      await expect(
        service.saveXmlToFile(mockXmlContent, '../../malicious.xml')
      ).rejects.toThrow('Unsafe file path');
    });
  });

  describe('cas limites', () => {
    it('devrait gérer les métadonnées incomplètes', () => {
      const minimalSkeleton: ConversationSkeleton = {
        taskId: 'minimal-123',
        metadata: {
          lastActivity: '2024-01-01T10:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 0,
          actionCount: 0,
          totalSize: 0
        },
        sequence: []
      };

      const xml = service.generateTaskXml(minimalSkeleton);

      expect(xml).toContain('<task taskId="minimal-123">');
      expect(xml).toContain('<metadata>');
      expect(xml).toContain('<messageCount>0</messageCount>');
      expect(xml).not.toContain('<title>');
    });

    it('devrait gérer les messages tronqués', () => {
      const skeletonWithTruncated: ConversationSkeleton = {
        taskId: 'truncated-123',
        metadata: {
          lastActivity: '2024-01-01T10:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 1,
          actionCount: 0,
          totalSize: 100
        },
        sequence: [
          {
            role: 'user',
            timestamp: '2024-01-01T09:30:00Z',
            content: 'Long message that should be truncated...',
            isTruncated: true
          }
        ]
      };

      const xml = service.generateTaskXml(skeletonWithTruncated);

      expect(xml).toContain('isTruncated="true"');
    });

    it('devrait gérer les actions sans paramètres', () => {
      const skeletonWithoutParams: ConversationSkeleton = {
        taskId: 'no-params-123',
        metadata: {
          lastActivity: '2024-01-01T10:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 0,
          actionCount: 1,
          totalSize: 100
        },
        sequence: [
          {
            type: 'command',
            name: 'git commit',
            status: 'success',
            timestamp: '2024-01-01T09:31:00Z'
          }
        ]
      };

      const xml = service.generateTaskXml(skeletonWithoutParams);

      expect(xml).toContain('<action type="command" name="git commit" status="success" timestamp="2024-01-01T09:31:00Z"/>');
      expect(xml).not.toContain('<parameters>');
    });
  });

  describe('intégration avec les types', () => {
    it('devrait générer un XML valide pour tous les types de messages', () => {
      const skeletonWithAllTypes: ConversationSkeleton = {
        taskId: 'all-types-123',
        metadata: {
          lastActivity: '2024-01-01T10:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 4,
          actionCount: 3,
          totalSize: 2048
        },
        sequence: [
          {
            role: 'user',
            timestamp: '2024-01-01T09:30:00Z',
            content: 'User message'
          },
          {
            role: 'assistant',
            timestamp: '2024-01-01T09:31:00Z',
            content: 'Assistant response'
          },
          {
            type: 'tool_call',
            name: 'readFile',
            status: 'success',
            timestamp: '2024-01-01T09:32:00Z',
            parameters: { path: '/test.txt' },
            content_size: 100
          },
          {
            type: 'file_write',
            name: 'writeFile',
            status: 'success',
            timestamp: '2024-01-01T09:33:00Z',
            file_path: '/output.txt',
            line_count: 10,
            content_size: 200
          }
        ]
      };

      const xml = service.generateTaskXml(skeletonWithAllTypes);

      // Vérifier que tous les types sont présents
      expect(xml).toContain('<message role="user"');
      expect(xml).toContain('<message role="assistant"');
      expect(xml).toContain('<action type="tool_call"');
      expect(xml).toContain('<action type="file_write"');
      expect(xml).toContain('<parameters>');
    });

    it('devrait gérer les grands nombres dans les métadonnées', () => {
      const skeletonWithLargeNumbers: ConversationSkeleton = {
        taskId: 'large-numbers-123',
        metadata: {
          lastActivity: '2024-01-01T10:00:00Z',
          createdAt: '2024-01-01T09:00:00Z',
          messageCount: 999999,
          actionCount: 999999,
          totalSize: 2147483647 // Max int32
        },
        sequence: []
      };

      const xml = service.generateTaskXml(skeletonWithLargeNumbers);

      expect(xml).toContain('<messageCount>999999</messageCount>');
      expect(xml).toContain('<actionCount>999999</actionCount>');
      expect(xml).toContain('<totalSize>2147483647</totalSize>');
    });
  });

  describe('performance et validation', () => {
    it('devrait générer rapidement de grandes hiérarchies', () => {
      const largeHierarchy: ConversationSkeleton[] = [];
      let parentId: string | undefined;

      // Créer une hiérarchie de 100 tâches
      for (let i = 0; i < 100; i++) {
        const taskId = `task-${i}`;
        const skeleton: ConversationSkeleton = {
          taskId,
          parentTaskId: parentId,
          metadata: {
            title: `Task ${i}`,
            lastActivity: `2024-01-01T${String(i + 9).padStart(2, '0')}:00:00Z`,
            createdAt: `2024-01-01T${String(i + 8).padStart(2, '0')}:00:00Z`,
            mode: 'code-simple',
            messageCount: i,
            actionCount: i,
            totalSize: i * 100
          },
          sequence: []
        };
        largeHierarchy.push(skeleton);
        parentId = taskId;
      }

      const rootSkeleton = largeHierarchy[0];
      const children = largeHierarchy.slice(1);

      // Mesurer le temps
      const start = performance.now();
      const xml = service.generateConversationXml(rootSkeleton, children, {
        maxDepth: 10
      });
      const end = performance.now();

      expect(xml).toContain('<conversation conversationId="task-0">');
      expect(xml).toContain('<task taskId="task-99"');
      expect(end - start).toBeLessThan(1000); // Moins d'une seconde
    });
  });
});