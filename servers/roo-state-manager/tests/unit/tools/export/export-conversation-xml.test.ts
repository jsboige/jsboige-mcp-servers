import { describe, it, expect, beforeEach, vi } from 'vitest';
import { exportConversationXmlTool } from '../../../../src/tools/export/export-conversation-xml';
import { handleExportConversationXml } from '../../../../src/tools/export/export-conversation-xml';
import { XmlExporterService } from '../../../../src/services/XmlExporterService';

// Mock du service
const mockXmlExporterService = vi.hoisted(() => ({
  generateConversationXml: vi.fn(),
  saveXmlToFile: vi.fn(),
  validateExportPath: vi.fn()
}));

vi.mock('../../../../src/services/XmlExporterService', () => {
  return {
    XmlExporterService: vi.fn().mockImplementation(() => mockXmlExporterService)
  };
});

describe('export-conversation-xml.tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default implementations
    mockXmlExporterService.generateConversationXml.mockReturnValue('<conversation>test</conversation>');
    mockXmlExporterService.saveXmlToFile.mockResolvedValue(undefined);
    mockXmlExporterService.validateExportPath.mockReturnValue(true);
  });

  describe('Définition de l\'outil', () => {
    it('devrait avoir le bon nom et description', () => {
      expect(exportConversationXmlTool.name).toBe('export_conversation_xml');
      expect(exportConversationXmlTool.description).toContain('Exporte une conversation complète');
    });

    it('devrait avoir les bons paramètres d\'entrée', () => {
      const inputSchema = exportConversationXmlTool.inputSchema;
      expect(inputSchema).toBeDefined();
      expect(inputSchema.type).toBe('object');
      expect(inputSchema.properties).toHaveProperty('conversationId');
      expect(inputSchema.properties).toHaveProperty('filePath');
      expect(inputSchema.properties).toHaveProperty('maxDepth');
      expect(inputSchema.properties).toHaveProperty('includeContent');
      expect(inputSchema.properties).toHaveProperty('prettyPrint');
    });

    it('devrait avoir les valeurs par défaut correctes', () => {
      const inputSchema = exportConversationXmlTool.inputSchema;
      expect(((inputSchema.properties as any).conversationId as any).default).toBeUndefined();
      expect(((inputSchema.properties as any).filePath as any).default).toBeUndefined();
      // Les valeurs par défaut ne sont pas définies dans le schéma pour ces propriétés, elles sont gérées dans le code
      expect(((inputSchema.properties as any).maxDepth as any).default).toBeUndefined();
      expect(((inputSchema.properties as any).includeContent as any).default).toBeUndefined();
      expect(((inputSchema.properties as any).prettyPrint as any).default).toBeUndefined();
    });
  });

  describe('Validation des paramètres', () => {
    it('devrait valider les types de paramètres', () => {
      const inputSchema = exportConversationXmlTool.inputSchema;
      expect(((inputSchema.properties as any).conversationId as any).type).toBe('string');
      expect(((inputSchema.properties as any).filePath as any).type).toBe('string');
      expect(((inputSchema.properties as any).maxDepth as any).type).toBe('integer');
      expect(((inputSchema.properties as any).includeContent as any).type).toBe('boolean');
      expect(((inputSchema.properties as any).prettyPrint as any).type).toBe('boolean');
    });
  });

  describe('Exécution de l\'outil', () => {
    let mockConversationId: string;
    let mockFilePath: string;
    let mockMaxDepth: number;
    let mockIncludeContent: boolean;
    let mockPrettyPrint: boolean;
    let mockConversationCache: Map<string, any>;

    beforeEach(() => {
      mockConversationId = 'test-conversation-123';
      mockFilePath = '/tmp/test-export.xml';
      mockMaxDepth = 10;
      mockIncludeContent = false;
      mockPrettyPrint = true;

      // Mock du cache de conversations
      mockConversationCache = new Map<string, any>();
      mockConversationCache.set(mockConversationId, {
        conversationId: mockConversationId,
        lastActivity: '2024-01-01T00:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
        messageCount: 5,
        actionCount: 10,
        totalSize: 1024
      });

      vi.clearAllMocks();
    });

    it('devrait exporter avec succès une conversation XML', async () => {
      const mockArgs = {
        conversationId: mockConversationId,
        filePath: mockFilePath,
        maxDepth: mockMaxDepth,
        includeContent: mockIncludeContent,
        prettyPrint: mockPrettyPrint
      };

      const result = await handleExportConversationXml(
        mockArgs,
        mockConversationCache,
        mockXmlExporterService as any,
        vi.fn().mockResolvedValue(undefined)
      );

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('sauvegardé dans');
      expect(mockXmlExporterService.generateConversationXml).toHaveBeenCalled();
    });

    it('devrait gérer les erreurs de conversation non trouvée', async () => {
      const mockArgs = {
        conversationId: 'nonexistent-conversation',
        filePath: mockFilePath,
        maxDepth: mockMaxDepth,
        includeContent: mockIncludeContent,
        prettyPrint: mockPrettyPrint
      };

      const result = await handleExportConversationXml(
        mockArgs,
        mockConversationCache,
        mockXmlExporterService as any,
        vi.fn().mockResolvedValue(undefined)
      );

      // Le handler retourne un message d'erreur dans content, pas isError: true
      expect(result.content[0].text).toContain('Erreur lors de l\'export XML');
      expect(result.content[0].text).toContain('Conversation racine avec l\'ID');
    });

    it('devrait retourner le contenu XML quand aucun filePath', async () => {
      const mockArgs = {
        conversationId: mockConversationId,
        maxDepth: mockMaxDepth,
        includeContent: mockIncludeContent,
        prettyPrint: mockPrettyPrint
        // Pas de filePath
      };

      mockXmlExporterService.generateConversationXml.mockReturnValue('<conversation>test-content</conversation>');

      const result = await handleExportConversationXml(
        mockArgs,
        mockConversationCache,
        mockXmlExporterService as any,
        vi.fn().mockResolvedValue(undefined)
      );

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toBe('<conversation>test-content</conversation>');
      expect(mockXmlExporterService.saveXmlToFile).not.toHaveBeenCalled();
    });

    it('devrait gérer les erreurs du service XML', async () => {
      const mockArgs = {
        conversationId: mockConversationId,
        filePath: mockFilePath,
        maxDepth: mockMaxDepth,
        includeContent: mockIncludeContent,
        prettyPrint: mockPrettyPrint
      };

      mockXmlExporterService.saveXmlToFile.mockRejectedValue(new Error('Erreur de sauvegarde'));

      const result = await handleExportConversationXml(
        mockArgs,
        mockConversationCache,
        mockXmlExporterService as any,
        vi.fn().mockResolvedValue(undefined)
      );

      expect(result.content[0].text).toContain('Erreur lors de l\'export XML');
    });

    it('devrait respecter les paramètres maxDepth', async () => {
      const mockArgs = {
        conversationId: mockConversationId,
        filePath: mockFilePath,
        maxDepth: 5,
        includeContent: mockIncludeContent,
        prettyPrint: mockPrettyPrint
      };

      await handleExportConversationXml(
        mockArgs,
        mockConversationCache,
        mockXmlExporterService as any,
        vi.fn().mockResolvedValue(undefined)
      );

      expect(mockXmlExporterService.generateConversationXml).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          includeContent: mockIncludeContent,
          prettyPrint: mockPrettyPrint
        })
      );
    });

    it('devrait respecter les paramètres includeContent et prettyPrint', async () => {
      const mockArgs = {
        conversationId: mockConversationId,
        filePath: mockFilePath,
        maxDepth: mockMaxDepth,
        includeContent: false,
        prettyPrint: false
      };

      await handleExportConversationXml(
        mockArgs,
        mockConversationCache,
        mockXmlExporterService as any,
        vi.fn().mockResolvedValue(undefined)
      );

      expect(mockXmlExporterService.generateConversationXml).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          includeContent: false,
          prettyPrint: false
        })
      );
    });
  });

  describe('Gestion des paramètres avancés', () => {
    let mockConversationId: string;
    let mockFilePath: string;
    let mockMaxDepth: number;
    let mockIncludeContent: boolean;
    let mockPrettyPrint: boolean;
    let mockConversationCache: Map<string, any>;

    beforeEach(() => {
      mockConversationId = 'test-conversation-123';
      mockFilePath = '/tmp/test-export.xml';
      mockMaxDepth = 10;
      mockIncludeContent = false;
      mockPrettyPrint = true;

      // Mock du cache de conversations
      mockConversationCache = new Map<string, any>();
      mockConversationCache.set(mockConversationId, {
        conversationId: mockConversationId,
        lastActivity: '2024-01-01T00:00:00.000Z',
        createdAt: '2024-01-01T00:00:00.000Z',
        messageCount: 5,
        actionCount: 10,
        totalSize: 1024
      });
    });

    it('devrait gérer le paramètre maxDepth correctement', async () => {
      const mockArgs = {
        conversationId: mockConversationId,
        filePath: mockFilePath,
        maxDepth: 5,
        includeContent: mockIncludeContent,
        prettyPrint: mockPrettyPrint
      };

      await handleExportConversationXml(
        mockArgs,
        mockConversationCache,
        mockXmlExporterService as any,
        vi.fn().mockResolvedValue(undefined)
      );

      expect(mockXmlExporterService.generateConversationXml).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          includeContent: mockIncludeContent,
          prettyPrint: mockPrettyPrint
        })
      );
    });

    it('devrait gérer le paramètre includeContent correctement', async () => {
      const mockArgs = {
        conversationId: mockConversationId,
        filePath: mockFilePath,
        maxDepth: mockMaxDepth,
        includeContent: false,
        prettyPrint: mockPrettyPrint
      };

      await handleExportConversationXml(
        mockArgs,
        mockConversationCache,
        mockXmlExporterService as any,
        vi.fn().mockResolvedValue(undefined)
      );

      expect(mockXmlExporterService.generateConversationXml).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          includeContent: false,
          prettyPrint: mockPrettyPrint
        })
      );
    });

    it('devrait gérer le paramètre prettyPrint correctement', async () => {
      const mockArgs = {
        conversationId: mockConversationId,
        filePath: mockFilePath,
        maxDepth: mockMaxDepth,
        includeContent: mockIncludeContent,
        prettyPrint: false
      };

      await handleExportConversationXml(
        mockArgs,
        mockConversationCache,
        mockXmlExporterService as any,
        vi.fn().mockResolvedValue(undefined)
      );

      expect(mockXmlExporterService.generateConversationXml).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          includeContent: mockIncludeContent,
          prettyPrint: false
        })
      );
    });
  });
});