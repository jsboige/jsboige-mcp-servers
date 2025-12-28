import { describe, it, expect, beforeEach, vi } from 'vitest';
import { exportConversationJsonTool } from '../../../../src/tools/export/export-conversation-json';
import { handleExportConversationJson } from '../../../../src/tools/export/export-conversation-json';
import type { ConversationSkeleton } from '../../../../src/types/conversation';

// Mock fs pour vérifier les appels
const mockFs = vi.hoisted(() => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    default: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('fs/promises', () => ({
    ...mockFs,
    default: mockFs
}));

// Mock TraceSummaryService
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

// Mock de la fonction getConversationSkeleton
const mockGetConversationSkeleton = vi.fn();

// Variables de test partagées
const mockTaskId = 'test-task-id';
const mockFilePath = 'test-dir/test-file-path.json';

describe('export-conversation-json.tool', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        // Reset default implementation
        mockGenerateSummary.mockResolvedValue({
            success: true,
            content: 'x'.repeat(2560), // 2.5 KB content
            statistics: {
                totalSections: 5,
                userMessages: 3,
                assistantMessages: 2,
                toolResults: 1,
                totalContentSize: 2048,
                compressionRatio: 1.5
            }
        });
    });

    describe('Définition de l\'outil', () => {
        it('devrait avoir le bon nom et description', () => {
            expect(exportConversationJsonTool.name).toBe('export_conversation_json');
            expect(exportConversationJsonTool.description).toBe("Exporte une conversation au format JSON avec variantes light ou full");
        });

        it('devrait avoir les bons paramètres d\'entrée', () => {
            const schema = exportConversationJsonTool.inputSchema;
            expect((schema.properties as any).taskId).toBeDefined();
            expect((schema.properties as any).filePath).toBeDefined();
            expect((schema.properties as any).jsonVariant).toBeDefined();
            expect((schema.properties as any).truncationChars).toBeDefined();
            expect((schema.properties as any).startIndex).toBeDefined();
            expect((schema.properties as any).endIndex).toBeDefined();
            expect(schema.required).toContain('taskId');
        });

        it('devrait avoir les bonnes valeurs par défaut', () => {
            const schema = exportConversationJsonTool.inputSchema;
            expect(((schema.properties as any).jsonVariant as any).default).toBe('light');
            expect(((schema.properties as any).truncationChars as any).default).toBe(0);
        });
    });

    describe('Validation des paramètres', () => {
        it('devrait valider les variantes JSON autorisées', () => {
            const schema = exportConversationJsonTool.inputSchema;
            expect(((schema.properties as any).jsonVariant as any).enum).toEqual(['light', 'full']);
        });

        it('devrait valider les types de paramètres', () => {
            const schema = exportConversationJsonTool.inputSchema;
            expect(((schema.properties as any).taskId as any).type).toBe('string');
            expect(((schema.properties as any).filePath as any).type).toBe('string');
            expect(((schema.properties as any).jsonVariant as any).type).toBe('string');
            expect(((schema.properties as any).truncationChars as any).type).toBe('number');
            expect(((schema.properties as any).startIndex as any).type).toBe('number');
            expect(((schema.properties as any).endIndex as any).type).toBe('number');
        });
    });

    describe('Exécution de l\'outil', () => {
        it('devrait gérer les arguments manquants', async () => {
            await expect(handleExportConversationJson({} as any, mockGetConversationSkeleton))
                .rejects.toThrow('taskId est requis');
        });

        it('devrait retourner une erreur si la conversation n\'existe pas', async () => {
            mockGetConversationSkeleton.mockResolvedValue(null);
            
            const mockArgs = {
                taskId: mockTaskId,
                filePath: mockFilePath,
                jsonVariant: 'light' as const
            };

            await expect(handleExportConversationJson(mockArgs, mockGetConversationSkeleton))
                .rejects.toThrow('Conversation avec taskId test-task-id introuvable');
        });

        it('devrait gérer les erreurs de lecture du fichier JSON', async () => {
            mockGetConversationSkeleton.mockRejectedValue(new Error('File not found'));
            
            const mockArgs = {
                taskId: mockTaskId,
                filePath: mockFilePath,
                jsonVariant: 'light' as const
            };

            await expect(handleExportConversationJson(mockArgs, mockGetConversationSkeleton))
                .rejects.toThrow('Export JSON échoué: File not found');
        });

        it('devrait gérer les erreurs d\'écriture du fichier', async () => {
            // Mock TraceSummaryService pour succès
            mockGenerateSummary.mockResolvedValue({
                success: true,
                content: 'Contenu JSON',
                statistics: {
                    totalSections: 1,
                    userMessages: 1,
                    assistantMessages: 1,
                    toolResults: 0,
                    totalContentSize: 100,
                    compressionRatio: 2.5
                }
            });

            // Mock fs pour simuler une erreur d'écriture
            mockFs.writeFile.mockRejectedValue(new Error('Permission denied'));

            const mockArgs = {
                taskId: mockTaskId,
                filePath: mockFilePath,
                jsonVariant: 'light' as const
            };

            const mockConversation: ConversationSkeleton = {
                taskId: 'test-task-id',
                metadata: {
                    title: 'Test Task',
                    lastActivity: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    messageCount: 0,
                    actionCount: 0,
                    totalSize: 0
                },
                sequence: []
            };

            mockGetConversationSkeleton.mockResolvedValue(mockConversation);

            await expect(handleExportConversationJson(mockArgs, mockGetConversationSkeleton))
                .rejects.toThrow('Erreur lors de l\'écriture du fichier test-dir/test-file-path.json: Error: Permission denied');
        });

        it('devrait gérer les erreurs du service de résumé', async () => {
            // Mock TraceSummaryService pour erreur
            mockGenerateSummary.mockResolvedValue({
                success: false,
                error: 'Summary generation failed'
            });

            const mockArgs = {
                taskId: mockTaskId,
                filePath: mockFilePath,
                jsonVariant: 'light' as const
            };

            const mockConversation: ConversationSkeleton = {
                taskId: 'test-task-id',
                metadata: {
                    title: 'Test Task',
                    lastActivity: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    messageCount: 0,
                    actionCount: 0,
                    totalSize: 0
                },
                sequence: []
            };

            mockGetConversationSkeleton.mockResolvedValue(mockConversation);

            await expect(handleExportConversationJson(mockArgs, mockGetConversationSkeleton))
                .rejects.toThrow('Erreur lors de la génération de l\'export JSON: Summary generation failed');
        });

        it('devrait gérer les variantes JSON', async () => {
            const mockConversation: ConversationSkeleton = {
                taskId: 'test-task-id',
                metadata: {
                    title: 'Test Task',
                    lastActivity: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    messageCount: 0,
                    actionCount: 0,
                    totalSize: 0
                },
                sequence: []
            };

            mockGetConversationSkeleton.mockResolvedValue(mockConversation);
           
            // Mock TraceSummaryService
            mockGenerateSummary.mockResolvedValue({
                success: true,
                content: 'x'.repeat(2560), // 2.5 KB content
                statistics: {
                    totalSections: 5,
                    userMessages: 3,
                    assistantMessages: 2,
                    toolResults: 1,
                    totalContentSize: 2048,
                    compressionRatio: 1.5
                }
            });

            const mockArgs = {
                taskId: mockTaskId,
                filePath: mockFilePath,
                jsonVariant: 'light' as const
            };

            const result = await handleExportConversationJson(mockArgs, mockGetConversationSkeleton);

            expect(result).toContain('**Export JSON généré avec succès pour la tâche test-task-id**');
            expect(result).toContain('**Fichier sauvegardé:** test-dir/test-file-path.json');
            expect(result).toContain('**Détails de l\'export:**');
            expect(result).toContain('- Variante JSON: light');
            expect(result).toContain('- Taille du fichier: 2.5 KB');
            expect(result).toContain('- Format: JSON structuré');
            expect(result).toContain('**Statistiques de la conversation:**');
            expect(result).toContain('- Total sections: 5');
            expect(result).toContain('- Messages utilisateur: 3');
            expect(result).toContain('- Réponses assistant: 2');
            expect(result).toContain('- Résultats d\'outils: 1');
            expect(result).toContain('- Taille totale originale: 2 KB');
            expect(result).toContain('- Ratio de compression: 1.5x');
        });

        it('devrait gérer la variante full', async () => {
            const mockConversation: ConversationSkeleton = {
                taskId: 'test-task-id',
                metadata: {
                    title: 'Test Task',
                    lastActivity: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    messageCount: 0,
                    actionCount: 0,
                    totalSize: 0
                },
                sequence: []
            };

            mockGetConversationSkeleton.mockResolvedValue(mockConversation);
           
            // Mock TraceSummaryService
            mockGenerateSummary.mockResolvedValue({
                success: true,
                content: 'x'.repeat(4608), // 4.5 KB content
                statistics: {
                    totalSections: 10,
                    userMessages: 6,
                    assistantMessages: 4,
                    toolResults: 2,
                    totalContentSize: 4096,
                    compressionRatio: 1.0
                }
            });

            const mockArgs = {
                taskId: mockTaskId,
                filePath: mockFilePath,
                jsonVariant: 'full' as const
            };

            const result = await handleExportConversationJson(mockArgs, mockGetConversationSkeleton);

            expect(result).toContain('**Export JSON généré avec succès pour la tâche test-task-id**');
            expect(result).toContain('**Fichier sauvegardé:** test-dir/test-file-path.json');
            expect(result).toContain('**Détails de l\'export:**');
            expect(result).toContain('- Variante JSON: full');
            expect(result).toContain('- Taille du fichier: 4.5 KB');
            expect(result).toContain('- Format: JSON structuré');
            expect(result).toContain('**Statistiques de la conversation:**');
            expect(result).toContain('- Total sections: 10');
            expect(result).toContain('- Messages utilisateur: 6');
            expect(result).toContain('- Réponses assistant: 4');
            expect(result).toContain('- Résultats d\'outils: 2');
            expect(result).toContain('- Taille totale originale: 4 KB');
            expect(result).toContain('- Ratio de compression: 1x');
        });
    });

    describe('Gestion des fichiers', () => {
        beforeEach(() => {
            vi.resetAllMocks();
        });

        it('devrait écrire le fichier JSON avec le bon format', async () => {
            const mockConversation: ConversationSkeleton = {
                taskId: 'test-task-id',
                metadata: {
                    title: 'Test Task',
                    lastActivity: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    messageCount: 0,
                    actionCount: 0,
                    totalSize: 0
                },
                sequence: []
            };

            mockGetConversationSkeleton.mockResolvedValue(mockConversation);
           
            // Mock TraceSummaryService
            mockGenerateSummary.mockResolvedValue({
                success: true,
                content: '{"test": "json"}',
                statistics: {
                    totalSections: 1,
                    userMessages: 1,
                    assistantMessages: 1,
                    toolResults: 0,
                    totalContentSize: 50
                }
            });

            const mockArgs = {
                taskId: mockTaskId,
                filePath: mockFilePath,
                jsonVariant: 'light' as const
            };

            await handleExportConversationJson(mockArgs, mockGetConversationSkeleton);

            expect(mockFs.mkdir).toHaveBeenCalledWith(
                expect.stringContaining('test-dir'),
                { recursive: true }
            );
            expect(mockFs.writeFile).toHaveBeenCalledWith(
                mockFilePath,
                '{"test": "json"}',
                'utf8'
            );
        });

        it('devrait retourner une confirmation avec statistiques', async () => {
            const mockConversation: ConversationSkeleton = {
                taskId: 'test-task-id',
                metadata: {
                    title: 'Test Task',
                    lastActivity: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    messageCount: 0,
                    actionCount: 0,
                    totalSize: 0
                },
                sequence: []
            };

            mockGetConversationSkeleton.mockResolvedValue(mockConversation);
           
            // Mock TraceSummaryService
            mockGenerateSummary.mockResolvedValue({
                success: true,
                content: 'x'.repeat(2560), // 2.5 KB content
                statistics: {
                    totalSections: 5,
                    userMessages: 3,
                    assistantMessages: 2,
                    toolResults: 1,
                    totalContentSize: 2048,
                    compressionRatio: 1.5
                }
            });

            const mockArgs = {
                taskId: mockTaskId,
                filePath: mockFilePath,
                jsonVariant: 'light' as const
            };

            const result = await handleExportConversationJson(mockArgs, mockGetConversationSkeleton);

            expect(result).toContain('**Export JSON généré avec succès pour la tâche test-task-id**');
            expect(result).toContain('**Fichier sauvegardé:** test-dir/test-file-path.json');
            expect(result).toContain('**Détails de l\'export:**');
            expect(result).toContain('- Variante JSON: light');
            expect(result).toContain('- Taille du fichier: 2.5 KB');
            expect(result).toContain('- Format: JSON structuré');
            expect(result).toContain('**Statistiques de la conversation:**');
            expect(result).toContain('- Total sections: 5');
            expect(result).toContain('- Messages utilisateur: 3');
            expect(result).toContain('- Réponses assistant: 2');
            expect(result).toContain('- Résultats d\'outils: 1');
            expect(result).toContain('- Taille totale originale: 2 KB');
            expect(result).toContain('- Ratio de compression: 1.5x');
        });
    });
});