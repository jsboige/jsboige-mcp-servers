/**
 * Tests unitaires pour les services de synthèse - Phase 1 SDDD
 *
 * Tests structurels avec configurations valides et patterns existants
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// Mock complet du service OpenAI avec structure ConversationAnalysis - AVANT les imports pour ESM
vi.mock('../../../src/services/openai.js', () => ({
    __esModule: true,
    default: vi.fn(() => ({
        chat: {
            completions: {
                create: vi.fn().mockResolvedValue({
                    id: 'chatcmpl-mock-id',
                    object: 'chat.completion',
                    created: Date.now(),
                    model: 'gpt-4o-mini',
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: JSON.stringify({
                                taskId: 'mock-task-id',
                                analysisEngineVersion: '3.0.0-phase3',
                                analysisTimestamp: new Date().toISOString(),
                                llmModelId: 'gpt-4o-mini',
                                contextTrace: {
                                    rootTaskId: 'mock-root',
                                    parentTaskId: null,
                                    previousSiblingTaskIds: []
                                },
                                objectives: {
                                    primary_goal: 'Mock primary goal',
                                    secondary_goals: ['Mock secondary goal 1', 'Mock secondary goal 2'],
                                    success_criteria: ['Mock criterion 1', 'Mock criterion 2']
                                },
                                strategy: {
                                    approach: 'Mock approach description',
                                    tools_used: ['tool1', 'tool2'],
                                    methodology: 'Mock methodology'
                                },
                                quality: {
                                    completeness_score: 0.9,
                                    clarity_score: 0.85,
                                    effectiveness_rating: 'excellent',
                                    issues_found: []
                                },
                                metrics: {
                                    contextLength: 1000,
                                    wasCondensed: false,
                                    processing_time_ms: 500,
                                    complexity_score: 3,
                                    contextTree: {
                                        currentTask: {
                                            taskId: 'mock-task-id',
                                            synthesisType: 'atomic',
                                            includedInContext: true
                                        },
                                        parentTasks: [],
                                        siblingTasks: [],
                                        condensedBatches: []
                                    }
                                },
                                synthesis: {
                                    initialContextSummary: 'Mock initial context summary',
                                    finalTaskSummary: 'Mock final task summary'
                                }
                            })
                        },
                        finish_reason: 'stop'
                    }],
                    usage: {
                        prompt_tokens: 100,
                        completion_tokens: 50,
                        total_tokens: 150
                    }
                })
            }
        }
    }))
}));

import { ConversationAnalysis, CondensedSynthesisBatch } from '../../../src/models/synthesis/SynthesisModels.js';
import { NarrativeContextBuilderService } from '../../../src/services/synthesis/NarrativeContextBuilderService.js';
import { LLMService, LLMServiceOptions, LLMModelConfig } from '../../../src/services/synthesis/LLMService.js';
import { SynthesisOrchestratorService, SynthesisOrchestratorOptions } from '../../../src/services/synthesis/SynthesisOrchestratorService.js';
import dotenv from 'dotenv';
import path from 'path';

describe('Synthesis Services - Phase 1 Structure Validation', () => {

    // Configurations de test valides
    const createValidLLMConfig = (): LLMServiceOptions => ({
        models: [{
            modelId: 'test-gpt-4',
            displayName: 'Test GPT-4',
            provider: 'openai' as const,
            modelName: 'gpt-4',
            maxTokens: 4096,
            costPerInputToken: 0.03,
            costPerOutputToken: 0.06,
            parameters: {
                temperature: 0.7
            }
        }],
        defaultModelId: 'test-gpt-4',
        defaultTimeout: 30000,
        maxRetries: 3,
        retryDelay: 1000,
        enableCaching: false
    });

    const createValidContextBuilderOptions = () => ({
        baseDirectory: '/test/path',
        maxContextSize: 10000,
        enableCondensation: true
    });

    const createValidOrchestratorOptions = (): SynthesisOrchestratorOptions => ({
        synthesisOutputDir: '/test/synthesis',
        maxContextSize: 50000,
        maxConcurrency: 3,
        defaultLlmModel: 'test-gpt-4'
    });

    let narrativeOptions: any;
    let llmOptions: LLMServiceOptions;
    let orchestratorOptions: SynthesisOrchestratorOptions;

    beforeEach(() => {
        narrativeOptions = createValidContextBuilderOptions();
        llmOptions = createValidLLMConfig();
        orchestratorOptions = createValidOrchestratorOptions();
        vi.clearAllMocks();
    });

    describe('Service Instantiation', () => {
        it('should instantiate NarrativeContextBuilderService correctly', () => {
            expect(() => {
                const service = new NarrativeContextBuilderService(narrativeOptions, new Map());
                expect(service).toBeInstanceOf(NarrativeContextBuilderService);
            }).not.toThrow();
        });

        it('should instantiate LLMService correctly with valid config', () => {
            expect(() => {
                const service = new LLMService(llmOptions);
                expect(service).toBeInstanceOf(LLMService);
            }).not.toThrow();
        });

        it('should instantiate SynthesisOrchestratorService correctly', () => {
            expect(() => {
                const contextBuilder = new NarrativeContextBuilderService(narrativeOptions, new Map());
                const llmService = new LLMService(llmOptions);
                const orchestrator = new SynthesisOrchestratorService(
                    contextBuilder,
                    llmService,
                    orchestratorOptions
                );
                expect(orchestrator).toBeInstanceOf(SynthesisOrchestratorService);
            }).not.toThrow();
        });
    });

    describe('Phase 1 Mock Behavior', () => {
        it('should throw Phase 1 not implemented errors for batch methods', async () => {
            const contextBuilder = new NarrativeContextBuilderService(narrativeOptions, new Map());
            const llmService = new LLMService(llmOptions);
            const orchestrator = new SynthesisOrchestratorService(
                contextBuilder,
                llmService,
                orchestratorOptions
            );

            // Test que les m�thodes non impl�ment�es lancent des erreurs "Phase 1"
            await expect(
                orchestrator.startBatchSynthesis({
                    taskFilter: { workspace: '/test' },
                    maxConcurrency: 1,
                    llmModelId: 'test-gpt-4',
                    overwriteExisting: false
                })
            ).rejects.toThrow(/.*Pas encore implémenté \(Phase 1: Squelette\)/);
        });
    });

    describe('Dependency Injection', () => {
        it('should accept dependencies correctly', () => {
            const contextBuilder = new NarrativeContextBuilderService(narrativeOptions, new Map());
            const llmService = new LLMService(llmOptions);

            const orchestrator = new SynthesisOrchestratorService(
                contextBuilder,
                llmService,
                orchestratorOptions
            );

            expect(orchestrator).toBeDefined();
            expect(contextBuilder).toBeDefined();
            expect(llmService).toBeDefined();
        });

        it('should be configurable with options', () => {
            expect(() => {
                new NarrativeContextBuilderService({ baseDirectory: '/custom/path' } as any, new Map());
                const customConfig = createValidLLMConfig();
                customConfig.defaultModelId = 'custom-model';
                customConfig.models[0].modelId = 'custom-model';
                new LLMService(customConfig);
            }).not.toThrow();
        });
    });

    describe('TypeScript Compilation', () => {
        it('should compile correctly with proper types', () => {
            const contextBuilder = new NarrativeContextBuilderService(narrativeOptions, new Map());
            const llmService = new LLMService(llmOptions);
            const orchestrator = new SynthesisOrchestratorService(
                contextBuilder,
                llmService,
                orchestratorOptions
            );

            expect(typeof contextBuilder).toBe('object');
            expect(typeof llmService).toBe('object');
            expect(typeof orchestrator).toBe('object');
        });

        it('should maintain correct instance types', () => {
            const contextBuilder = new NarrativeContextBuilderService(narrativeOptions, new Map());
            const llmService = new LLMService(llmOptions);
            const orchestrator = new SynthesisOrchestratorService(
                contextBuilder,
                llmService,
                orchestratorOptions
            );

            expect(contextBuilder).toBeInstanceOf(NarrativeContextBuilderService);
            expect(llmService).toBeInstanceOf(LLMService);
            expect(orchestrator).toBeInstanceOf(SynthesisOrchestratorService);
        });
    });

    describe('Integration Readiness', () => {
        it('should be ready for Phase 2 implementation', () => {
            const contextBuilder = new NarrativeContextBuilderService(narrativeOptions, new Map());
            const llmService = new LLMService(llmOptions);
            const orchestrator = new SynthesisOrchestratorService(
                contextBuilder,
                llmService,
                orchestratorOptions
            );

            // M�thodes principales existent (m�me si elles throw pour Phase 1)
            expect(typeof contextBuilder.buildNarrativeContext).toBe('function');
            expect(typeof llmService.generateSynthesis).toBe('function');
            expect(typeof orchestrator.synthesizeConversation).toBe('function');
            expect(typeof orchestrator.startBatchSynthesis).toBe('function');
        });

        it('should support method calls (Phase 2: functional methods)', async () => {
            const contextBuilder = new NarrativeContextBuilderService(narrativeOptions, new Map());
            const llmService = new LLMService(llmOptions);
            const orchestrator = new SynthesisOrchestratorService(
                contextBuilder,
                llmService,
                orchestratorOptions
            );

            // Mock du buildNarrativeContext pour �viter les appels fichiers
            vi.spyOn(contextBuilder, 'buildNarrativeContext').mockResolvedValue({
                contextSummary: 'Test context for method validation',
                buildTrace: { rootTaskId: 'test-task-id', previousSiblingTaskIds: [] },
                wasCondensed: false
            });

            // Phase 2: Les méthodes fonctionnent et retournent des résultats
            const result = await orchestrator.synthesizeConversation('test-task-id');

            if (result.analysisEngineVersion === '3.0.0-phase3-error') {
                console.error('DEBUG FAILURE:', JSON.stringify(result.metrics, null, 2));
            }

            // Validation que la méthode fonctionne et retourne une ConversationAnalysis
            expect(result).toBeDefined();
            expect(result.taskId).toBe('test-task-id');
            expect(result.analysisEngineVersion).toBe('3.0.0-phase3');
        });
    });

    describe('Configuration Validation', () => {
        it('should reject LLMService with empty models array', () => {
            expect(() => {
                const invalidConfig: LLMServiceOptions = {
                    models: [], // Empty array should trigger validation error
                    defaultModelId: 'test-gpt-4',
                    defaultTimeout: 30000,
                    maxRetries: 3,
                    retryDelay: 1000,
                    enableCaching: false
                };
                new LLMService(invalidConfig);
            }).toThrow('Au moins un modèle doit être configuré');
        });

        it('should reject LLMService with missing defaultModelId', () => {
            expect(() => {
                const invalidConfig = createValidLLMConfig();
                invalidConfig.defaultModelId = '';
                new LLMService(invalidConfig);
            }).toThrow('Un modèle par défaut doit être spécifié');
        });

        it('should reject LLMService when defaultModelId not in models', () => {
            expect(() => {
                const invalidConfig = createValidLLMConfig();
                invalidConfig.defaultModelId = 'non-existent-model';
                new LLMService(invalidConfig);
            }).toThrow("Le modèle par défaut 'non-existent-model' n'est pas configuré");
        });
    });

    // =========================================================================
    // TESTS PHASE 2 - INT?GRATION CONTEXTE NARRATIF
    // =========================================================================

    describe('Phase 2 - Narrative Context Integration', () => {
        let contextBuilder: NarrativeContextBuilderService;
        let llmService: LLMService;
        let orchestrator: SynthesisOrchestratorService;

        beforeEach(() => {
            // Configuration Phase 2 avec options r?elles
            const contextOptions = {
                synthesisBaseDir: '/test/synthesis',
                condensedBatchesDir: '/test/batches',
                maxContextSizeBeforeCondensation: 50000,
                defaultMaxDepth: 5
            };

            contextBuilder = new NarrativeContextBuilderService(contextOptions, new Map());
            llmService = new LLMService(llmOptions);
            orchestrator = new SynthesisOrchestratorService(
                contextBuilder,
                llmService,
                orchestratorOptions
            );
        });

        describe('Pipeline Integration', () => {
            it('should execute synthesizeConversation without throwing (Phase 2)', async () => {
                // Mock des m?thodes internes pour ?viter les appels r?els aux fichiers
                const mockBuildNarrativeContext = vi.spyOn(contextBuilder, 'buildNarrativeContext')
                    .mockResolvedValue({
                        contextSummary: 'Mock context summary from NarrativeContextBuilder',
                        buildTrace: {
                            rootTaskId: 'test-task-id',
                            parentTaskId: 'parent-task-id',
                            previousSiblingTaskIds: ['sibling-1', 'sibling-2']
                        },
                        wasCondensed: false
                    });

                const result = await orchestrator.synthesizeConversation('test-task-id');

                // V?rifications de base
                expect(result).toBeDefined();
                expect(result.taskId).toBe('test-task-id');
                expect(result.analysisEngineVersion).toBe('3.0.0-phase3');

                // V?rification que le contexte builder a bien ?t? appel?
                expect(mockBuildNarrativeContext).toHaveBeenCalledWith('test-task-id', undefined);

                mockBuildNarrativeContext.mockRestore();
            });

            it('should pass through contextTrace from NarrativeContextBuilder', async () => {
                const expectedTrace = {
                    rootTaskId: 'test-root',
                    parentTaskId: 'test-parent',
                    previousSiblingTaskIds: ['sibling-a', 'sibling-b']
                };

                const mockBuildNarrativeContext = vi.spyOn(contextBuilder, 'buildNarrativeContext')
                    .mockResolvedValue({
                        contextSummary: 'Test context',
                        buildTrace: expectedTrace,
                        wasCondensed: true,
                        condensedBatchPath: '/test/batch.json'
                    });

                const result = await orchestrator.synthesizeConversation('test-task-id');

                // V?rification que la trace est bien propag?e
                expect(result.contextTrace).toEqual(expectedTrace);

                // V?rification que les donn?es r?elles du contexte sont dans la synthèse
                expect(result.synthesis.initialContextSummary).toBe('Test context');
                expect(result.metrics.wasCondensed).toBe(true);
                expect(result.metrics.condensedBatchPath).toBe('/test/batch.json');

                mockBuildNarrativeContext.mockRestore();
            });

            it('should handle NarrativeContextBuilder errors gracefully', async () => {
                const mockBuildNarrativeContext = vi.spyOn(contextBuilder, 'buildNarrativeContext')
                    .mockRejectedValue(new Error('Mock context builder error'));

                const result = await orchestrator.synthesizeConversation('test-task-id');

                // V?rification que l'erreur est g?r?e et une analyse d'erreur est retourn?e
                expect(result).toBeDefined();
                expect(result.taskId).toBe('test-task-id');
                expect(result.analysisEngineVersion).toBe('3.0.0-phase3-error');
                expect(result.metrics.error).toContain('Mock context builder error');

                mockBuildNarrativeContext.mockRestore();
            });

            it('should pass through ContextBuildingOptions to NarrativeContextBuilder', async () => {
                const testOptions = {
                    maxDepth: 10,
                    maxContextSize: 25000,
                    includeSiblings: true,
                    includeChildrenSyntheses: false
                };

                const mockBuildNarrativeContext = vi.spyOn(contextBuilder, 'buildNarrativeContext')
                    .mockResolvedValue({
                        contextSummary: 'Options test context',
                        buildTrace: {
                            rootTaskId: 'test-task-id',
                            previousSiblingTaskIds: []
                        },
                        wasCondensed: false
                    });

                await orchestrator.synthesizeConversation('test-task-id', testOptions);

                // V?rification que les options sont bien pass?es
                expect(mockBuildNarrativeContext).toHaveBeenCalledWith('test-task-id', testOptions);

                mockBuildNarrativeContext.mockRestore();
            });
        });

        describe('ConversationAnalysis Structure Validation', () => {
            it('should return properly structured ConversationAnalysis', async () => {
                const mockBuildNarrativeContext = vi.spyOn(contextBuilder, 'buildNarrativeContext')
                    .mockResolvedValue({
                        contextSummary: 'Complete context summary',
                        buildTrace: {
                            rootTaskId: 'root-id',
                            parentTaskId: 'parent-id',
                            previousSiblingTaskIds: []
                        },
                        wasCondensed: false
                    });

                const result = await orchestrator.synthesizeConversation('test-task-id');

                // Validation de la structure ConversationAnalysis compl?te
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

                // Validation de la structure SynthesisNarrative
                expect(result.synthesis).toHaveProperty('initialContextSummary');
                expect(result.synthesis).toHaveProperty('finalTaskSummary');
                expect(result.synthesis.initialContextSummary).toBe('Complete context summary');

                mockBuildNarrativeContext.mockRestore();
            });

            it('should include real metrics from context building', async () => {
                const largeContext = 'A'.repeat(15000); // Contexte de 15k caract?res

                const mockBuildNarrativeContext = vi.spyOn(contextBuilder, 'buildNarrativeContext')
                    .mockResolvedValue({
                        contextSummary: largeContext,
                        buildTrace: {
                            rootTaskId: 'test-task-id',
                            previousSiblingTaskIds: []
                        },
                        wasCondensed: true,
                        condensedBatchPath: '/test/large-batch.json'
                    });

                const result = await orchestrator.synthesizeConversation('test-task-id');

                // V?rification des m?triques r?elles
                expect(result.metrics.contextLength).toBe(15000);
                expect(result.metrics.wasCondensed).toBe(true);
                expect(result.metrics.condensedBatchPath).toBe('/test/large-batch.json');

                mockBuildNarrativeContext.mockRestore();
            });

            // =========================================================================
            // TESTS PHASE 3 - INT?GRATION LLM R?ELLE ET TRA?ABILIT? CONTEXTE
            // =========================================================================

            describe('Phase 3 - Real LLM Integration and Context Tree Traceability', () => {
                let contextBuilder: NarrativeContextBuilderService;
                let llmService: LLMService;
                let orchestrator: SynthesisOrchestratorService;

                beforeEach(() => {
                    const contextOptions = {
                        synthesisBaseDir: '/test/synthesis',
                        condensedBatchesDir: '/test/batches',
                        maxContextSizeBeforeCondensation: 50000,
                        defaultMaxDepth: 5
                    };

                    contextBuilder = new NarrativeContextBuilderService(contextOptions, new Map());
                    llmService = new LLMService(llmOptions);
                    orchestrator = new SynthesisOrchestratorService(
                        contextBuilder,
                        llmService,
                        orchestratorOptions
                    );
                });

                describe('Context Tree Traceability', () => {
                    it('should include contextTree with skeleton status in metrics', async () => {
                        // Mock du contexte pour ?viter les appels r?els
                        vi.spyOn(contextBuilder, 'buildNarrativeContext').mockResolvedValue({
                            contextSummary: 'Mock context for contextTree test',
                            buildTrace: { rootTaskId: 'test-task-id', previousSiblingTaskIds: [] },
                            wasCondensed: false
                        });

                        const result = await orchestrator.synthesizeConversation('test-task-id');

                        // V?rification de la pr?sence du contextTree
                        expect(result.metrics.contextTree).toBeDefined();
                        expect(result.metrics.contextTree.currentTask).toEqual({
                            taskId: 'test-task-id',
                            synthesisType: 'atomic',
                            includedInContext: true
                        });

                        // V�rification du statut squelette
                        expect(result.metrics.contextTree.debugInfo.contextBuilderStatus).toBe('fully_implemented_phase3');
                        // Phase 3: Pas de m�thodes manquantes, impl�mentation compl�te
                        expect(result.metrics.contextTree.debugInfo.contextBuilderStatus).toBe('fully_implemented_phase3');

                        // V?rification que les tableaux sont vides (statut squelette)
                        expect(result.metrics.contextTree.parentTasks).toEqual([]);
                        expect(result.metrics.contextTree.siblingTasks).toEqual([]);
                        expect(result.metrics.contextTree.childTasks).toEqual([]);
                        expect(result.metrics.contextTree.condensedBatches).toEqual([]);
                    });

                    it('should include contextTree in error scenarios', async () => {
                        // Mock d'erreur dans le context builder
                        vi.spyOn(contextBuilder, 'buildNarrativeContext').mockRejectedValue(
                            new Error('Mock context builder error for contextTree test')
                        );

                        const result = await orchestrator.synthesizeConversation('test-task-id');

                        // V?rification que contextTree est pr?sent m?me en cas d'erreur
                        expect(result.metrics.contextTree).toBeDefined();
                        expect(result.metrics.contextTree.debugInfo.contextBuilderStatus).toBe('error_during_context_building');
                        expect(result.metrics.contextTree.currentTask.includedInContext).toBe(false);
                    });
                });

                describe('LLM Integration Metrics', () => {
                    it('should include OpenAI usage metrics when using real LLM', async () => {
                        // Mock du contexte
                        vi.spyOn(contextBuilder, 'buildNarrativeContext').mockResolvedValue({
                            contextSummary: 'Context for LLM metrics test',
                            buildTrace: { rootTaskId: 'test-task-id', previousSiblingTaskIds: [] },
                            wasCondensed: false
                        });

                        // Mock du LLM avec structure LLMCallResult compl?te
                        const mockAnalysis = {
                            taskId: 'test-task-id',
                            analysisEngineVersion: '3.0.0-phase3',
                            analysisTimestamp: new Date().toISOString(),
                            llmModelId: 'gpt-4o',
                            contextTrace: { rootTaskId: 'test-task-id', previousSiblingTaskIds: [] },
                            objectives: {
                                primary_goal: 'Test LLM metrics',
                                secondary_goals: ['Goal 2'],
                                success_criteria: ['Criteria 1']
                            },
                            strategy: {
                                approach: 'Test approach',
                                tools_used: ['Tool 1'],
                                methodology: 'Test methodology'
                            },
                            quality: {
                                completeness_score: 0.9,
                                clarity_score: 0.8,
                                effectiveness_rating: 'High',
                                issues_found: []
                            },
                            metrics: {
                                contextLength: 100,
                                wasCondensed: false,
                                processing_time_ms: 2000,
                                complexity_score: 3
                            },
                            synthesis: {
                                initialContextSummary: 'Test initial context',
                                finalTaskSummary: 'Test final summary'
                            }
                        };

                        const mockLLMResult = {
                            context: {
                                callId: 'test-call-id',
                                modelId: 'gpt-4o',
                                startTime: new Date().toISOString(),
                                prompt: 'Test prompt',
                                parameters: {},
                                metadata: {}
                            },
                            response: JSON.stringify(mockAnalysis), // L'orchestrateur parse cette r?ponse JSON
                            endTime: new Date().toISOString(),
                            duration: 3500,
                            usage: {
                                promptTokens: 1000,
                                completionTokens: 500,
                                totalTokens: 1500,
                                estimatedCost: 0.045
                            },
                            fromCache: false
                        };

                        vi.spyOn(llmService, 'generateSynthesis').mockResolvedValue(mockLLMResult);

                        const result = await orchestrator.synthesizeConversation('test-task-id');

                        // V�rification des m�triques LLM
                        expect(result.metrics.llmTokens).toBe(1500);
                        expect(result.metrics.llmCost).toBe(0.045);
                        expect(result.metrics.llmDuration).toBe(3500);
                        expect(result.llmModelId).toBe('gpt-4o');
                    });

                    it('should handle LLM errors gracefully with contextTree intact', async () => {
                        // Mock du contexte r�ussi
                        vi.spyOn(contextBuilder, 'buildNarrativeContext').mockResolvedValue({
                            contextSummary: 'Context for LLM error test',
                            buildTrace: { rootTaskId: 'test-task-id', previousSiblingTaskIds: [] },
                            wasCondensed: false
                        });

                        // Mock d'erreur LLM
                        vi.spyOn(llmService, 'generateSynthesis').mockRejectedValue(
                            new Error('Mock OpenAI API error')
                        );

                        const result = await orchestrator.synthesizeConversation('test-task-id');

                        // V�rification que l'erreur LLM est g�r�e
                        expect(result.analysisEngineVersion).toBe('3.0.0-phase3-error');
                        expect(result.metrics.llmError).toContain('Mock OpenAI API error');

                        // V�rification que contextTree est toujours pr�sent
                        expect(result.metrics.contextTree).toBeDefined();
                        expect(result.metrics.contextTree.debugInfo.contextBuilderStatus).toBe('fully_implemented_phase3');

                        // V�rification que le contexte r�el est utilis� m�me en cas d'erreur LLM
                        expect(result.synthesis.initialContextSummary).toBe('Context for LLM error test');
                    });
                });

                describe('Phase 3 Pipeline Validation', () => {
                    it('should execute complete Phase 3 pipeline: Context -> LLM -> Response with contextTree', async () => {
                        // Mock complet du pipeline
                        vi.spyOn(contextBuilder, 'buildNarrativeContext').mockResolvedValue({
                            contextSummary: 'Complete Phase 3 context',
                            buildTrace: {
                                rootTaskId: 'test-task-id',
                                parentTaskId: 'parent-id',
                                previousSiblingTaskIds: ['sibling-1', 'sibling-2']
                            },
                            wasCondensed: true,
                            condensedBatchPath: '/test/condensed.json'
                        });

                        const mockAnalysis = {
                            taskId: 'test-task-id',
                            analysisEngineVersion: '3.0.0-phase3',
                            analysisTimestamp: new Date().toISOString(),
                            llmModelId: 'gpt-4o',
                            contextTrace: {
                                rootTaskId: 'test-task-id',
                                parentTaskId: 'parent-id',
                                previousSiblingTaskIds: ['sibling-1', 'sibling-2']
                            },
                            objectives: {
                                primary_goal: 'Complete pipeline test',
                                secondary_goals: ['Secondary goal'],
                                success_criteria: ['Success criteria']
                            },
                            strategy: {
                                approach: 'End-to-end validation',
                                tools_used: ['Test tools'],
                                methodology: 'Test methodology'
                            },
                            quality: {
                                completeness_score: 0.95,
                                clarity_score: 0.9,
                                effectiveness_rating: 'Excellent',
                                issues_found: []
                            },
                            metrics: {
                                contextLength: 200,
                                wasCondensed: true,
                                processing_time_ms: 1800,
                                complexity_score: 4
                            },
                            synthesis: {
                                initialContextSummary: 'LLM received context',
                                finalTaskSummary: 'LLM generated summary'
                            }
                        };

                        const mockLLMResult = {
                            context: {
                                callId: 'test-pipeline-call-id',
                                modelId: 'gpt-4o',
                                startTime: new Date().toISOString(),
                                prompt: 'Complete pipeline prompt',
                                parameters: {},
                                metadata: {}
                            },
                            response: JSON.stringify(mockAnalysis),
                            endTime: new Date().toISOString(),
                            duration: 4200,
                            usage: {
                                promptTokens: 1200,
                                completionTokens: 800,
                                totalTokens: 2000,
                                estimatedCost: 0.06
                            },
                            fromCache: false
                        };

                        vi.spyOn(llmService, 'generateSynthesis').mockResolvedValue(mockLLMResult);

                        const result = await orchestrator.synthesizeConversation('test-task-id');

                        // V?rifications pipeline complet
                        expect(result.taskId).toBe('test-task-id');
                        expect(result.analysisEngineVersion).toBe('3.0.0-phase3');
                        expect(result.contextTrace.parentTaskId).toBe('parent-id');
                        expect(result.contextTrace.previousSiblingTaskIds).toEqual(['sibling-1', 'sibling-2']);

                        // V?rifications m?triques enrichies
                        expect(result.metrics.wasCondensed).toBe(true);
                        expect(result.metrics.condensedBatchPath).toBe('/test/condensed.json');
                        expect(result.metrics.llmTokens).toBe(2000);
                        expect(result.metrics.llmCost).toBe(0.06);

                        // V?rifications contextTree avec debug info
                        expect(result.metrics.contextTree.currentTask.synthesisType).toBe('atomic');
                        expect(result.metrics.contextTree.debugInfo.implementedMethods).toContain('buildNarrativeContext');

                        // V?rification que le contexte r?el remplace celui du LLM
                        expect(result.synthesis.initialContextSummary).toBe('Complete Phase 3 context');
                    });
                });
            });
        });
    });
});
