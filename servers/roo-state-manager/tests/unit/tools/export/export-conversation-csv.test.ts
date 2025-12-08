import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock fs/promises AVANT tout import qui l'utilise
const mockCsvFsPromises = vi.hoisted(() => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    default: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('fs/promises', () => ({
    ...mockCsvFsPromises,
    default: mockCsvFsPromises
}));
import { exportConversationCsvTool } from '../../../../src/tools/export/export-conversation-csv';
import { handleExportConversationCsv } from '../../../../src/tools/export/export-conversation-csv';
import type { ConversationSkeleton } from '../../../../src/types/conversation';
import { TraceSummaryService } from '../../../../src/services/TraceSummaryService';

// Mock des services
const { mockGenerateSummary } = vi.hoisted(() => ({
    mockGenerateSummary: vi.fn()
}));

vi.mock('../../../../src/services/TraceSummaryService', () => {
    return {
        TraceSummaryService: class {
            generateSummary = mockGenerateSummary;
        }
    };
});

vi.mock('../../../../src/services/ExportConfigManager', () => ({
    ExportConfigManager: vi.fn()
}));

describe('export-conversation-csv.tool', () => {
    const mockTaskId = 'test-task-123';
    const mockFilePath = '/tmp/test-export.csv';

    beforeEach(() => {
        vi.clearAllMocks();
        
        // Mock de generateSummary
        mockGenerateSummary.mockResolvedValue({
            success: true,
            content: 'Test CSV content',
            statistics: {
                totalSections: 0,
                userMessages: 1,
                assistantMessages: 1,
                toolResults: 0,
                totalContentSize: 50
            }
        });
    });

    describe('Définition de l\'outil', () => {
        it('devrait avoir le bon nom et description', () => {
        expect(exportConversationCsvTool.name).toBe('export_conversation_csv');
        expect(exportConversationCsvTool.description).toContain('Exporte une conversation au format CSV');
      });
  
      it('devrait avoir les bons paramètres d\'entrée', () => {
        const inputSchema = exportConversationCsvTool.inputSchema;
        expect(inputSchema).toBeDefined();
        expect(inputSchema.type).toBe('object');
        expect(inputSchema.properties).toHaveProperty('taskId');
        expect(inputSchema.properties).toHaveProperty('filePath');
        expect(inputSchema.properties).toHaveProperty('csvVariant');
        expect(inputSchema.properties).toHaveProperty('truncationChars');
        expect(inputSchema.properties).toHaveProperty('startIndex');
        expect(inputSchema.properties).toHaveProperty('endIndex');
      });
  
      it('devrait avoir les valeurs par défaut correctes', () => {
        const inputSchema = exportConversationCsvTool.inputSchema;
        expect(((inputSchema.properties as any).csvVariant as any).default).toBe('conversations');
        expect(((inputSchema.properties as any).truncationChars as any).default).toBe(0);
      });
    });

    describe('Validation des paramètres', () => {
        it('devrait rejeter quand taskId est manquant', async () => {
            const args = { filePath: mockFilePath, taskId: '' };
            const mockGetConversationSkeleton = vi.fn().mockResolvedValue(null);
            
            await expect(handleExportConversationCsv(args as any, mockGetConversationSkeleton)).rejects.toThrow('taskId est requis');
        });

        it('devrait rejeter quand la conversation est introuvable', async () => {
            const args = { filePath: mockFilePath, taskId: 'nonexistent' };
            const mockGetConversationSkeleton = vi.fn().mockResolvedValue(null);
            
            await expect(handleExportConversationCsv(args, mockGetConversationSkeleton)).rejects.toThrow('Conversation avec taskId nonexistent introuvable');
        });

    });

    describe('Exécution de l\'outil', () => {
        let mockTaskId: string;
        let mockFilePath: string;

        beforeEach(() => {
            mockTaskId = 'test-task-123';
            mockFilePath = '/tmp/test-export.csv';

            vi.clearAllMocks();
            
            // Reset mock implementation
            mockGenerateSummary.mockResolvedValue({
                success: true,
                content: 'Test CSV content',
                statistics: {
                    totalSections: 0,
                    userMessages: 1,
                    assistantMessages: 1,
                    toolResults: 0,
                    totalContentSize: 50
                }
            });
        });

        it('devrait exporter avec succès une conversation CSV', async () => {
            const args = {
                taskId: mockTaskId,
                filePath: mockFilePath,
                csvVariant: 'conversations' as const
            };

            const mockGetConversationSkeleton = vi.fn().mockResolvedValue({
                taskId: mockTaskId,
                metadata: {
                    lastActivity: '2024-01-01T00:00:00.000Z',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    messageCount: 5,
                    actionCount: 10,
                    totalSize: 1024
                },
                sequence: [],
                subtasks: []
            });

            const result = await handleExportConversationCsv(args, mockGetConversationSkeleton);

            expect(typeof result).toBe('string');
            expect(result).toContain('**Export CSV généré avec succès pour la tâche test-task-123**');
            expect(result).toContain('**Fichier sauvegardé:** /tmp/test-export.csv');
        });

        it('devrait retourner le contenu quand filePath n\'est pas fourni', async () => {
            const args = {
                taskId: mockTaskId,
                csvVariant: 'conversations' as const
            };

            const mockGetConversationSkeleton = vi.fn().mockResolvedValue({
                taskId: mockTaskId,
                metadata: {
                    lastActivity: '2024-01-01T00:00:00.000Z',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    messageCount: 5,
                    actionCount: 10,
                    totalSize: 1024
                },
                sequence: [],
                subtasks: []
            });

            const result = await handleExportConversationCsv(args, mockGetConversationSkeleton);

            expect(typeof result).toBe('string');
            expect(result).toContain('**Export CSV généré avec succès pour la tâche test-task-123**');
            expect(result).toContain('**CONTENU CSV:**');
            expect(result).toContain('```csv');
        });

        it('devrait gérer les erreurs de génération de résumé', async () => {
            const args = {
                taskId: mockTaskId,
                filePath: mockFilePath,
                csvVariant: 'conversations' as const
            };

            const mockGetConversationSkeleton = vi.fn().mockResolvedValue({
                taskId: mockTaskId,
                metadata: {
                    lastActivity: '2024-01-01T00:00:00.000Z',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    messageCount: 5,
                    actionCount: 10,
                    totalSize: 1024
                },
                sequence: [],
                subtasks: []
            });

            // Mock pour simuler une erreur dans generateSummary
            mockGenerateSummary.mockResolvedValue({
                success: false,
                error: 'Erreur de génération de résumé'
            });

            await expect(handleExportConversationCsv(args, mockGetConversationSkeleton)).rejects.toThrow('Erreur lors de la génération de l\'export CSV: Erreur de génération de résumé');
        });

        it('devrait gérer les erreurs d\'écriture de fichier', async () => {
            const args = {
                taskId: mockTaskId,
                filePath: mockFilePath,
                csvVariant: 'conversations' as const
            };

            const mockGetConversationSkeleton = vi.fn().mockResolvedValue({
                taskId: mockTaskId,
                metadata: {
                    lastActivity: '2024-01-01T00:00:00.000Z',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    messageCount: 5,
                    actionCount: 10,
                    totalSize: 1024
                },
                sequence: [],
                subtasks: []
            });

            // Mock pour simuler une erreur
            mockCsvFsPromises.writeFile.mockRejectedValueOnce(new Error('Permission denied'));

            await expect(handleExportConversationCsv(args, mockGetConversationSkeleton)).rejects.toThrow('Erreur lors de l\'écriture du fichier /tmp/test-export.csv: Error: Permission denied');
        });

        it('devrait créer le répertoire parent si nécessaire', async () => {
            const args = { filePath: '/test/dir/test.csv', taskId: 'test-task-id' };
            const mockGetConversationSkeleton = vi.fn().mockResolvedValue({
                taskId: 'test-task-id',
                metadata: {
                    lastActivity: '2024-01-01T00:00:00.000Z',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    messageCount: 5,
                    actionCount: 10,
                    totalSize: 1024
                },
                sequence: [],
                subtasks: []
            });
            
            await handleExportConversationCsv(args, mockGetConversationSkeleton);
            
            expect(mockCsvFsPromises.mkdir).toHaveBeenCalledWith('/test/dir', { recursive: true });
        });

        it('devrait écrire le fichier avec le contenu CSV', async () => {
            const args = { filePath: mockFilePath, taskId: 'test-task-id' };
            const mockGetConversationSkeleton = vi.fn().mockResolvedValue({
                taskId: 'test-task-id',
                metadata: {
                    lastActivity: '2024-01-01T00:00:00.000Z',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    messageCount: 5,
                    actionCount: 10,
                    totalSize: 1024
                },
                sequence: [],
                subtasks: []
            });
            
            await handleExportConversationCsv(args, mockGetConversationSkeleton);
            
            expect(mockCsvFsPromises.writeFile).toHaveBeenCalledWith(mockFilePath, expect.any(String), 'utf8');
        });

        it('devrait utiliser les options par défaut correctes', async () => {
            const args = { taskId: 'test-task-id' };
            const mockGetConversationSkeleton = vi.fn().mockResolvedValue({
                taskId: 'test-task-id',
                metadata: {
                    lastActivity: '2024-01-01T00:00:00.000Z',
                    createdAt: '2024-01-01T00:00:00.000Z',
                    messageCount: 5,
                    actionCount: 10,
                    totalSize: 1024
                },
                sequence: [],
                subtasks: []
            });
            
            await handleExportConversationCsv(args, mockGetConversationSkeleton);
            
            expect(mockGenerateSummary).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    detailLevel: 'Full',
                    outputFormat: 'csv',
                    csvVariant: 'conversations',
                    truncationChars: 0,
                    compactStats: false,
                    includeCss: false,
                    generateToc: false,
                    startIndex: undefined,
                    endIndex: undefined
                })
            );
        });
    });
});