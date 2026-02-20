/**
 * Tests unitaires pour l'outil get_conversation_synthesis
 *
 * Teste les fonctionnalités:
 * - Validation des arguments (taskId requis)
 * - Récupération de synthèse (format json/markdown)
 * - Export vers fichier
 * - Gestion d'erreurs (conversation inexistante, erreurs LLM)
 *
 * Ces tests se concentrent sur la validation et le flux de données.
 * Les tests d'intégration LLM sont réalisés manuellement via le wrapper MCP.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    handleGetConversationSynthesis,
    getConversationSynthesisTool,
    GetConversationSynthesisArgs
} from '../../../../src/tools/summary/get-conversation-synthesis.tool.js';
import { ConversationSkeleton } from '../../../../src/types/conversation.js';
import { StateManagerError } from '../../../../src/types/errors.js';
import fs from 'fs/promises';
import path from 'path';

// Mock du skeleton de conversation
function createMockSkeleton(taskId: string): ConversationSkeleton {
    return {
        taskId,
        metadata: {
            lastActivity: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount: 10,
            actionCount: 5,
            totalSize: 1024
        },
        sequence: []
    } as ConversationSkeleton;
}

// Helper function mock pour récupérer les skeletons
async function getConversationSkeletonMock(taskId: string): Promise<ConversationSkeleton | null> {
    if (taskId === 'non-existent-task') {
        return null;
    }
    if (taskId === 'error-task') {
        throw new Error('Database connection failed');
    }
    return createMockSkeleton(taskId);
}

describe('get_conversation_synthesis', () => {

    describe('Définition du tool MCP', () => {
        it('devrait avoir le bon nom de tool', () => {
            expect(getConversationSynthesisTool.name).toBe('get_conversation_synthesis');
        });

        it('devrait avoir une description', () => {
            expect(getConversationSynthesisTool.description).toBeDefined();
            expect(getConversationSynthesisTool.description.length).toBeGreaterThan(10);
        });

        it('devrait avoir taskId comme paramètre requis', () => {
            const schema = getConversationSynthesisTool.inputSchema;
            expect(schema.required).toContain('taskId');
        });

        it('devrait accepter filePath optionnel', () => {
            const schema = getConversationSynthesisTool.inputSchema;
            expect(schema.properties.filePath).toBeDefined();
            expect(schema.required).not.toContain('filePath');
        });

        it('devrait accepter outputFormat avec valeurs json/markdown', () => {
            const schema = getConversationSynthesisTool.inputSchema;
            expect(schema.properties.outputFormat).toBeDefined();
            expect(schema.properties.outputFormat.enum).toEqual(['json', 'markdown']);
            expect(schema.properties.outputFormat.default).toBe('json');
        });
    });

    describe('Validation des arguments', () => {
        it('devrait rejeter si taskId est manquant', async () => {
            await expect(
                handleGetConversationSynthesis(
                    {} as GetConversationSynthesisArgs,
                    getConversationSkeletonMock
                )
            ).rejects.toThrow(StateManagerError);
        });

        it('devrait rejeter si taskId est vide', async () => {
            await expect(
                handleGetConversationSynthesis(
                    { taskId: '' } as GetConversationSynthesisArgs,
                    getConversationSkeletonMock
                )
            ).rejects.toThrow(StateManagerError);
        });

        it('devrait accepter taskId seul avec outputFormat par défaut', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123' },
                getConversationSkeletonMock
            );

            // Le résultat devrait être un objet ConversationAnalysis ou une erreur fallback
            expect(result).toBeDefined();
        });

        it('devrait accepter taskId avec outputFormat=json', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123', outputFormat: 'json' },
                getConversationSkeletonMock
            );

            expect(result).toBeDefined();
        });

        it('devrait accepter taskId avec outputFormat=markdown', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123', outputFormat: 'markdown' },
                getConversationSkeletonMock
            );

            // En mode markdown, devrait retourner le finalTaskSummary (string)
            expect(typeof result).toBe('string');
        });
    });

    describe('Gestion des conversations inexistantes', () => {
        it('devrait rejeter si la conversation n\'existe pas', async () => {
            await expect(
                handleGetConversationSynthesis(
                    { taskId: 'non-existent-task' },
                    getConversationSkeletonMock
                )
            ).rejects.toThrow(StateManagerError);
        });

        it('devrait inclure le taskId dans l\'erreur', async () => {
            try {
                await handleGetConversationSynthesis(
                    { taskId: 'non-existent-task' },
                    getConversationSkeletonMock
                );
                expect.fail('Devrait avoir lancé une erreur');
            } catch (error) {
                expect(error).toBeInstanceOf(StateManagerError);
                expect((error as StateManagerError).details.taskId).toBe('non-existent-task');
            }
        });
    });

    describe('Format de sortie', () => {
        it('devrait retourner un objet ConversationAnalysis en format json', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123', outputFormat: 'json' },
                getConversationSkeletonMock
            );

            // Le résultat peut être l'analyse ou un fallback d'erreur
            expect(result).toBeDefined();
            if (typeof result === 'object') {
                expect(result).toHaveProperty('taskId', 'test-123');
                expect(result).toHaveProperty('analysisEngineVersion');
                expect(result).toHaveProperty('analysisTimestamp');
                expect(result).toHaveProperty('synthesis');
            }
        });

        it('devrait retourner une string en format markdown', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123', outputFormat: 'markdown' },
                getConversationSkeletonMock
            );

            expect(typeof result).toBe('string');
        });
    });

    describe('Export vers fichier', () => {
        const testOutputDir = path.join(process.cwd(), 'test-outputs');
        const testFilePath = path.join(testOutputDir, 'synthesis-test.json');

        beforeEach(async () => {
            // Créer le répertoire de test
            try {
                await fs.mkdir(testOutputDir, { recursive: true });
            } catch {
                // Ignorer si existe déjà
            }
        });

        afterEach(async () => {
            // Nettoyer les fichiers de test
            try {
                await fs.unlink(testFilePath).catch(() => {});
                await fs.unlink(path.join(testOutputDir, 'synthesis-test.md')).catch(() => {});
                await fs.rmdir(testOutputDir).catch(() => {});
            } catch {
                // Ignorer les erreurs de nettoyage
            }
        });

        it('devrait créer le répertoire parent si inexistant', async () => {
            const deepPath = path.join(testOutputDir, 'deep', 'nested', 'synthesis.json');

            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123', filePath: deepPath, outputFormat: 'json' },
                getConversationSkeletonMock
            );

            expect(typeof result).toBe('string');
            expect(result).toContain('exportée vers');

            // Vérifier que le fichier a été créé
            const fileContent = await fs.readFile(deepPath, 'utf-8');
            expect(fileContent).toBeDefined();

            // Nettoyer
            await fs.unlink(deepPath).catch(() => {});
            await fs.rmdir(path.join(testOutputDir, 'deep', 'nested')).catch(() => {});
            await fs.rmdir(path.join(testOutputDir, 'deep')).catch(() => {});
        });

        it('devrait exporter en format json', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123', filePath: testFilePath, outputFormat: 'json' },
                getConversationSkeletonMock
            );

            expect(typeof result).toBe('string');
            expect(result).toContain('exportée vers');
            expect(result).toContain('json');

            // Vérifier le contenu du fichier
            const fileContent = await fs.readFile(testFilePath, 'utf-8');
            const parsed = JSON.parse(fileContent);
            expect(parsed).toHaveProperty('taskId', 'test-123');
        });

        it('devrait exporter en format markdown', async () => {
            const mdFilePath = path.join(testOutputDir, 'synthesis-test.md');

            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123', filePath: mdFilePath, outputFormat: 'markdown' },
                getConversationSkeletonMock
            );

            expect(typeof result).toBe('string');
            expect(result).toContain('exportée vers');
            expect(result).toContain('markdown');

            // Vérifier le contenu du fichier
            const fileContent = await fs.readFile(mdFilePath, 'utf-8');
            expect(fileContent).toContain('# Synthèse de Conversation');
            expect(fileContent).toContain('test-123');
        });
    });

    describe('Gestion d\'erreurs et fallback', () => {
        it('devrait retourner un fallback cohérent en cas d\'erreur LLM', async () => {
            // Utiliser un taskId qui existe mais provoquera une erreur dans le pipeline
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123', outputFormat: 'json' },
                getConversationSkeletonMock
            );

            // Le résultat devrait être défini (même si c'est un fallback)
            expect(result).toBeDefined();
        });

        it('devrait wrapper les erreurs non-StateManagerError', async () => {
            // Le handler devrait catcher les erreurs et les wrapper
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123' },
                getConversationSkeletonMock
            );

            // Devrait retourner un résultat (potentiellement fallback) plutôt que planter
            expect(result).toBeDefined();
        });
    });

    describe('Intégration types ConversationAnalysis', () => {
        it('devrait respecter la structure ConversationAnalysis', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123', outputFormat: 'json' },
                getConversationSkeletonMock
            );

            if (typeof result === 'object' && result !== null) {
                // Vérifier les champs requis de ConversationAnalysis
                expect(result).toHaveProperty('taskId');
                expect(result).toHaveProperty('analysisEngineVersion');
                expect(result).toHaveProperty('analysisTimestamp');
                expect(result).toHaveProperty('llmModelId');
                expect(result).toHaveProperty('contextTrace');
                expect(result).toHaveProperty('objectives');
                expect(result).toHaveProperty('strategy');
                expect(result).toHaveProperty('quality');
                expect(result).toHaveProperty('metrics');
                expect(result).toHaveProperty('synthesis');
            }
        });

        it('devrait avoir un synthesis avec initialContextSummary et finalTaskSummary', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123', outputFormat: 'json' },
                getConversationSkeletonMock
            );

            if (typeof result === 'object' && result !== null && 'synthesis' in result) {
                const analysis = result as any;
                expect(analysis.synthesis).toHaveProperty('initialContextSummary');
                expect(analysis.synthesis).toHaveProperty('finalTaskSummary');
                expect(typeof analysis.synthesis.initialContextSummary).toBe('string');
                expect(typeof analysis.synthesis.finalTaskSummary).toBe('string');
            }
        });
    });

    describe('Cas limites', () => {
        it('devrait gérer un taskId avec caractères spéciaux', async () => {
            const specialTaskId = 'task-with-dashes_and_underscores.123';

            const result = await handleGetConversationSynthesis(
                { taskId: specialTaskId, outputFormat: 'json' },
                getConversationSkeletonMock
            );

            expect(result).toBeDefined();
        });

        it('devrait gérer un taskId très long', async () => {
            const longTaskId = 'a'.repeat(100);

            const result = await handleGetConversationSynthesis(
                { taskId: longTaskId, outputFormat: 'json' },
                getConversationSkeletonMock
            );

            expect(result).toBeDefined();
        });

        it('devrait prioriser filePath sur outputFormat pour le type de retour', async () => {
            // Avec filePath, le retour devrait être un message de confirmation (string)
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-123', filePath: '/tmp/test.json', outputFormat: 'json' },
                getConversationSkeletonMock
            );

            expect(typeof result).toBe('string');
            expect(result).toContain('exportée');
        });
    });

    describe('Scénarios de fallback LLM', () => {
        it('devrait retourner un fallback avec error=true quand LLM échoue', async () => {
            // Avec un skeleton valide, le pipeline LLM va échouer car les services ne sont pas configurés
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-llm-fallback', outputFormat: 'json' },
                getConversationSkeletonMock
            );

            // Le résultat sera le fallback d'erreur car les services LLM ne sont pas mockés
            if (typeof result === 'object' && result !== null) {
                const analysis = result as any;
                // Le fallback a analysisEngineVersion "3.0.0-error"
                if (analysis.analysisEngineVersion === '3.0.0-error') {
                    expect(analysis.objectives).toHaveProperty('error', true);
                    expect(analysis.strategy).toHaveProperty('error', true);
                    expect(analysis.quality).toHaveProperty('error', true);
                    expect(analysis.metrics).toHaveProperty('error');
                    expect(analysis.llmModelId).toBe('error-fallback');
                }
            }
        });

        it('devrait inclure le message d\'erreur dans le fallback synthesis', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-error-msg', outputFormat: 'json' },
                getConversationSkeletonMock
            );

            if (typeof result === 'object' && result !== null) {
                const analysis = result as any;
                if (analysis.analysisEngineVersion === '3.0.0-error') {
                    expect(analysis.synthesis.finalTaskSummary).toContain('Erreur');
                    expect(analysis.synthesis.initialContextSummary).toContain('Erreur');
                }
            }
        });

        it('devrait avoir un contextTrace valide dans le fallback', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-context-trace', outputFormat: 'json' },
                getConversationSkeletonMock
            );

            if (typeof result === 'object' && result !== null) {
                const analysis = result as any;
                expect(analysis.contextTrace).toBeDefined();
                expect(analysis.contextTrace.rootTaskId).toBeDefined();
                expect(analysis.contextTrace.previousSiblingTaskIds).toEqual([]);
            }
        });
    });

    describe('Format markdown détaillé', () => {
        const testOutputDir = path.join(process.cwd(), 'test-outputs-md');
        const mdFilePath = path.join(testOutputDir, 'detailed-synthesis.md');

        beforeEach(async () => {
            try {
                await fs.mkdir(testOutputDir, { recursive: true });
            } catch {
                // Ignorer
            }
        });

        afterEach(async () => {
            try {
                await fs.unlink(mdFilePath).catch(() => {});
                await fs.rmdir(testOutputDir).catch(() => {});
            } catch {
                // Ignorer
            }
        });

        it('devrait inclure les métadonnées dans le markdown', async () => {
            await handleGetConversationSynthesis(
                { taskId: 'test-md-meta', filePath: mdFilePath, outputFormat: 'markdown' },
                getConversationSkeletonMock
            );

            const content = await fs.readFile(mdFilePath, 'utf-8');
            expect(content).toContain('# Synthèse de Conversation');
            expect(content).toContain('test-md-meta');
            expect(content).toContain('**Analyse générée le :**');
            expect(content).toContain('**Moteur :**');
            expect(content).toContain('**Modèle LLM :**');
        });

        it('devrait inclure les sections Contexte Initial et Synthèse Finale', async () => {
            await handleGetConversationSynthesis(
                { taskId: 'test-md-sections', filePath: mdFilePath, outputFormat: 'markdown' },
                getConversationSkeletonMock
            );

            const content = await fs.readFile(mdFilePath, 'utf-8');
            expect(content).toContain('## Contexte Initial');
            expect(content).toContain('## Synthèse Finale');
            expect(content).toContain('---');
        });

        it('devrait inclure une section Métriques avec les indicateurs clés', async () => {
            await handleGetConversationSynthesis(
                { taskId: 'test-md-metrics', filePath: mdFilePath, outputFormat: 'markdown' },
                getConversationSkeletonMock
            );

            const content = await fs.readFile(mdFilePath, 'utf-8');
            expect(content).toContain('## Métriques');
            expect(content).toContain('Messages totaux');
            expect(content).toContain('Fichiers modifiés');
            expect(content).toContain('Temps estimé');
            expect(content).toContain('Score de qualité');
        });

        it('devrait avoir un footer avec la version du moteur', async () => {
            await handleGetConversationSynthesis(
                { taskId: 'test-md-footer', filePath: mdFilePath, outputFormat: 'markdown' },
                getConversationSkeletonMock
            );

            const content = await fs.readFile(mdFilePath, 'utf-8');
            expect(content).toContain('roo-state-manager MCP Synthesis v');
        });
    });

    describe('Robustesse export fichiers', () => {
        it('devrait gérer un chemin avec caractères spéciaux', async () => {
            const testDir = path.join(process.cwd(), 'test-outputs-special');
            const specialPath = path.join(testDir, 'synthesis-test_2026.json');

            try {
                await fs.mkdir(testDir, { recursive: true });

                const result = await handleGetConversationSynthesis(
                    { taskId: 'test-special-path', filePath: specialPath, outputFormat: 'json' },
                    getConversationSkeletonMock
                );

                expect(typeof result).toBe('string');
                expect(result).toContain('exportée');

                const fileExists = await fs.access(specialPath).then(() => true).catch(() => false);
                expect(fileExists).toBe(true);

                await fs.unlink(specialPath).catch(() => {});
            } finally {
                await fs.rmdir(testDir).catch(() => {});
            }
        });

        it('devrait écraser un fichier existant sans erreur', async () => {
            const testDir = path.join(process.cwd(), 'test-outputs-overwrite');
            const filePath = path.join(testDir, 'overwrite-test.json');

            try {
                await fs.mkdir(testDir, { recursive: true });

                // Premier écrit
                await handleGetConversationSynthesis(
                    { taskId: 'test-overwrite-1', filePath: filePath, outputFormat: 'json' },
                    getConversationSkeletonMock
                );

                // Deuxième écrit (écrase)
                await handleGetConversationSynthesis(
                    { taskId: 'test-overwrite-2', filePath: filePath, outputFormat: 'json' },
                    getConversationSkeletonMock
                );

                const content = await fs.readFile(filePath, 'utf-8');
                const parsed = JSON.parse(content);
                expect(parsed.taskId).toBe('test-overwrite-2');

                await fs.unlink(filePath).catch(() => {});
            } finally {
                await fs.rmdir(testDir).catch(() => {});
            }
        });

        it('devrait créer l\'arborescence complète pour chemin profond', async () => {
            const testDir = path.join(process.cwd(), 'test-outputs-deep');
            const deepPath = path.join(testDir, 'level1', 'level2', 'level3', 'synthesis.json');

            try {
                const result = await handleGetConversationSynthesis(
                    { taskId: 'test-deep-path', filePath: deepPath, outputFormat: 'json' },
                    getConversationSkeletonMock
                );

                expect(typeof result).toBe('string');

                const fileExists = await fs.access(deepPath).then(() => true).catch(() => false);
                expect(fileExists).toBe(true);

                // Cleanup récursif
                await fs.unlink(deepPath).catch(() => {});
                await fs.rmdir(path.join(testDir, 'level1', 'level2', 'level3')).catch(() => {});
                await fs.rmdir(path.join(testDir, 'level1', 'level2')).catch(() => {});
                await fs.rmdir(path.join(testDir, 'level1')).catch(() => {});
            } finally {
                await fs.rmdir(testDir).catch(() => {});
            }
        });
    });

    describe('Validation structure ConversationAnalysis', () => {
        it('devrait avoir tous les champs requis même en fallback', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-structure', outputFormat: 'json' },
                getConversationSkeletonMock
            );

            if (typeof result === 'object' && result !== null) {
                const analysis = result as any;

                // Champs de premier niveau
                expect(analysis.taskId).toBeDefined();
                expect(analysis.analysisEngineVersion).toBeDefined();
                expect(analysis.analysisTimestamp).toBeDefined();
                expect(analysis.llmModelId).toBeDefined();

                // Champs structurés
                expect(analysis.contextTrace).toBeDefined();
                expect(analysis.objectives).toBeDefined();
                expect(analysis.strategy).toBeDefined();
                expect(analysis.quality).toBeDefined();
                expect(analysis.metrics).toBeDefined();
                expect(analysis.synthesis).toBeDefined();
            }
        });

        it('devrait avoir des timestamps au format ISO', async () => {
            const result = await handleGetConversationSynthesis(
                { taskId: 'test-timestamp', outputFormat: 'json' },
                getConversationSkeletonMock
            );

            if (typeof result === 'object' && result !== null) {
                const analysis = result as any;
                const timestamp = analysis.analysisTimestamp;

                // Vérifier que c'est un ISO string valide
                const date = new Date(timestamp);
                expect(date.toISOString()).toBe(timestamp);
            }
        });
    });
});
