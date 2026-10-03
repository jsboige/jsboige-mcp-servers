import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleExportTasksXml } from '../../../../src/tools/export/export-tasks-xml';
import { XmlExporterService } from '../../../../src/services/XmlExporterService';

describe('export-tasks-xml.tool', () => {
  let mockXmlExporterService: any;
  let mockConversationCache: Map<string, any>;

  beforeEach(() => {
    // Mock des services
    mockXmlExporterService = {
      generateTaskXml: vi.fn(),
      saveXmlToFile: vi.fn(),
    };

    mockConversationCache = new Map();
  });

  it('devrait exporter les tâches en XML avec paramètres valides', async () => {
    const mockTaskId = 'test-task-id';
    const mockFilePath = 'test-tasks.xml';
    const mockIncludeContent = true;
    const mockPrettyPrint = true;

    const mockSkeleton = {
      taskId: mockTaskId,
      metadata: {
        title: 'Test Task'
      }
    };

    mockConversationCache.set(mockTaskId, mockSkeleton);
    mockXmlExporterService.generateTaskXml.mockReturnValue('<tasks>...</tasks>');

    const result = await handleExportTasksXml({
      taskId: mockTaskId,
      filePath: mockFilePath,
      includeContent: mockIncludeContent,
      prettyPrint: mockPrettyPrint
    }, mockConversationCache, mockXmlExporterService, vi.fn().mockResolvedValue(undefined));

    // Contrat exact du handler (export-tasks-xml.ts:86-91) : un seul bloc
    // texte, message nominatif qui cite la tâche ET le chemin de sortie.
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe("Export XML de la tâche 'test-task-id' sauvegardé dans 'test-tasks.xml'.");
    expect(mockXmlExporterService.generateTaskXml).toHaveBeenCalledWith(mockSkeleton, {
      includeContent: mockIncludeContent,
      prettyPrint: mockPrettyPrint
    });
    expect(mockXmlExporterService.saveXmlToFile).toHaveBeenCalledWith('<tasks>...</tasks>', mockFilePath);
  });

  it('devrait gérer les erreurs de service', async () => {
    const mockTaskId = 'test-task-id';
    const mockFilePath = 'test-tasks.xml';

    mockConversationCache.set(mockTaskId, {});
    mockXmlExporterService.generateTaskXml.mockImplementation(() => {
      throw new Error('Service error');
    });

    const result = await handleExportTasksXml({
      taskId: mockTaskId,
      filePath: mockFilePath,
      includeContent: true,
      prettyPrint: true
    }, mockConversationCache, mockXmlExporterService, vi.fn().mockResolvedValue(undefined));

    // Contrat d'erreur (export-tasks-xml.ts:101-108) : un seul bloc texte,
    // préfixe « Erreur lors de l'export XML : » + message de l'exception.
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('Erreur lors de l\'export XML : Service error');
  });
});