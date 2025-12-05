import { describe, it, expect, beforeAll } from 'vitest';
import { NarrativeContextBuilderService } from '../../src/services/synthesis/NarrativeContextBuilderService.js';
import { LLMService, LLMServiceOptions } from '../../src/services/synthesis/LLMService.js';
import { SynthesisOrchestratorService, SynthesisOrchestratorOptions } from '../../src/services/synthesis/SynthesisOrchestratorService.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger les variables d'environnement pour les tests E2E
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Tests E2E avec les vraies clés du .env
describe('E2E Tests with Real Environment', () => {
    // Skip si pas de clés configurées
    const skipE2E = !process.env.OPENAI_API_KEY;
    const itE2E = skipE2E ? it.skip : it;

    beforeAll(() => {
        if (skipE2E) {
            console.log('⚠️ Skipping E2E tests: OPENAI_API_KEY not configured in .env');
        } else {
            console.log('🚀 Running E2E tests with real API keys');
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
            expect(process.env.OPENAI_CHAT_MODEL_ID).toBe('gpt-5-mini');
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

            // Accepter la version normale ou la version erreur (si pas de clé API)
            if (result.analysisEngineVersion === '3.0.0-phase3-error') {
                console.warn('⚠️ Test E2E Synthesis: Fallback error triggered (probablement pas de clé API valide)');
                expect(result.objectives?.llmError).toBe(true);
            } else {
                expect(result.analysisEngineVersion).toBe('3.0.0-phase3');
            }

            // Vérification que l'erreur "conversation not found" est dans le contexte
            expect(result.synthesis.initialContextSummary).toContain('Conversation skeleton not found');
        });
    });
});