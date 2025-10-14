/**
 * Service de gestion de l'état global du serveur
 */

import { ConversationSkeleton } from '../types/conversation.js';
import { TraceSummaryService } from './TraceSummaryService.js';
import { IndexingDecisionService } from './indexing-decision.js';
import { XmlExporterService } from './XmlExporterService.js';
import { ExportConfigManager } from './ExportConfigManager.js';
import { LLMService } from './synthesis/LLMService.js';
import { NarrativeContextBuilderService } from './synthesis/NarrativeContextBuilderService.js';
import { SynthesisOrchestratorService } from './synthesis/SynthesisOrchestratorService.js';
import { IndexingMetrics } from '../types/indexing.js';
import { ANTI_LEAK_CONFIG } from '../config/server-config.js';

export interface ServerState {
    conversationCache: Map<string, ConversationSkeleton>;
    xmlExporterService: XmlExporterService;
    exportConfigManager: ExportConfigManager;
    traceSummaryService: TraceSummaryService;
    llmService: LLMService;
    narrativeContextBuilderService: NarrativeContextBuilderService;
    synthesisOrchestratorService: SynthesisOrchestratorService;
    indexingDecisionService: IndexingDecisionService;
    indexingMetrics: IndexingMetrics;
    
    // Services de background pour l'architecture à 2 niveaux
    qdrantIndexQueue: Set<string>;
    qdrantIndexInterval: NodeJS.Timeout | null;
    isQdrantIndexingEnabled: boolean;
    
    // 🛡️ CACHE ANTI-FUITE - Protection contre 220GB de trafic réseau (LEGACY)
    qdrantIndexCache: Map<string, number>;
    lastQdrantConsistencyCheck: number;
}

export class StateManager {
    private state: ServerState;

    constructor() {
        // Initialisation des services de synthèse selon le pattern de dependency injection
        // Phase 1 : Configuration par défaut simplifiée pour validation de structure
        const defaultLLMOptions = {
            models: [{
                modelId: 'gpt-4',
                displayName: 'GPT-4',
                provider: 'openai' as const,
                modelName: 'gpt-4',
                maxTokens: 8192,
                costPerInputToken: 0.00003,
                costPerOutputToken: 0.00006,
                parameters: { temperature: 0.7 }
            }],
            defaultModelId: 'gpt-4',
            defaultTimeout: 30000,
            maxRetries: 3,
            retryDelay: 1000,
            enableCaching: true
        };

        const defaultContextOptions = {
            synthesisBaseDir: './synthesis',
            condensedBatchesDir: './synthesis/batches',
            maxContextSizeBeforeCondensation: 100000,
            defaultMaxDepth: 5
        };

        const defaultOrchestratorOptions = {
            synthesisOutputDir: './synthesis/output',
            maxContextSize: 150000,
            maxConcurrency: 3,
            defaultLlmModel: 'gpt-4'
        };

        const conversationCache = new Map<string, ConversationSkeleton>();
        const exportConfigManager = new ExportConfigManager();

        const llmService = new LLMService(defaultLLMOptions);
        const narrativeContextBuilderService = new NarrativeContextBuilderService(defaultContextOptions, conversationCache);
        const synthesisOrchestratorService = new SynthesisOrchestratorService(
            narrativeContextBuilderService,
            llmService,
            defaultOrchestratorOptions
        );

        this.state = {
            conversationCache,
            xmlExporterService: new XmlExporterService(),
            exportConfigManager,
            traceSummaryService: new TraceSummaryService(exportConfigManager),
            llmService,
            narrativeContextBuilderService,
            synthesisOrchestratorService,
            indexingDecisionService: new IndexingDecisionService(),
            indexingMetrics: {
                totalTasks: 0,
                skippedTasks: 0,
                indexedTasks: 0,
                failedTasks: 0,
                retryTasks: 0,
                bandwidthSaved: 0
            },
            qdrantIndexQueue: new Set(),
            qdrantIndexInterval: null,
            isQdrantIndexingEnabled: true,
            qdrantIndexCache: new Map(),
            lastQdrantConsistencyCheck: 0,
        };
    }

    getState(): ServerState {
        return this.state;
    }

    getConversationCache(): Map<string, ConversationSkeleton> {
        return this.state.conversationCache;
    }

    getTraceSummaryService(): TraceSummaryService {
        return this.state.traceSummaryService;
    }

    getIndexingDecisionService(): IndexingDecisionService {
        return this.state.indexingDecisionService;
    }

    getXmlExporterService(): XmlExporterService {
        return this.state.xmlExporterService;
    }

    getExportConfigManager(): ExportConfigManager {
        return this.state.exportConfigManager;
    }

    getSynthesisOrchestratorService(): SynthesisOrchestratorService {
        return this.state.synthesisOrchestratorService;
    }
}