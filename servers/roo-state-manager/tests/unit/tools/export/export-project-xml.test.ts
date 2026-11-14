import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleExportProjectXml } from '../../../../src/tools/export/export-project-xml';
import { XmlExporterService } from '../../../../src/services/XmlExporterService';
describe('export-project-xml.tool', () => {
  let mockXmlExporterService: any;

  beforeEach(() => {
    // Mock des services
    mockXmlExporterService = {
      generateProjectXml: vi.fn(),
      saveXmlToFile: vi.fn(),
      validateExportPath: vi.fn(),
    };
  });

  it('devrait exporter le projet en XML avec paramètres valides', async () => {
    const mockFilePath = 'test-project.xml';
    const mockIncludeContent = true;
    const mockPrettyPrint = true;
    const mockStartDate = '2025-01-01';
    const mockEndDate = '2025-12-31';

    const mockConversationCache = new Map();
    mockConversationCache.set('task-1', {
      taskId: 'task-1',
      metadata: {
        title: 'Task 1',
        lastActivity: '2025-01-01T10:00:00Z',
        workspace: '/test/workspace'
      }
    });
    mockConversationCache.set('task-2', {
      taskId: 'task-2',
      metadata: {
        title: 'Task 2',
        lastActivity: '2025-12-31T15:30:00Z',
        workspace: '/test/workspace'
      }
    });

    mockXmlExporterService.validateExportPath.mockReturnValue(true);
    mockXmlExporterService.generateProjectXml.mockReturnValue('<project>...</project>');

    const result = await handleExportProjectXml({
      projectPath: '/test/workspace',
      filePath: mockFilePath,
      startDate: mockStartDate,
      endDate: mockEndDate,
      prettyPrint: mockPrettyPrint
    }, mockConversationCache, mockXmlExporterService, vi.fn().mockResolvedValue(undefined));

    // #4688 Lot A: the MCP result is a one-element text block (handler L112-118),
    // and the generated XML is the one handed to saveXmlToFile.
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[0].text).toContain('sauvegardé dans');
    expect(result.content[0].text).toBe(
      "Export XML du projet '/test/workspace' sauvegardé dans 'test-project.xml'.",
    );
    expect(mockXmlExporterService.saveXmlToFile).toHaveBeenCalledWith('<project>...</project>', mockFilePath);
    // Date filtering + option pass-through: task-2 (2025-12-31T15:30Z) is past the
    // endDate ceiling (2025-12-31T00:00Z), so only task-1 reaches the exporter.
    expect(mockXmlExporterService.generateProjectXml).toHaveBeenCalledWith(
      [expect.objectContaining({ taskId: 'task-1' })],
      '/test/workspace',
      { startDate: mockStartDate, endDate: mockEndDate, prettyPrint: mockPrettyPrint },
    );
  });

  it('devrait gérer les erreurs de service', async () => {
    const mockFilePath = 'test-project.xml';
    const mockConversationCache = new Map();

    mockXmlExporterService.generateProjectXml.mockImplementation(() => {
      throw new Error('Service error');
    });

    const result = await handleExportProjectXml({
      projectPath: '/test/workspace',
      filePath: mockFilePath,
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      prettyPrint: true
    }, mockConversationCache, mockXmlExporterService, vi.fn().mockResolvedValue(undefined));

    // #4688 Lot A: the error path returns the same one-block shape, carrying the
    // service message verbatim inside the handler's prefix (export-project-xml.ts L128-136).
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[0].text).toContain('Service error');
    expect(result.content[0].text).toBe(
      "Erreur lors de l'export XML du projet : Service error",
    );
  });
});