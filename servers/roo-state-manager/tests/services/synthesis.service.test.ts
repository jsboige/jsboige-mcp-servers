/**
 * Tests unitaires pour les services de synthèse - Phase 1 SDDD
 * 
 * Tests structurels avec configurations valides et patterns existants
 */

import { jest, describe, it, expect, beforeEach, beforeAll } from '@jest/globals';
import { ConversationAnalysis, CondensedSynthesisBatch } from '../../src/models/synthesis/SynthesisModels.js';
import { NarrativeContextBuilderService } from '../../src/services/synthesis/NarrativeContextBuilderService.js';
import { LLMService, LLMServiceOptions, LLMModelConfig } from '../../src/services/synthesis/LLMService.js';
import { SynthesisOrchestratorService, SynthesisOrchestratorOptions } from '../../src/services/synthesis/SynthesisOrchestratorService.js';
import dotenv from 'dotenv';
import path from 'path';

// Charger les variables d'environnement pour les tests E2E
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Mock simple du service OpenAI centralisé 
jest.mock('../../src/services/openai.js', () => ({
    __esModule: true,
    default: jest.fn(() => ({
        chat: {
            completions: {
                create: jest.fn()
            }
        }
    }))
}));

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
        jest.clearAllMocks();
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
            
            // Test que les méthodes non implémentées lancent des erreurs "Phase 1"
            await expect(
                orchestrator.startBatchSynthesis({
                    taskFilter: { workspace: '/test' },
                    maxConcurrency: 1,
                    llmModelId: 'test-gpt-4',
                    overwriteExisting: false
                })
            ).rejects.toThrow('Pas encore implémenté (Phase 1: Squelette)');
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
            
            // Méthodes principales existent (même si elles throw pour Phase 1)
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

            // Mock du buildNarrativeContext pour éviter les appels fichiers
            jest.spyOn(contextBuilder, 'buildNarrativeContext').mockResolvedValue({
                contextSummary: 'Test context for method validation',
                buildTrace: { rootTaskId: 'test-task-id', previousSiblingTaskIds: [] },
                wasCondensed: false
            });
            
            // Phase 2: Les méthodes fonctionnent et retournent des résultats
            const result = await orchestrator.synthesizeConversation('test-task-id');
            
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
    // TESTS PHASE 2 - INTÉGRATION CONTEXTE NARRATIF
    // =========================================================================
    
    describe('Phase 2 - Narrative Context Integration', () => {
        let contextBuilder: NarrativeContextBuilderService;
        let llmService: LLMService;
        let orchestrator: SynthesisOrchestratorService;

        beforeEach(() => {
            // Configuration Phase 2 avec options réelles
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
                // Mock des méthodes internes pour éviter les appels réels aux fichiers
                const mockBuildNarrativeContext = jest.spyOn(contextBuilder, 'buildNarrativeContext')
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

                // Vérifications de base
                expect(result).toBeDefined();
                expect(result.taskId).toBe('test-task-id');
                expect(result.analysisEngineVersion).toBe('3.0.0-phase3');
                
                // Vérification que le contexte builder a bien été appelé
                expect(mockBuildNarrativeContext).toHaveBeenCalledWith('test-task-id', undefined);
                
                mockBuildNarrativeContext.mockRestore();
            });

            it('should pass through contextTrace from NarrativeContextBuilder', async () => {
                const expectedTrace = {
                    rootTaskId: 'test-root',
                    parentTaskId: 'test-parent',
                    previousSiblingTaskIds: ['sibling-a', 'sibling-b']
                };

                const mockBuildNarrativeContext = jest.spyOn(contextBuilder, 'buildNarrativeContext')
                    .mockResolvedValue({
                        contextSummary: 'Test context',
                        buildTrace: expectedTrace,
                        wasCondensed: true,
                        condensedBatchPath: '/test/batch.json'
                    });

                const result = await orchestrator.synthesizeConversation('test-task-id');

                // Vérification que la trace est bien propagée
                expect(result.contextTrace).toEqual(expectedTrace);
                
                // Vérification que les données réelles du contexte sont dans la synthèse
                expect(result.synthesis.initialContextSummary).toBe('Test context');
                expect(result.metrics.wasCondensed).toBe(true);
                expect(result.metrics.condensedBatchPath).toBe('/test/batch.json');
                
                mockBuildNarrativeContext.mockRestore();
            });

            it('should handle NarrativeContextBuilder errors gracefully', async () => {
                const mockBuildNarrativeContext = jest.spyOn(contextBuilder, 'buildNarrativeContext')
                    .mockRejectedValue(new Error('Mock context builder error'));

                const result = await orchestrator.synthesizeConversation('test-task-id');

                // Vérification que l'erreur est gérée et une analyse d'erreur est retournée
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

                const mockBuildNarrativeContext = jest.spyOn(contextBuilder, 'buildNarrativeContext')
                    .mockResolvedValue({
                        contextSummary: 'Options test context',
                        buildTrace: {
                            rootTaskId: 'test-task-id',
                            previousSiblingTaskIds: []
                        },
                        wasCondensed: false
                    });

                await orchestrator.synthesizeConversation('test-task-id', testOptions);

                // Vérification que les options sont bien passées
                expect(mockBuildNarrativeContext).toHaveBeenCalledWith('test-task-id', testOptions);
                
                mockBuildNarrativeContext.mockRestore();
            });
        });

        describe('ConversationAnalysis Structure Validation', () => {
            it('should return properly structured ConversationAnalysis', async () => {
                const mockBuildNarrativeContext = jest.spyOn(contextBuilder, 'buildNarrativeContext')
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

                // Validation de la structure ConversationAnalysis complète
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
                const largeContext = 'A'.repeat(15000); // Contexte de 15k caractères
                
                const mockBuildNarrativeContext = jest.spyOn(contextBuilder, 'buildNarrativeContext')
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

                // Vérification des métriques réelles
                expect(result.metrics.contextLength).toBe(15000);
                expect(result.metrics.wasCondensed).toBe(true);
                expect(result.metrics.condensedBatchPath).toBe('/test/large-batch.json');

                mockBuildNarrativeContext.mockRestore();
            });
        
            // =========================================================================
            // TESTS PHASE 3 - INTÉGRATION LLM RÉELLE ET TRAÇABILITÉ CONTEXTE
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
                        // Mock du contexte pour éviter les appels réels
                        jest.spyOn(contextBuilder, 'buildNarrativeContext').mockResolvedValue({
                            contextSummary: 'Mock context for contextTree test',
                            buildTrace: { rootTaskId: 'test-task-id', previousSiblingTaskIds: [] },
                            wasCondensed: false
                        });
        
                        const result = await orchestrator.synthesizeConversation('test-task-id');
        
                        // Vérification de la présence du contextTree
                        expect(result.metrics.contextTree).toBeDefined();
                        expect(result.metrics.contextTree.currentTask).toEqual({
                            taskId: 'test-task-id',
                            synthesisType: 'atomic',
                            includedInContext: true
                        });
                        
                        // Vérification du statut squelette
                        expect(result.metrics.contextTree.debugInfo.contextBuilderStatus).toBe('skeleton_phase1');
                        expect(result.metrics.contextTree.debugInfo.missingMethods).toContain('traverseUpwards');
                        expect(result.metrics.contextTree.debugInfo.missingMethods).toContain('collectSiblingTasks');
                        expect(result.metrics.contextTree.debugInfo.missingMethods).toContain('buildInitialContext');
                        
                        // Vérification que les tableaux sont vides (statut squelette)
                        expect(result.metrics.contextTree.parentTasks).toEqual([]);
                        expect(result.metrics.contextTree.siblingTasks).toEqual([]);
                        expect(result.metrics.contextTree.childTasks).toEqual([]);
                        expect(result.metrics.contextTree.condensedBatches).toEqual([]);
                    });
        
                    it('should include contextTree in error scenarios', async () => {
                        // Mock d'erreur dans le context builder
                        jest.spyOn(contextBuilder, 'buildNarrativeContext').mockRejectedValue(
                            new Error('Mock context builder error for contextTree test')
                        );
        
                        const result = await orchestrator.synthesizeConversation('test-task-id');
        
                        // Vérification que contextTree est présent même en cas d'erreur
                        expect(result.metrics.contextTree).toBeDefined();
                        expect(result.metrics.contextTree.debugInfo.contextBuilderStatus).toBe('error_during_context_building');
                        expect(result.metrics.contextTree.currentTask.includedInContext).toBe(false);
                    });
                });
        
                describe('LLM Integration Metrics', () => {
                    it('should include OpenAI usage metrics when using real LLM', async () => {
                        // Mock du contexte
                        jest.spyOn(contextBuilder, 'buildNarrativeContext').mockResolvedValue({
                            contextSummary: 'Context for LLM metrics test',
                            buildTrace: { rootTaskId: 'test-task-id', previousSiblingTaskIds: [] },
                            wasCondensed: false
                        });
        
                        // Mock du LLM avec structure LLMCallResult complète
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
                            response: JSON.stringify(mockAnalysis), // L'orchestrateur parse cette réponse JSON
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
        
                        jest.spyOn(llmService, 'generateSynthesis').mockResolvedValue(mockLLMResult);
        
                        const result = await orchestrator.synthesizeConversation('test-task-id');
        
                        // Vérification des métriques LLM
                        expect(result.metrics.llmTokens).toBe(1500);
                        expect(result.metrics.llmCost).toBe(0.045);
                        expect(result.metrics.llmDuration).toBe(3500);
                        expect(result.llmModelId).toBe('gpt-4o');
                    });
        
                    it('should handle LLM errors gracefully with contextTree intact', async () => {
                        // Mock du contexte réussi
                        jest.spyOn(contextBuilder, 'buildNarrativeContext').mockResolvedValue({
                            contextSummary: 'Context for LLM error test',
                            buildTrace: { rootTaskId: 'test-task-id', previousSiblingTaskIds: [] },
                            wasCondensed: false
                        });
        
                        // Mock d'erreur LLM
                        jest.spyOn(llmService, 'generateSynthesis').mockRejectedValue(
                            new Error('Mock OpenAI API error')
                        );
        
                        const result = await orchestrator.synthesizeConversation('test-task-id');
        
                        // Vérification que l'erreur LLM est gérée
                        expect(result.analysisEngineVersion).toBe('3.0.0-phase3-error');
                        expect(result.metrics.llmError).toContain('Mock OpenAI API error');
                        
                        // Vérification que contextTree est toujours présent
                        expect(result.metrics.contextTree).toBeDefined();
                        expect(result.metrics.contextTree.debugInfo.explanation).toContain('squelette');
                        
                        // Vérification que le contexte réel est utilisé même en cas d'erreur LLM
                        expect(result.synthesis.initialContextSummary).toBe('Context for LLM error test');
                    });
                });
        
                describe('Phase 3 Pipeline Validation', () => {
                    it('should execute complete Phase 3 pipeline: Context -> LLM -> Response with contextTree', async () => {
                        // Mock complet du pipeline
                        jest.spyOn(contextBuilder, 'buildNarrativeContext').mockResolvedValue({
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
        
                        jest.spyOn(llmService, 'generateSynthesis').mockResolvedValue(mockLLMResult);
        
                        const result = await orchestrator.synthesizeConversation('test-task-id');
        
                        // Vérifications pipeline complet
                        expect(result.taskId).toBe('test-task-id');
                        expect(result.analysisEngineVersion).toBe('3.0.0-phase3');
                        expect(result.contextTrace.parentTaskId).toBe('parent-id');
                        expect(result.contextTrace.previousSiblingTaskIds).toEqual(['sibling-1', 'sibling-2']);
                        
                        // Vérifications métriques enrichies
                        expect(result.metrics.wasCondensed).toBe(true);
                        expect(result.metrics.condensedBatchPath).toBe('/test/condensed.json');
                        expect(result.metrics.llmTokens).toBe(2000);
                        expect(result.metrics.llmCost).toBe(0.06);
                        
                        // Vérifications contextTree avec debug info
                        expect(result.metrics.contextTree.currentTask.synthesisType).toBe('atomic');
                        expect(result.metrics.contextTree.debugInfo.implementedMethods).toContain('buildContextForTask (minimal)');
                        
                        // Vérification que le contexte réel remplace celui du LLM
                        expect(result.synthesis.initialContextSummary).toBe('Complete Phase 3 context');
                    });
                });
            });
        });
    });
});

// Tests E2E avec les vraies clés du .env
describe('E2E Tests with Real Environment', () => {
    // Skip si pas de clés configurées
    const skipE2E = !process.env.OPENAI_API_KEY;
    const itE2E = skipE2E ? it.skip : it;

    beforeAll(() => {
        if (skipE2E) {
            console.log('⚠️ Skipping E2E tests: OPENAI_API_KEY not configured in .env');
        } else {
            console.log('✅ Running E2E tests with real API keys');
            // Rétablir le service OpenAI réel pour les tests E2E
            jest.unmock('../../src/services/openai.js');
        }
    });

    const createE2ELLMConfig = (): LLMServiceOptions => ({
        models: [{
            modelId: process.env.OPENAI_CHAT_MODEL_ID || 'gpt-4o-mini',
            displayName: 'OpenAI GPT-4o-mini',
            provider: 'openai' as const,
            modelName: process.env.OPENAI_CHAT_MODEL_ID || 'gpt-4o-mini',
            maxTokens: 128000,
            costPerInputToken: 0.00015,
            costPerOutputToken: 0.0006,
            parameters: {
                temperature: 0.1
            }
        }],
        defaultModelId: process.env.OPENAI_CHAT_MODEL_ID || 'gpt-4o-mini',
        defaultTimeout: 60000,
        maxRetries: 3,
        retryDelay: 2000,
        enableCaching: false
    });

    const createE2EOrchestratorOptions = (): SynthesisOrchestratorOptions => ({
        synthesisOutputDir: '/test/e2e/synthesis',
        maxContextSize: 100000,
        maxConcurrency: 2,
        defaultLlmModel: process.env.OPENAI_CHAT_MODEL_ID || 'gpt-4o-mini'
    });

    describe('Real API Integration', () => {
        itE2E('should instantiate LLMService with real OpenAI config', () => {
            expect(() => {
                const config = createE2ELLMConfig();
                const service = new LLMService(config);
                expect(service).toBeInstanceOf(LLMService);
            }).not.toThrow();
        });

        itE2E('should create complete synthesis pipeline with real config', () => {
            expect(() => {
                const contextBuilder = new NarrativeContextBuilderService({
                    baseDirectory: process.cwd(),
                    maxContextSize: 200000,
                    enableCondensation: true
                } as any, new Map());
                
                const llmService = new LLMService(createE2ELLMConfig());
                
                const orchestrator = new SynthesisOrchestratorService(
                    contextBuilder,
                    llmService,
                    createE2EOrchestratorOptions()
                );
                
                expect(orchestrator).toBeInstanceOf(SynthesisOrchestratorService);
                expect(contextBuilder).toBeInstanceOf(NarrativeContextBuilderService);
                expect(llmService).toBeInstanceOf(LLMService);
            }).not.toThrow();
        });
    });

    describe('Environment Configuration', () => {
        itE2E('should have all required environment variables', () => {
            expect(process.env.OPENAI_API_KEY).toBeDefined();
            expect(process.env.OPENAI_CHAT_MODEL_ID).toBeDefined();
            expect(process.env.QDRANT_URL).toBeDefined();
            expect(process.env.QDRANT_API_KEY).toBeDefined();
            expect(process.env.QDRANT_COLLECTION_NAME).toBeDefined();
        });

        itE2E('should validate environment values', () => {
            expect(process.env.OPENAI_API_KEY).toMatch(/^sk-/);
            expect(process.env.OPENAI_CHAT_MODEL_ID).toBe('gpt-4o-mini');
            expect(process.env.QDRANT_URL).toMatch(/^https?:\/\//);
            expect(process.env.QDRANT_COLLECTION_NAME).toBe('roo_tasks_semantic_index');
        });

        itE2E('should validate Qdrant configuration', () => {
            expect(process.env.QDRANT_API_KEY).toMatch(/^[a-f0-9-]{36}$/); // UUID format
            expect(process.env.QDRANT_URL).toBe('https://qdrant.myia.io');
        });
    });

    describe('Phase 1 Integration with Real Config', () => {
        itE2E('should handle real synthesis gracefully (Phase 2)', async () => {
            const contextBuilder = new NarrativeContextBuilderService({
                baseDirectory: process.cwd(),
                maxContextSize: 10000
            } as any, new Map());
            
            const llmService = new LLMService(createE2ELLMConfig());
            
            const orchestrator = new SynthesisOrchestratorService(
                contextBuilder,
                llmService,
                createE2EOrchestratorOptions()
            );

            // Phase 2 : synthesizeConversation fonctionne et retourne une analyse
            // (même si le taskId n'existe pas, il gère l'erreur gracieusement)
            const result = await orchestrator.synthesizeConversation('real-task-id');
            
            expect(result).toBeDefined();
            expect(result.taskId).toBe('real-task-id');
            expect(result.analysisEngineVersion).toBe('2.0.0-phase2');
            
            // Vérification que l'erreur "conversation not found" est dans le contexte
            expect(result.synthesis.initialContextSummary).toContain('Conversation skeleton not found');
        });
    });
});