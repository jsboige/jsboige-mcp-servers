/**
 * Tests unitaires pour les outils d'export XML
 *
 * Couvre :
 * - handleConfigureXmlExport : action=get, set, reset, invalid + tool def
 * - handleExportTasksXml : succès sans/avec filePath, task not found, erreur service
 * - handleExportConversationXml : succès sans/avec filePath, not found, maxDepth, collecte enfants
 * - handleExportProjectXml : succès, filtrage workspace, filtrage dates, filePath
 *
 * @module tools/export/__tests__/xml-export-tools.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  handleConfigureXmlExport,
  configureXmlExportTool,
} from '../configure-xml-export.js';
import {
  handleExportTasksXml,
  exportTasksXmlTool,
} from '../export-tasks-xml.js';
import {
  handleExportConversationXml,
  exportConversationXmlTool,
} from '../export-conversation-xml.js';
import {
  handleExportProjectXml,
  exportProjectXmlTool,
} from '../export-project-xml.js';
import type { ConversationSkeleton } from '../../../types/conversation.js';

// ─────────────────── helpers ───────────────────

function makeConversation(taskId: string, overrides: Partial<ConversationSkeleton> = {}): ConversationSkeleton {
  return {
    taskId,
    metadata: {
      workspace: '/workspace/project',
      mode: 'code-simple',
      timestamp: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      messageCount: 5,
      actionCount: 3,
      totalSize: 1000,
    },
    messages: [],
    ...overrides,
  } as ConversationSkeleton;
}

function makeCache(...skeletons: ConversationSkeleton[]): Map<string, ConversationSkeleton> {
  return new Map(skeletons.map(s => [s.taskId, s]));
}

function getResponseText(result: any): string {
  return result.content[0].text;
}

// ─────────────────── CONFIGURE XML EXPORT ───────────────────

describe('handleConfigureXmlExport', () => {
  let mockExportConfigManager: any;

  beforeEach(() => {
    mockExportConfigManager = {
      getConfig: vi.fn().mockResolvedValue({ prettyPrint: true, includeContent: false }),
      updateConfig: vi.fn().mockResolvedValue(undefined),
      resetConfig: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('action=get', () => {
    test('retourne la config courante en JSON', async () => {
      const result = await handleConfigureXmlExport({ action: 'get' }, mockExportConfigManager);
      const text = getResponseText(result);
      const parsed = JSON.parse(text);
      expect(parsed.prettyPrint).toBe(true);
      expect(mockExportConfigManager.getConfig).toHaveBeenCalledOnce();
    });
  });

  describe('action=set', () => {
    test('met à jour la config avec le config fourni', async () => {
      const result = await handleConfigureXmlExport(
        { action: 'set', config: { prettyPrint: false } },
        mockExportConfigManager
      );
      const text = getResponseText(result);
      expect(text).toContain('succès');
      expect(mockExportConfigManager.updateConfig).toHaveBeenCalledWith({ prettyPrint: false });
    });

    test('retourne une erreur si config manquante', async () => {
      const result = await handleConfigureXmlExport(
        { action: 'set' },
        mockExportConfigManager
      );
      const text = getResponseText(result);
      expect(text).toContain('Erreur');
    });
  });

  describe('action=reset', () => {
    test('remet la config par défaut', async () => {
      const result = await handleConfigureXmlExport({ action: 'reset' }, mockExportConfigManager);
      const text = getResponseText(result);
      expect(text).toContain('défaut');
      expect(mockExportConfigManager.resetConfig).toHaveBeenCalledOnce();
    });
  });

  describe('erreurs', () => {
    test('action invalide → retourne erreur', async () => {
      const result = await handleConfigureXmlExport(
        { action: 'invalid' as any },
        mockExportConfigManager
      );
      const text = getResponseText(result);
      expect(text).toContain('Erreur');
    });

    test('exception service → retourne erreur', async () => {
      mockExportConfigManager.getConfig.mockRejectedValue(new Error('DB error'));
      const result = await handleConfigureXmlExport({ action: 'get' }, mockExportConfigManager);
      const text = getResponseText(result);
      expect(text).toContain('Erreur');
    });
  });

  describe('configureXmlExportTool (définition MCP)', () => {
    test('name = "configure_xml_export"', () => {
      expect(configureXmlExportTool.name).toBe('configure_xml_export');
    });

    test('description est définie', () => {
      expect(configureXmlExportTool.description.length).toBeGreaterThan(0);
    });

    test('required contient action', () => {
      const required = configureXmlExportTool.inputSchema.required as string[];
      expect(required).toContain('action');
    });
  });
});

// ─────────────────── EXPORT TASKS XML ───────────────────

describe('handleExportTasksXml', () => {
  let mockXmlExporterService: any;
  let mockEnsureFresh: any;

  beforeEach(() => {
    mockXmlExporterService = {
      generateTaskXml: vi.fn().mockReturnValue('<task><id>task-001</id></task>'),
      saveXmlToFile: vi.fn().mockResolvedValue(undefined),
    };
    mockEnsureFresh = vi.fn().mockResolvedValue(undefined);
  });

  describe('succès', () => {
    test('retourne le XML si pas de filePath', async () => {
      const cache = makeCache(makeConversation('task-001'));

      const result = await handleExportTasksXml(
        { taskId: 'task-001' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const text = getResponseText(result);
      expect(text).toContain('<task>');
      expect(mockXmlExporterService.saveXmlToFile).not.toHaveBeenCalled();
    });

    test('sauvegarde le fichier si filePath fourni', async () => {
      const cache = makeCache(makeConversation('task-001'));

      const result = await handleExportTasksXml(
        { taskId: 'task-001', filePath: '/output/task.xml' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const text = getResponseText(result);
      expect(text).toContain('task-001');
      expect(text).toContain('/output/task.xml');
      expect(mockXmlExporterService.saveXmlToFile).toHaveBeenCalledWith(
        '<task><id>task-001</id></task>',
        '/output/task.xml'
      );
    });

    test('appelle generateTaskXml avec les options correctes', async () => {
      const cache = makeCache(makeConversation('task-001'));

      await handleExportTasksXml(
        { taskId: 'task-001', includeContent: true, prettyPrint: false },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      expect(mockXmlExporterService.generateTaskXml).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-001' }),
        { includeContent: true, prettyPrint: false }
      );
    });

    test('appelle ensureSkeletonCacheIsFresh', async () => {
      const cache = makeCache(makeConversation('task-001'));

      await handleExportTasksXml({ taskId: 'task-001' }, cache, mockXmlExporterService, mockEnsureFresh);

      expect(mockEnsureFresh).toHaveBeenCalledOnce();
    });
  });

  describe('erreurs', () => {
    test('tâche non trouvée → retourne erreur', async () => {
      const cache = makeCache(); // empty

      const result = await handleExportTasksXml(
        { taskId: 'unknown-task' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const text = getResponseText(result);
      expect(text).toContain('Erreur');
      expect(text).toContain('unknown-task');
    });

    test('exception service → retourne erreur', async () => {
      const cache = makeCache(makeConversation('task-001'));
      mockXmlExporterService.generateTaskXml.mockImplementation(() => { throw new Error('XML error'); });

      const result = await handleExportTasksXml(
        { taskId: 'task-001' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const text = getResponseText(result);
      expect(text).toContain('Erreur');
    });
  });

  describe('exportTasksXmlTool (définition MCP)', () => {
    test('name = "export_tasks_xml"', () => {
      expect(exportTasksXmlTool.name).toBe('export_tasks_xml');
    });

    test('required contient taskId', () => {
      const required = exportTasksXmlTool.inputSchema.required as string[];
      expect(required).toContain('taskId');
    });
  });
});

// ─────────────────── EXPORT CONVERSATION XML ───────────────────

describe('handleExportConversationXml', () => {
  let mockXmlExporterService: any;
  let mockEnsureFresh: any;

  beforeEach(() => {
    mockXmlExporterService = {
      generateConversationXml: vi.fn().mockReturnValue('<conversation/>'),
      saveXmlToFile: vi.fn().mockResolvedValue(undefined),
    };
    mockEnsureFresh = vi.fn().mockResolvedValue(undefined);
  });

  describe('succès', () => {
    test('retourne le XML si pas de filePath', async () => {
      const cache = makeCache(makeConversation('root-task'));

      const result = await handleExportConversationXml(
        { conversationId: 'root-task' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const text = getResponseText(result);
      expect(text).toBe('<conversation/>');
    });

    test('sauvegarde le fichier si filePath fourni', async () => {
      const cache = makeCache(makeConversation('root-task'));

      const result = await handleExportConversationXml(
        { conversationId: 'root-task', filePath: '/out/conv.xml' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const text = getResponseText(result);
      expect(text).toContain('root-task');
      expect(text).toContain('/out/conv.xml');
      expect(mockXmlExporterService.saveXmlToFile).toHaveBeenCalled();
    });

    test('collecte les tâches enfantes dans le XML', async () => {
      const child = makeConversation('child-task', { parentTaskId: 'root-task' });
      const root = makeConversation('root-task');
      const cache = makeCache(root, child);

      mockXmlExporterService.generateConversationXml.mockImplementation((root: ConversationSkeleton, children: ConversationSkeleton[]) => `<conversation>${[root, ...children].map(t => t.taskId).join(',')}</conversation>`);

      await handleExportConversationXml(
        { conversationId: 'root-task' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const rootTask = mockXmlExporterService.generateConversationXml.mock.calls[0][0] as ConversationSkeleton;
      const children = mockXmlExporterService.generateConversationXml.mock.calls[0][1] as ConversationSkeleton[];
      expect(rootTask.taskId).toBe('root-task');
      expect(children.some(t => t.taskId === 'child-task')).toBe(true);
    });

    test('respecte maxDepth lors de la collecte', async () => {
      const level1 = makeConversation('level1', { parentTaskId: 'root-task' });
      const level2 = makeConversation('level2', { parentTaskId: 'level1' });
      const root = makeConversation('root-task');
      const cache = makeCache(root, level1, level2);

      mockXmlExporterService.generateConversationXml.mockImplementation((root: ConversationSkeleton, children: ConversationSkeleton[]) => `<conversation>${[root, ...children].map(t => t.taskId).join(',')}</conversation>`);

      await handleExportConversationXml(
        { conversationId: 'root-task', maxDepth: 2 },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const children = mockXmlExporterService.generateConversationXml.mock.calls[0][1] as ConversationSkeleton[];
      // Avec maxDepth=2: root (depth=0) et level1 (depth=1) sont inclus, level2 (depth=2) est exclu
      // car collectTasks vérifie currentDepth >= maxDepth avant d'inclure
      expect(children.some(t => t.taskId === 'level1')).toBe(true);
      expect(children.some(t => t.taskId === 'level2')).toBe(false);
    });
  });

  describe('erreurs', () => {
    test('conversation non trouvée → retourne erreur', async () => {
      const cache = makeCache();

      const result = await handleExportConversationXml(
        { conversationId: 'unknown' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const text = getResponseText(result);
      expect(text).toContain('Erreur');
    });
  });

  describe('exportConversationXmlTool (définition MCP)', () => {
    test('name = "export_conversation_xml"', () => {
      expect(exportConversationXmlTool.name).toBe('export_conversation_xml');
    });

    test('required contient conversationId', () => {
      const required = exportConversationXmlTool.inputSchema.required as string[];
      expect(required).toContain('conversationId');
    });
  });
});

// ─────────────────── EXPORT PROJECT XML ───────────────────

describe('handleExportProjectXml', () => {
  let mockXmlExporterService: any;
  let mockEnsureFresh: any;

  beforeEach(() => {
    mockXmlExporterService = {
      generateProjectXml: vi.fn().mockReturnValue('<project/>'),
      saveXmlToFile: vi.fn().mockResolvedValue(undefined),
    };
    mockEnsureFresh = vi.fn().mockResolvedValue(undefined);
  });

  describe('succès', () => {
    test('retourne le XML si pas de filePath', async () => {
      const cache = makeCache(
        makeConversation('task-001', { metadata: { workspace: '/workspace/project', lastActivity: '2026-01-01', createdAt: '2026-01-01', messageCount: 3, actionCount: 1, totalSize: 500, mode: 'code' } as any })
      );

      const result = await handleExportProjectXml(
        { projectPath: '/workspace/project' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const text = getResponseText(result);
      expect(text).toBe('<project/>');
    });

    test('sauvegarde le fichier si filePath fourni', async () => {
      const cache = makeCache(makeConversation('task-001'));

      const result = await handleExportProjectXml(
        { projectPath: '/workspace/project', filePath: '/out/proj.xml' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const text = getResponseText(result);
      expect(text).toContain('/out/proj.xml');
      expect(mockXmlExporterService.saveXmlToFile).toHaveBeenCalled();
    });

    test('filtre par workspace normalisé', async () => {
      const task1 = makeConversation('task-001', { metadata: { workspace: '/workspace/project', lastActivity: '2026-01-01', createdAt: '2026-01-01', messageCount: 1, actionCount: 1, totalSize: 100, mode: 'code' } as any });
      const task2 = makeConversation('task-002', { metadata: { workspace: '/other/project', lastActivity: '2026-01-01', createdAt: '2026-01-01', messageCount: 1, actionCount: 1, totalSize: 100, mode: 'code' } as any });
      const cache = makeCache(task1, task2);

      await handleExportProjectXml(
        { projectPath: '/workspace/project' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const tasksArg = mockXmlExporterService.generateProjectXml.mock.calls[0][0] as ConversationSkeleton[];
      expect(tasksArg.some(t => t.taskId === 'task-001')).toBe(true);
      expect(tasksArg.some(t => t.taskId === 'task-002')).toBe(false);
    });

    test('filtre par startDate', async () => {
      const oldTask = makeConversation('old-task', {
        metadata: { workspace: '/workspace/project', lastActivity: '2025-01-01T00:00:00.000Z', createdAt: '2025-01-01T00:00:00.000Z', messageCount: 1, actionCount: 0, totalSize: 100, mode: 'code' } as any
      });
      const newTask = makeConversation('new-task', {
        metadata: { workspace: '/workspace/project', lastActivity: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z', messageCount: 1, actionCount: 0, totalSize: 100, mode: 'code' } as any
      });
      const cache = makeCache(oldTask, newTask);

      await handleExportProjectXml(
        { projectPath: '/workspace/project', startDate: '2026-01-01' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const tasksArg = mockXmlExporterService.generateProjectXml.mock.calls[0][0] as ConversationSkeleton[];
      expect(tasksArg.some(t => t.taskId === 'old-task')).toBe(false);
      expect(tasksArg.some(t => t.taskId === 'new-task')).toBe(true);
    });

    test('appelle ensureSkeletonCacheIsFresh avec le workspace', async () => {
      const cache = makeCache();

      await handleExportProjectXml(
        { projectPath: '/workspace/project' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      expect(mockEnsureFresh).toHaveBeenCalledWith({ workspace: '/workspace/project' });
    });
  });

  describe('erreurs', () => {
    test('exception service → retourne erreur', async () => {
      const cache = makeCache();
      mockXmlExporterService.generateProjectXml.mockImplementation(() => {
        throw new Error('XML generation failed');
      });

      const result = await handleExportProjectXml(
        { projectPath: '/workspace/project' },
        cache,
        mockXmlExporterService,
        mockEnsureFresh
      );

      const text = getResponseText(result);
      expect(text).toContain('Erreur');
    });
  });

  describe('exportProjectXmlTool (définition MCP)', () => {
    test('name = "export_project_xml"', () => {
      expect(exportProjectXmlTool.name).toBe('export_project_xml');
    });

    test('required contient projectPath', () => {
      const required = exportProjectXmlTool.inputSchema.required as string[];
      expect(required).toContain('projectPath');
    });
  });
});
