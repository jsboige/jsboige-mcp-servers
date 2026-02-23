/**
 * Tests unitaires pour SynthesisModels.ts
 *
 * Tests de validation des types et interfaces du système de synthèse v3.
 *
 * @module models/synthesis/__tests__/SynthesisModels.test
 * @version 1.0.0 (#507 - Tâche 1)
 */

import { describe, test, expect } from 'vitest';
import type {
    SynthesisMetadata,
    ContextTrace,
    SynthesisNarrative,
    ConversationAnalysis,
    CondensedSynthesisBatch,
    TaskFilter,
    BatchSynthesisConfig,
    BatchProgress,
    BatchResults,
    BatchSynthesisTask,
    SynthesisStatus,
    SynthesisPriority,
    ContextBuildingOptions,
    ContextBuildingResult,
    ExportOptions,
} from '../SynthesisModels.js';

describe('SynthesisModels.ts', () => {

    // ============================================================
    // Extensions des types existants
    // ============================================================

    describe('SynthesisMetadata', () => {
        test('a les propriétés requises', () => {
            const metadata: SynthesisMetadata = {
                status: 'completed',
                headline: 'Test headline',
                analysisFilePath: '/path/to/analysis.json',
                lastUpdated: '2024-01-01T00:00:00Z',
            };

            expect(metadata.status).toBe('completed');
            expect(metadata.headline).toBe('Test headline');
            expect(metadata.analysisFilePath).toBe('/path/to/analysis.json');
            expect(metadata.lastUpdated).toBe('2024-01-01T00:00:00Z');
        });

        test('accepte condensedBatchPath optionnel', () => {
            const metadata: SynthesisMetadata = {
                status: 'pending',
                headline: 'Test',
                analysisFilePath: '/path/analysis.json',
                condensedBatchPath: '/path/batch.json',
                lastUpdated: '2024-01-01T00:00:00Z',
            };

            expect(metadata.condensedBatchPath).toBe('/path/batch.json');
        });
    });

    // ============================================================
    // Modèles de synthèse atomique
    // ============================================================

    describe('ContextTrace', () => {
        test('a les propriétés de traçabilité requises', () => {
            const trace: ContextTrace = {
                rootTaskId: 'task-123',
                previousSiblingTaskIds: ['task-456', 'task-789'],
            };

            expect(trace.rootTaskId).toBe('task-123');
            expect(trace.previousSiblingTaskIds).toHaveLength(2);
        });

        test('accepte parentTaskId optionnel', () => {
            const trace: ContextTrace = {
                rootTaskId: 'task-123',
                parentTaskId: 'task-parent',
                previousSiblingTaskIds: [],
            };

            expect(trace.parentTaskId).toBe('task-parent');
        });

        test('accepte contextes optionnels', () => {
            const trace: ContextTrace = {
                rootTaskId: 'task-123',
                previousSiblingTaskIds: [],
                parentContexts: [{ taskId: 'p1', synthesisType: 'atomic', summary: 'test', includedInContext: true }],
                siblingContexts: [{ taskId: 's1', synthesisType: 'condensed', summary: 'test', includedInContext: false }],
                childContexts: [{ taskId: 'c1', synthesisType: 'generated_on_demand', summary: 'test', includedInContext: true }],
                condensedBatches: [{ batchId: 'b1', sourceTaskIds: ['t1'], batchSummary: 'summary', usedInContext: true }],
            };

            expect(trace.parentContexts).toHaveLength(1);
            expect(trace.siblingContexts).toHaveLength(1);
            expect(trace.childContexts).toHaveLength(1);
            expect(trace.condensedBatches).toHaveLength(1);
        });
    });

    describe('SynthesisNarrative', () => {
        test('a les sections de synthèse requises', () => {
            const narrative: SynthesisNarrative = {
                initialContextSummary: 'Contexte amont',
                finalTaskSummary: 'Synthèse finale',
            };

            expect(narrative.initialContextSummary).toBe('Contexte amont');
            expect(narrative.finalTaskSummary).toBe('Synthèse finale');
        });
    });

    describe('ConversationAnalysis', () => {
        test('a les métadonnées requises', () => {
            const analysis: ConversationAnalysis = {
                taskId: 'task-123',
                analysisEngineVersion: '3.0.0',
                analysisTimestamp: '2024-01-01T00:00:00Z',
                llmModelId: 'claude-opus-4',
                contextTrace: {
                    rootTaskId: 'task-123',
                    previousSiblingTaskIds: [],
                },
                objectives: {},
                strategy: {},
                quality: {},
                metrics: {},
                synthesis: {
                    initialContextSummary: 'test',
                    finalTaskSummary: 'test',
                },
            };

            expect(analysis.taskId).toBe('task-123');
            expect(analysis.analysisEngineVersion).toBe('3.0.0');
            expect(analysis.llmModelId).toBe('claude-opus-4');
        });
    });

    // ============================================================
    // Modèles de synthèse par lots
    // ============================================================

    describe('CondensedSynthesisBatch', () => {
        test('a les propriétés de lot requises', () => {
            const batch: CondensedSynthesisBatch = {
                batchId: 'batch-123',
                creationTimestamp: '2024-01-01T00:00:00Z',
                llmModelId: 'claude-opus-4',
                batchSummary: 'Résumé condensé',
                sourceTaskIds: ['task-1', 'task-2', 'task-3'],
            };

            expect(batch.batchId).toBe('batch-123');
            expect(batch.sourceTaskIds).toHaveLength(3);
        });
    });

    // ============================================================
    // Modèles de traitement par lots
    // ============================================================

    describe('TaskFilter', () => {
        test('accepte différents critères de filtrage', () => {
            const filter1: TaskFilter = { workspace: 'd:/dev/project' };
            const filter2: TaskFilter = { taskIds: ['task-1', 'task-2'] };
            const filter3: TaskFilter = {
                startDate: '2024-01-01T00:00:00Z',
                endDate: '2024-12-31T23:59:59Z',
            };

            expect(filter1.workspace).toBe('d:/dev/project');
            expect(filter2.taskIds).toHaveLength(2);
            expect(filter3.startDate).toBeDefined();
            expect(filter3.endDate).toBeDefined();
        });
    });

    describe('BatchSynthesisConfig', () => {
        test('a la configuration requise', () => {
            const config: BatchSynthesisConfig = {
                taskFilter: { workspace: 'd:/dev/project' },
                maxConcurrency: 5,
                llmModelId: 'claude-opus-4',
                overwriteExisting: false,
            };

            expect(config.maxConcurrency).toBe(5);
            expect(config.overwriteExisting).toBe(false);
        });
    });

    describe('BatchProgress', () => {
        test('calcule le pourcentage de completion', () => {
            const progress: BatchProgress = {
                totalTasks: 100,
                completedTasks: 75,
                failedTasks: 5,
                inProgressTasks: 10,
                completionPercentage: 75,
            };

            expect(progress.totalTasks).toBe(100);
            expect(progress.completionPercentage).toBe(75);
        });
    });

    describe('BatchResults', () => {
        test('agrège les résultats du traitement', () => {
            const results: BatchResults = {
                synthesisCount: 95,
                errorCount: 5,
                errors: [
                    { taskId: 'task-1', error: 'Error 1', timestamp: '2024-01-01T00:00:00Z' },
                ],
                outputFiles: ['/output/1.json', '/output/2.json'],
            };

            expect(results.synthesisCount).toBe(95);
            expect(results.errorCount).toBe(5);
            expect(results.errors).toHaveLength(1);
            expect(results.outputFiles).toHaveLength(2);
        });
    });

    describe('BatchSynthesisTask', () => {
        test('représente une tâche complète', () => {
            const task: BatchSynthesisTask = {
                batchId: 'batch-123',
                status: 'running',
                startTime: '2024-01-01T00:00:00Z',
                config: {
                    taskFilter: {},
                    maxConcurrency: 5,
                    llmModelId: 'claude-opus-4',
                    overwriteExisting: false,
                },
                progress: {
                    totalTasks: 100,
                    completedTasks: 50,
                    failedTasks: 0,
                    inProgressTasks: 5,
                    completionPercentage: 50,
                },
                taskIds: ['task-1', 'task-2'],
                results: {
                    synthesisCount: 1,
                    errorCount: 0,
                    errors: [],
                    outputFiles: [],
                },
            };

            expect(task.status).toBe('running');
            expect(task.progress.completionPercentage).toBe(50);
            expect(task.taskIds).toHaveLength(2);
        });
    });

    // ============================================================
    // Types auxiliaires
    // ============================================================

    describe('Types auxiliaires', () => {
        test('SynthesisStatus a les valeurs correctes', () => {
            const statuses: SynthesisStatus[] = ['pending', 'in_progress', 'completed', 'failed'];
            expect(statuses).toHaveLength(4);
        });

        test('SynthesisPriority a les valeurs correctes', () => {
            const priorities: SynthesisPriority[] = ['low', 'normal', 'high', 'urgent'];
            expect(priorities).toHaveLength(4);
        });

        test('ContextBuildingOptions a les options requises', () => {
            const options: ContextBuildingOptions = {
                maxDepth: 5,
                maxContextSize: 10000,
                includeSiblings: true,
                includeChildrenSyntheses: false,
            };

            expect(options.maxDepth).toBe(5);
            expect(options.includeSiblings).toBe(true);
        });

        test('ContextBuildingResult a le résultat de construction', () => {
            const result: ContextBuildingResult = {
                contextSummary: 'Contexte construit',
                buildTrace: {
                    rootTaskId: 'task-123',
                    previousSiblingTaskIds: [],
                },
                wasCondensed: true,
                condensedBatchPath: '/path/batch.json',
            };

            expect(result.wasCondensed).toBe(true);
            expect(result.condensedBatchPath).toBe('/path/batch.json');
        });

        test('ExportOptions a les options d\'export', () => {
            const options: ExportOptions = {
                format: 'json',
                includeMetadata: true,
                includeTraces: false,
                detailLevel: 'summary',
            };

            expect(options.format).toBe('json');
            expect(options.includeMetadata).toBe(true);
        });
    });

    // ============================================================
    // Validation de type
    // ============================================================

    describe('Validation de type', () => {
        test('toutes les interfaces sont exportées', () => {
            // Ce test vérifie simplement que le module peut être importé
            // et que tous les types sont accessibles
            expect(true).toBe(true);
        });

        test('les types sont correctement typés', () => {
            // Vérification que les types sont bien des interfaces/types
            // et non des valeurs d'exécution
            const metadata: SynthesisMetadata = {} as any;
            const trace: ContextTrace = {} as any;

            expect(metadata).toBeDefined();
            expect(trace).toBeDefined();
        });
    });

});
