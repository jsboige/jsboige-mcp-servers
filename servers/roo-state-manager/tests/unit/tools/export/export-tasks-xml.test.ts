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

    expect(result.content).toBeDefined();
    expect(result.content[0].text).toContain('sauvegardé dans');
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

    expect(result.content).toBeDefined();
    expect(result.content[0].text).toContain('Service error');
  });
});