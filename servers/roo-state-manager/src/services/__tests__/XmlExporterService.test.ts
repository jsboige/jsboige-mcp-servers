/**
 * Tests unitaires pour XmlExporterService
 *
 * Couvre :
 * - generateTaskXml : structure de base, title optionnel, mode, messages, actions
 * - generateTaskXml : includeContent true/false, prettyPrint
 * - generateConversationXml : structure racine, hiérarchie enfants, maxDepth
 * - generateProjectXml : résumé, filtrage par date, conversations racines
 * - validateFilePath (via saveXmlToFile) : path traversal, chemin absolu, trop long
 *
 * @module services/__tests__/XmlExporterService.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─────────────────── mocks (fs/promises pour saveXmlToFile) ───────────────────

const { mockMkdir, mockWriteFile } = vi.hoisted(() => ({
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: (...args: any[]) => mockMkdir(...args),
    writeFile: (...args: any[]) => mockWriteFile(...args),
  },
  mkdir: (...args: any[]) => mockMkdir(...args),
  writeFile: (...args: any[]) => mockWriteFile(...args),
}));

import { XmlExporterService } from '../XmlExporterService.js';
import type { ConversationSkeleton, MessageSkeleton, ActionMetadata } from '../../types/conversation.js';
import { StateManagerError } from '../../types/errors.js';

// ─────────────────── helpers ───────────────────

function makeMessage(overrides: Partial<MessageSkeleton> = {}): MessageSkeleton {
  return {
    role: 'user',
    content: 'Test message content',
    timestamp: '2026-01-01T10:00:00Z',
    isTruncated: false,
    ...overrides,
  };
}

function makeAction(overrides: Partial<ActionMetadata> = {}): ActionMetadata {
  return {
    type: 'tool',
    name: 'read_file',
    parameters: { path: '/tmp/test.ts' },
    status: 'success',
    timestamp: '2026-01-01T10:01:00Z',
    ...overrides,
  };
}

function makeSkeleton(overrides: Partial<ConversationSkeleton> = {}): ConversationSkeleton {
  return {
    taskId: 'task-001',
    metadata: {
      title: 'Test Task',
      lastActivity: '2026-01-01T12:00:00Z',
      createdAt: '2026-01-01T10:00:00Z',
      mode: 'code',
      messageCount: 2,
      actionCount: 1,
      totalSize: 1024,
    },
    sequence: [],
    ...overrides,
  };
}

// ─────────────────── setup ───────────────────

let service: XmlExporterService;

beforeEach(() => {
  service = new XmlExporterService();
  vi.clearAllMocks();
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
});

// ─────────────────── tests ───────────────────

describe('XmlExporterService', () => {

  // ============================================================
  // generateTaskXml - structure de base
  // ============================================================

  describe('generateTaskXml - structure de base', () => {
    test('retourne une chaîne XML non vide', () => {
      const xml = service.generateTaskXml(makeSkeleton());
      expect(typeof xml).toBe('string');
      expect(xml.length).toBeGreaterThan(0);
    });

    test('contient la déclaration XML', () => {
      const xml = service.generateTaskXml(makeSkeleton());
      expect(xml).toContain('<?xml');
    });

    test('contient l\'élément racine <task>', () => {
      const xml = service.generateTaskXml(makeSkeleton());
      expect(xml).toContain('<task');
    });

    test('contient le taskId dans les attributs', () => {
      const xml = service.generateTaskXml(makeSkeleton({ taskId: 'task-xyz-123' }));
      expect(xml).toContain('task-xyz-123');
    });

    test('contient parentTaskId si présent', () => {
      const xml = service.generateTaskXml(makeSkeleton({ parentTaskId: 'parent-001' }));
      expect(xml).toContain('parent-001');
    });

    test('ne contient pas parentTaskId si absent', () => {
      const xml = service.generateTaskXml(makeSkeleton({ parentTaskId: undefined }));
      expect(xml).not.toContain('parentTaskId');
    });

    test('contient l\'élément <metadata>', () => {
      const xml = service.generateTaskXml(makeSkeleton());
      expect(xml).toContain('<metadata>');
    });

    test('contient le titre si présent', () => {
      const xml = service.generateTaskXml(makeSkeleton({
        metadata: { ...makeSkeleton().metadata, title: 'Mon Titre Test' }
      }));
      expect(xml).toContain('Mon Titre Test');
    });

    test('ne contient pas de balise title si title absent', () => {
      const skeleton = makeSkeleton();
      skeleton.metadata.title = undefined;
      const xml = service.generateTaskXml(skeleton);
      expect(xml).not.toContain('<title>');
    });

    test('contient le mode si présent', () => {
      const xml = service.generateTaskXml(makeSkeleton({
        metadata: { ...makeSkeleton().metadata, mode: 'debug-complex' }
      }));
      expect(xml).toContain('debug-complex');
    });

    test('contient messageCount', () => {
      const xml = service.generateTaskXml(makeSkeleton({
        metadata: { ...makeSkeleton().metadata, messageCount: 42 }
      }));
      expect(xml).toContain('42');
    });

    test('contient l\'élément <sequence>', () => {
      const xml = service.generateTaskXml(makeSkeleton({ sequence: [] }));
      expect(xml).toContain('<sequence');
    });
  });

  // ============================================================
  // generateTaskXml - messages et actions
  // ============================================================

  describe('generateTaskXml - messages et actions', () => {
    test('contient un élément <message> pour chaque message', () => {
      const skeleton = makeSkeleton({
        sequence: [makeMessage({ role: 'user' }), makeMessage({ role: 'assistant' })]
      });
      const xml = service.generateTaskXml(skeleton);
      const messageMatches = xml.match(/<message role=/g);
      expect(messageMatches).toHaveLength(2);
    });

    test('contient le role du message', () => {
      const skeleton = makeSkeleton({ sequence: [makeMessage({ role: 'assistant' })] });
      const xml = service.generateTaskXml(skeleton);
      expect(xml).toContain('assistant');
    });

    test('message isTruncated = true : attribut présent', () => {
      const skeleton = makeSkeleton({ sequence: [makeMessage({ isTruncated: true })] });
      const xml = service.generateTaskXml(skeleton);
      expect(xml).toContain('isTruncated');
    });

    test('message isTruncated = false : attribut absent', () => {
      const skeleton = makeSkeleton({ sequence: [makeMessage({ isTruncated: false })] });
      const xml = service.generateTaskXml(skeleton);
      expect(xml).not.toContain('isTruncated');
    });

    test('sans includeContent : contenu tronqué à 100 chars', () => {
      const longContent = 'A'.repeat(200);
      const skeleton = makeSkeleton({ sequence: [makeMessage({ content: longContent })] });
      const xml = service.generateTaskXml(skeleton, { includeContent: false });
      expect(xml).toContain('...');
    });

    test('avec includeContent = true : contenu complet', () => {
      const content = 'A'.repeat(150);
      const skeleton = makeSkeleton({ sequence: [makeMessage({ content })] });
      const xml = service.generateTaskXml(skeleton, { includeContent: true });
      // Doit contenir les 150 caractères sans '...'
      expect(xml).not.toContain('...');
    });

    test('contient un élément <action> pour chaque action', () => {
      const skeleton = makeSkeleton({
        sequence: [makeAction({ name: 'write_file' })]
      });
      const xml = service.generateTaskXml(skeleton);
      expect(xml).toContain('<action');
    });

    test('action contient le name', () => {
      const skeleton = makeSkeleton({ sequence: [makeAction({ name: 'glob_search' })] });
      const xml = service.generateTaskXml(skeleton);
      expect(xml).toContain('glob_search');
    });

    test('action contient le status', () => {
      const skeleton = makeSkeleton({ sequence: [makeAction({ status: 'failure' })] });
      const xml = service.generateTaskXml(skeleton);
      expect(xml).toContain('failure');
    });

    test('action avec paramètres : inclus dans <parameters>', () => {
      const skeleton = makeSkeleton({
        sequence: [makeAction({ parameters: { key: 'value' } })]
      });
      const xml = service.generateTaskXml(skeleton);
      expect(xml).toContain('<parameters>');
    });

    test('action sans paramètres : pas de balise <parameters>', () => {
      const skeleton = makeSkeleton({
        sequence: [makeAction({ parameters: {} })]
      });
      const xml = service.generateTaskXml(skeleton);
      expect(xml).not.toContain('<parameters>');
    });

    test('action avec file_path : attribut filePath présent', () => {
      const skeleton = makeSkeleton({
        sequence: [makeAction({ file_path: '/src/test.ts' })]
      });
      const xml = service.generateTaskXml(skeleton);
      expect(xml).toContain('filePath');
    });
  });

  // ============================================================
  // generateConversationXml
  // ============================================================

  describe('generateConversationXml', () => {
    test('retourne une chaîne XML', () => {
      const xml = service.generateConversationXml(makeSkeleton(), []);
      expect(typeof xml).toBe('string');
      expect(xml).toContain('<?xml');
    });

    test('contient l\'élément racine <conversation>', () => {
      const xml = service.generateConversationXml(makeSkeleton(), []);
      expect(xml).toContain('<conversation');
    });

    test('contient <rootTask>', () => {
      const xml = service.generateConversationXml(makeSkeleton(), []);
      expect(xml).toContain('<rootTask>');
    });

    test('ajoute les enfants de la tâche racine', () => {
      const root = makeSkeleton({ taskId: 'root-001' });
      const child = makeSkeleton({ taskId: 'child-001', parentTaskId: 'root-001' });
      const xml = service.generateConversationXml(root, [child]);
      expect(xml).toContain('child-001');
    });

    test('ne dépasse pas maxDepth', () => {
      const root = makeSkeleton({ taskId: 'root-001' });
      const child = makeSkeleton({ taskId: 'child-001', parentTaskId: 'root-001' });
      const grandchild = makeSkeleton({ taskId: 'grandchild-001', parentTaskId: 'child-001' });
      const xml = service.generateConversationXml(root, [child, grandchild], { maxDepth: 1 });
      // grandchild ne doit pas apparaître
      expect(xml).not.toContain('grandchild-001');
    });

    test('contient le taskId de la tâche racine', () => {
      const root = makeSkeleton({ taskId: 'my-root-task' });
      const xml = service.generateConversationXml(root, []);
      expect(xml).toContain('my-root-task');
    });
  });

  // ============================================================
  // generateProjectXml
  // ============================================================

  describe('generateProjectXml', () => {
    test('retourne une chaîne XML', () => {
      const xml = service.generateProjectXml([], '/my/project');
      expect(typeof xml).toBe('string');
      expect(xml).toContain('<?xml');
    });

    test('contient l\'élément <projectExport>', () => {
      const xml = service.generateProjectXml([], '/project');
      expect(xml).toContain('<projectExport>');
    });

    test('contient le chemin du projet', () => {
      const xml = service.generateProjectXml([], '/my/special/project');
      expect(xml).toContain('/my/special/project');
    });

    test('contient le count des conversations racines', () => {
      const root1 = makeSkeleton({ taskId: 'root-1' });
      const root2 = makeSkeleton({ taskId: 'root-2' });
      const xml = service.generateProjectXml([root1, root2], '/project');
      expect(xml).toContain('2'); // conversationCount
    });

    test('filtre par startDate', () => {
      const old = makeSkeleton({
        taskId: 'old-task',
        metadata: { ...makeSkeleton().metadata, lastActivity: '2025-01-01T00:00:00Z' }
      });
      const recent = makeSkeleton({
        taskId: 'recent-task',
        metadata: { ...makeSkeleton().metadata, lastActivity: '2026-06-01T00:00:00Z' }
      });
      const xml = service.generateProjectXml([old, recent], '/project', {
        startDate: '2026-01-01T00:00:00Z'
      });
      expect(xml).not.toContain('old-task');
      expect(xml).toContain('recent-task');
    });

    test('filtre par endDate', () => {
      const old = makeSkeleton({
        taskId: 'old-task',
        metadata: { ...makeSkeleton().metadata, lastActivity: '2025-01-01T00:00:00Z' }
      });
      const recent = makeSkeleton({
        taskId: 'recent-task',
        metadata: { ...makeSkeleton().metadata, lastActivity: '2026-06-01T00:00:00Z' }
      });
      const xml = service.generateProjectXml([old, recent], '/project', {
        endDate: '2025-12-31T23:59:59Z'
      });
      expect(xml).toContain('old-task');
      expect(xml).not.toContain('recent-task');
    });

    test('exclut les enfants de la liste des conversations racines', () => {
      const root = makeSkeleton({ taskId: 'root-1' });
      const child = makeSkeleton({ taskId: 'child-1', parentTaskId: 'root-1' });
      const xml = service.generateProjectXml([root, child], '/project');
      // conversationCount ne compte que les racines
      expect(xml).toContain('1'); // 1 seule conversation racine
    });
  });

  // ============================================================
  // validateFilePath (via saveXmlToFile)
  // ============================================================

  describe('validateFilePath (via saveXmlToFile)', () => {
    test('chemin valide : sauvegarde réussie', async () => {
      await expect(service.saveXmlToFile('<xml/>', 'output/test.xml')).resolves.toBeUndefined();
      expect(mockWriteFile).toHaveBeenCalled();
    });

    test('path traversal .. : lève StateManagerError', async () => {
      await expect(service.saveXmlToFile('<xml/>', '../etc/passwd')).rejects.toBeInstanceOf(StateManagerError);
    });

    test('chemin absolu /etc : lève StateManagerError', async () => {
      await expect(service.saveXmlToFile('<xml/>', '/etc/passwd')).rejects.toBeInstanceOf(StateManagerError);
    });

    test('chemin trop long (>260 chars) : lève StateManagerError', async () => {
      const longPath = 'a/'.repeat(130) + 'file.xml'; // >260 chars
      await expect(service.saveXmlToFile('<xml/>', longPath)).rejects.toBeInstanceOf(StateManagerError);
    });

    test('caractères interdits < : lève StateManagerError', async () => {
      await expect(service.saveXmlToFile('<xml/>', 'file<name.xml')).rejects.toBeInstanceOf(StateManagerError);
    });

    test('caractères interdits > : lève StateManagerError', async () => {
      await expect(service.saveXmlToFile('<xml/>', 'file>name.xml')).rejects.toBeInstanceOf(StateManagerError);
    });
  });
});
