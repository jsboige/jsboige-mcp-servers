
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';

// Obtenir le répertoire du fichier actuel
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger les variables d'environnement AVANT tout autre import
dotenv.config({ path: path.join(__dirname, '../..', '.env') });

// VALIDATION STRICTE DES CONFIGURATIONS CRITIQUES AU STARTUP
const REQUIRED_ENV_VARS = [
    'QDRANT_URL',
    'QDRANT_API_KEY',
    'QDRANT_COLLECTION_NAME',
    'OPENAI_API_KEY'
];

const missingVars = REQUIRED_ENV_VARS.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
    console.error('🚨 ERREUR CRITIQUE: Variables d\'environnement manquantes:');
    missingVars.forEach(varName => console.error(`   ❌ ${varName}`));
    console.error('📄 Vérifiez le fichier .env à la racine du projet roo-state-manager');
    console.error('🔥 ARRÊT IMMÉDIAT DU SERVEUR POUR ÉVITER TOUTE PERTE DE TEMPS');
    process.exit(1);
}

console.log('✅ Toutes les variables d\'environnement critiques sont présentes');

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RooStorageDetector } from './utils/roo-storage-detector.js';
import { promises as fs, existsSync } from 'fs';
import { exec } from 'child_process';
import { TaskNavigator } from './services/task-navigator.js';
import { ConversationSkeleton, ActionMetadata, MessageSkeleton, ClusterSummaryOptions, ClusterSummaryResult } from './types/conversation.js';
import packageJson from '../package.json' with { type: 'json' };
import { readVscodeLogs, rebuildAndRestart, getMcpBestPractices, manageMcpSettings, rebuildTaskIndexFixed, generateTraceSummaryTool, handleGenerateTraceSummary, generateClusterSummaryTool, handleGenerateClusterSummary, exportConversationJsonTool, handleExportConversationJson, exportConversationCsvTool, handleExportConversationCsv, viewConversationTree, getConversationSynthesisTool, handleGetConversationSynthesis, detectStorageTool, getStorageStatsTool, listConversationsTool, debugAnalyzeTool, getRawConversationTool, viewTaskDetailsTool, getTaskTreeTool, handleGetTaskTree, debugTaskParsingTool, handleDebugTaskParsing, exportTaskTreeMarkdownTool, handleExportTaskTreeMarkdown, searchTasksSemanticTool, handleSearchTasksSemanticFallback, indexTaskSemanticTool, handleDiagnoseSemanticIndex, resetQdrantCollectionTool, exportTasksXmlTool, handleExportTasksXml, exportConversationXmlTool, handleExportConversationXml, exportProjectXmlTool, handleExportProjectXml, configureXmlExportTool, handleConfigureXmlExport } from './tools/index.js';
import { searchTasks } from './services/task-searcher.js';
import { indexTask, TaskIndexer } from './services/task-indexer.js';
import { getQdrantClient } from './services/qdrant.js';
import getOpenAIClient from './services/openai.js';
import { XmlExporterService } from './services/XmlExporterService.js';
import { ExportConfigManager } from './services/ExportConfigManager.js';
import { TraceSummaryService } from './services/TraceSummaryService.js';
import { SynthesisOrchestratorService } from './services/synthesis/SynthesisOrchestratorService.js';
import { NarrativeContextBuilderService } from './services/synthesis/NarrativeContextBuilderService.js';
import { LLMService } from './services/synthesis/LLMService.js';
import { IndexingDecisionService } from './services/indexing-decision.js';
import { IndexingMetrics } from './types/indexing.js';
import { SkeletonCacheService } from './services/skeleton-cache.service.js';
import { normalizePath } from './utils/path-normalizer.js';

const MAX_OUTPUT_LENGTH = 300000; // Smart Truncation Engine - Corrected from 150K to 300K for intelligent truncation
const SKELETON_CACHE_DIR_NAME = '.skeletons';

class RooStateManagerServer {
    private server: Server;
    private conversationCache: Map<string, ConversationSkeleton> = new Map();
    private xmlExporterService: XmlExporterService;
    private exportConfigManager: ExportConfigManager;
    private traceSummaryService: TraceSummaryService;
    
    // Services de synthèse de conversations (Phase 1 - Squelette)
    private llmService: LLMService;
    private narrativeContextBuilderService: NarrativeContextBuilderService;
    private synthesisOrchestratorService: SynthesisOrchestratorService;
    
    // Services de background pour l'architecture à 2 niveaux
    private qdrantIndexQueue: Set<string> = new Set(); // File d'attente des tâches à indexer
    private qdrantIndexInterval: NodeJS.Timeout | null = null;
    private isQdrantIndexingEnabled = true;
    
    // NOUVEAU : Service de décision d'indexation avec mécanisme d'idempotence
    private indexingDecisionService: IndexingDecisionService;
    private indexingMetrics: IndexingMetrics = {
        totalTasks: 0,
        skippedTasks: 0,
        indexedTasks: 0,
        failedTasks: 0,
        retryTasks: 0,
        bandwidthSaved: 0
    };
    
    // 🛡️ CACHE ANTI-FUITE - Protection contre 220GB de trafic réseau (LEGACY)
    private qdrantIndexCache: Map<string, number> = new Map(); // taskId -> timestamp dernière indexation
    private lastQdrantConsistencyCheck: number = 0;
    private readonly CONSISTENCY_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24h au lieu du démarrage
    private readonly MIN_REINDEX_INTERVAL = 4 * 60 * 60 * 1000; // 4h minimum entre indexations
    private readonly MAX_BACKGROUND_INTERVAL = 5 * 60 * 1000; // 5min au lieu de 30s

    constructor() {
        this.xmlExporterService = new XmlExporterService();
        this.exportConfigManager = new ExportConfigManager();
        this.traceSummaryService = new TraceSummaryService(this.exportConfigManager);
        
        // NOUVEAU : Initialisation du service de décision d'indexation avec idempotence
        this.indexingDecisionService = new IndexingDecisionService();
        
        // Instanciation des services de synthèse selon le pattern de dependency injection
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

        this.llmService = new LLMService(defaultLLMOptions);
        this.narrativeContextBuilderService = new NarrativeContextBuilderService(defaultContextOptions, this.conversationCache);
        this.synthesisOrchestratorService = new SynthesisOrchestratorService(
            this.narrativeContextBuilderService,
            this.llmService,
            defaultOrchestratorOptions
        );
        this.server = new Server(
            {
                name: 'roo-state-manager',
                version: packageJson.version,
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );
        
        // Initialisation des services background
        this._initializeBackgroundServices().catch((error: Error) => {
            console.error("Error during background services initialization:", error);
        });

        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'minimal_test_tool',
                        description: 'This is a minimal tool to check if the MCP is reloading.',
                        inputSchema: { type: 'object', properties: {}, required: [] },
                    },
                    detectStorageTool.definition,
                    getStorageStatsTool.definition,
                    listConversationsTool.definition,
                    {
                        name: 'touch_mcp_settings',
                        description: 'Touche le fichier de paramètres pour forcer le rechargement des MCPs Roo.',
                        inputSchema: { type: 'object', properties: {}, required: [] },
                    },
                    {
                        name: 'build_skeleton_cache',
                        description: 'Force la reconstruction complète du cache de squelettes sur le disque. Opération potentiellement longue.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                force_rebuild: {
                                    type: 'boolean',
                                    description: 'Si true, reconstruit TOUS les squelettes (lent). Si false/omis, ne reconstruit que les squelettes obsolètes ou manquants (rapide).',
                                    default: false
                                },
                                workspace_filter: {
                                    type: 'string',
                                    description: 'Filtre optionnel par workspace. Si spécifié, ne traite que les conversations de ce workspace.'
                                }
                            },
                            required: []
                        },
                    },
                    // Task tools - Batch 3 refactoring
                    getTaskTreeTool,
                    debugTaskParsingTool,
                    searchTasksSemanticTool.definition,
                    debugAnalyzeTool.definition,
                    {
                        name: viewConversationTree.name,
                        description: viewConversationTree.description,
                        inputSchema: viewConversationTree.inputSchema,
                    },
                    // {
                    //     name: 'diagnose_roo_state',
                    //     description: 'Exécute le script d\'audit des tâches Roo (audit-roo-tasks.ps1) et retourne sa sortie JSON.',
                    //     inputSchema: {
                    //         type: 'object',
                    //         properties: {
                    //             offset: { type: 'number', description: 'Offset pour la pagination.' },
                    //             limit: { type: 'number', description: 'Limite pour la pagination.' },
                    //         },
                    //     },
                    // },
                    // {
                    //     name: 'repair_workspace_paths',
                    //     description: 'Exécute le script de réparation des chemins de workspace (repair-roo-tasks.ps1).',
                    //     inputSchema: {
                    //         type: 'object',
                    //         properties: {
                    //             path_pairs: {
                    //                 type: 'array',
                    //                 items: { type: 'string' },
                    //                 description: 'Paires de chemins ancien/nouveau pour la réparation. Ex: "C:/old/path=D:/new/path"',
                    //             },
                    //             whatIf: {
                    //                 type: 'boolean',
                    //                 description: 'Exécute le script en mode simulation (-WhatIf).',
                    //                 default: false,
                    //             },
                    //             non_interactive: {
                    //                 type: 'boolean',
                    //                 description: 'Exécute le script en mode non interactif.',
                    //                 default: true,
                    //             }
                    //         },
                    //     },
                    // },
                    {
                        name: readVscodeLogs.name,
                        description: readVscodeLogs.description,
                        inputSchema: readVscodeLogs.inputSchema,
                    },
                    {
                        name: manageMcpSettings.name,
                        description: manageMcpSettings.description,
                        inputSchema: manageMcpSettings.inputSchema,
                    },
                    indexTaskSemanticTool.definition,
                    resetQdrantCollectionTool.definition,
                    {
                       name: rebuildAndRestart.name,
                       description: rebuildAndRestart.description,
                       inputSchema: rebuildAndRestart.inputSchema,
                    },
                    {
                       name: getMcpBestPractices.name,
                       description: getMcpBestPractices.description,
                       inputSchema: getMcpBestPractices.inputSchema,
                    },
                    {
                       name: rebuildTaskIndexFixed.name,
                       description: rebuildTaskIndexFixed.description,
                       inputSchema: rebuildTaskIndexFixed.inputSchema,
                    },
                    {
                       name: 'diagnose_conversation_bom',
                       description: 'Diagnostique les fichiers de conversation corrompus par un BOM UTF-8.',
                       inputSchema: {
                           type: 'object',
                           properties: {
                               fix_found: { type: 'boolean', description: 'Si true, répare automatiquement les fichiers trouvés.', default: false },
                           },
                       },
                    },
                    {
                       name: 'repair_conversation_bom',
                       description: 'Répare les fichiers de conversation corrompus par un BOM UTF-8.',
                       inputSchema: {
                           type: 'object',
                           properties: {
                               dry_run: { type: 'boolean', description: 'Si true, simule la réparation sans modifier les fichiers.', default: false },
                           },
                       },
                    },
                    exportTasksXmlTool,
                    exportConversationXmlTool,
                    exportProjectXmlTool,
                    configureXmlExportTool,
                    {
                        name: generateTraceSummaryTool.name,
                        description: generateTraceSummaryTool.description,
                        inputSchema: generateTraceSummaryTool.inputSchema,
                    },
                    {
                        name: generateClusterSummaryTool.name,
                        description: generateClusterSummaryTool.description,
                        inputSchema: generateClusterSummaryTool.inputSchema,
                    },
                    {
                        name: exportConversationJsonTool.name,
                        description: exportConversationJsonTool.description,
                        inputSchema: exportConversationJsonTool.inputSchema,
                    },
                    {
                        name: exportConversationCsvTool.name,
                        description: exportConversationCsvTool.description,
                        inputSchema: exportConversationCsvTool.inputSchema,
                    },
                    viewTaskDetailsTool.definition,
                    getRawConversationTool.definition,
                    {
                        name: getConversationSynthesisTool.name,
                        description: getConversationSynthesisTool.description,
                        inputSchema: getConversationSynthesisTool.inputSchema,
                    },
                    exportTaskTreeMarkdownTool,
                ] as any[],
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
            const { name, arguments: args } = request.params;

            let result: CallToolResult;

            switch (name) {
                case 'minimal_test_tool':
                    // TESTS COMPLETS POUR TRAQUER OÙ VONT LES LOGS
                    const timestamp = new Date().toISOString();
                    console.log('🔍 [STDOUT-SEARCH] console.log test - Heure:', timestamp);
                    console.error('🔍 [STDERR-CONFIRMED] console.error test - Heure:', timestamp);
                    
                    // Tests de tous les canaux possibles
                    process.stdout.write(`🔍 [STDOUT-SEARCH] process.stdout.write test - ${timestamp}\n`);
                    process.stderr.write(`🔍 [STDERR-CONFIRMED] process.stderr.write test - ${timestamp}\n`);
                    
                    // Test avec console.info et console.warn
                    console.info('🔍 [INFO-SEARCH] console.info test - Heure:', timestamp);
                    console.warn('🔍 [WARN-SEARCH] console.warn test - Heure:', timestamp);
                    
                    result = { content: [{ type: 'text', text: `INVESTIGATION DES CANAUX DE LOGS - ${timestamp} - Vérifiez tous les logs maintenant!` }] };
                    break;
               case detectStorageTool.definition.name:
                   result = await detectStorageTool.handler({});
                   break;
              case getStorageStatsTool.definition.name:
                    result = await getStorageStatsTool.handler({});
                    break;
                case listConversationsTool.definition.name:
                    result = await listConversationsTool.handler(args as any, this.conversationCache);
                    break;
                case 'touch_mcp_settings':
                    result = await this.handleTouchMcpSettings();
                    break;
                case 'build_skeleton_cache':
                    result = await this.handleBuildSkeletonCache(args as any);
                    break;
                case 'get_task_tree':
                    result = await handleGetTaskTree(args as any, this.conversationCache, async () => { await this._ensureSkeletonCacheIsFresh(); });
                    break;
                case viewConversationTree.name:
                    result = viewConversationTree.handler(args as any, this.conversationCache);
                    break;
                case viewTaskDetailsTool.definition.name:
                    result = await viewTaskDetailsTool.handler(args as any, this.conversationCache);
                    break;
                case searchTasksSemanticTool.definition.name:
                    result = await searchTasksSemanticTool.handler(
                        args as any,
                        this.conversationCache,
                        this._ensureSkeletonCacheIsFresh.bind(this),
                        handleSearchTasksSemanticFallback,
                        () => handleDiagnoseSemanticIndex(this.conversationCache)
                    );
                    break;
               case debugAnalyzeTool.definition.name:
                   result = await debugAnalyzeTool.handler(args as any, this.conversationCache);
                   break;
               case 'debug_task_parsing':
                   result = await handleDebugTaskParsing(args as any);
                   break;
            //    case 'diagnose_roo_state':
            //        result = await this.handleDiagnoseRooState(args as any);
            //        break;
            //    case 'repair_workspace_paths':
            //        result = await this.handleRepairWorkspacePaths(args as any);
            //        break;
               case readVscodeLogs.name:
                   result = await readVscodeLogs.handler(args as any);
                   break;
               case manageMcpSettings.name:
                   result = await manageMcpSettings.handler(args as any);
                   break;
               case indexTaskSemanticTool.definition.name:
                   result = await indexTaskSemanticTool.handler(
                       args as any,
                       this.conversationCache,
                       this._ensureSkeletonCacheIsFresh.bind(this)
                   );
                   break;
               case resetQdrantCollectionTool.definition.name:
                   result = await resetQdrantCollectionTool.handler(
                       args as any,
                       this.conversationCache,
                       this._saveSkeletonToDisk.bind(this),
                       this.qdrantIndexQueue,
                       (enabled: boolean) => { this.isQdrantIndexingEnabled = enabled; }
                   );
                   break;
               case rebuildAndRestart.name:
                   result = await rebuildAndRestart.handler(args as any);
                   break;
               case getMcpBestPractices.name:
                   result = await getMcpBestPractices.handler();
                   break;
               case rebuildTaskIndexFixed.name:
                   result = await rebuildTaskIndexFixed.handler(args as any);
                   break;
               case 'diagnose_conversation_bom':
                   result = await this.handleDiagnoseConversationBom(args as any);
                   break;
               case 'repair_conversation_bom':
                   result = await this.handleRepairConversationBom(args as any);
                   /*case analyzeVSCodeGlobalState.name:
                       result = await analyzeVSCodeGlobalState.handler();
                       break;
                   case repairVSCodeTaskHistory.name:
                       result = await repairVSCodeTaskHistory.handler(args as any);
                       break;
                   case scanOrphanTasks.name:
                       result = await scanOrphanTasks.handler();
                       break;
                   case testWorkspaceExtraction.name:
                       result = await testWorkspaceExtraction.handler(args as any);
                       break;
                   case rebuildTaskIndex.name:
                       result = await rebuildTaskIndex.handler(args as any);
                       break;
                    case diagnoseSQLite.name:
                        result = await diagnoseSQLite.handler();
                        break;
                    case examineRooGlobalStateTool.name:
                        result = await examineRooGlobalStateTool.handler();
                        break;
                    case repairTaskHistoryTool.name:
                        result = await repairTaskHistoryTool.handler((args as any).target_workspace);
                        break;
                   case normalizeWorkspacePaths.name:
                      result = await normalizeWorkspacePaths.handler();
                      break;*/
                  break;
               case generateTraceSummaryTool.name: {
                   const summaryText = await handleGenerateTraceSummary(args as any, async (id: string) => {
                       return this.conversationCache.get(id) || null;
                   });
                   result = { content: [{ type: 'text', text: summaryText }] };
                   break;
               }
               case generateClusterSummaryTool.name: {
                   const clusterText = await handleGenerateClusterSummary(args as any, async (id: string) => {
                       return this.conversationCache.get(id) || null;
                   });
                   result = { content: [{ type: 'text', text: clusterText }] };
                   break;
               }
               case exportConversationJsonTool.name:
                  result = await this.handleExportConversationJson(args as any);
                  break;
               case exportConversationCsvTool.name:
                  result = await this.handleExportConversationCsv(args as any);
                  break;
              case exportTasksXmlTool.name:
                 result = await handleExportTasksXml(args as any, this.conversationCache, this.xmlExporterService, async () => { await this._ensureSkeletonCacheIsFresh(); });
                 break;
             case exportConversationXmlTool.name:
                 result = await handleExportConversationXml(args as any, this.conversationCache, this.xmlExporterService, async () => { await this._ensureSkeletonCacheIsFresh(); });
                 break;
             case exportProjectXmlTool.name:
                 result = await handleExportProjectXml(args as any, this.conversationCache, this.xmlExporterService, async (options?: { workspace?: string }) => { await this._ensureSkeletonCacheIsFresh(options); });
                 break;
             case configureXmlExportTool.name:
                 result = await handleConfigureXmlExport(args as any, this.exportConfigManager);
                 break;
                case getRawConversationTool.definition.name:
                    result = await getRawConversationTool.handler(args as any);
                    break;
              case getConversationSynthesisTool.name: {
                  const synthResult = await handleGetConversationSynthesis(args as any, async (id: string) => {
                      return this.conversationCache.get(id) || null;
                  });
                  result = { content: [{ type: 'text', text: typeof synthResult === 'string' ? synthResult : JSON.stringify(synthResult, null, 2) }] };
                  break;
              }
              case 'export_task_tree_markdown':
                  result = await handleExportTaskTreeMarkdown(
                      args as any,
                      async (treeArgs: any) => await handleGetTaskTree(treeArgs, this.conversationCache, async () => { await this._ensureSkeletonCacheIsFresh(); }),
                      async () => { await this._ensureSkeletonCacheIsFresh(); }
                  );
                  break;
              default:
                  throw new Error(`Tool not found: ${name}`);
          }

            return this._truncateResult(result);
        });
    }

    private _truncateResult(result: CallToolResult): CallToolResult {
        for (const item of result.content) {
            if (item.type === 'text' && item.text.length > MAX_OUTPUT_LENGTH) {
                item.text = item.text.substring(0, MAX_OUTPUT_LENGTH) + `\n\n[...]\n\n--- OUTPUT TRUNCATED AT ${MAX_OUTPUT_LENGTH} CHARACTERS ---`;
            }
        }
        return result;
    }


    async handleTouchMcpSettings(): Promise<CallToolResult> {
        const settingsPath = "c:/Users/jsboi/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json";
        const command = `(Get-Item "${settingsPath}").LastWriteTime = Get-Date`;
        
        return new Promise((resolve, reject) => {
            exec(`powershell.exe -Command "${command}"`, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(error.message));
                } else if (stderr) {
                    reject(new Error(stderr));
                } else {
                    const result = { success: true, message: stdout.trim() };
                    resolve({ content: [{ type: 'text', text: JSON.stringify(result) }] });
                }
            });
        });
    }

    /**
     * 🚨 HELPER: Construit une réponse standardisée pour les timeouts
     */
    private buildTimeoutResponse(
        skeletonsBuilt: number,
        skeletonsSkipped: number,
        hierarchyRelations: number,
        debugLogs: string[],
        timeoutMessage: string
    ): CallToolResult {
        const currentStats = this.conversationCache.size;
        const summary = `Skeleton cache build TIMEOUT (PARTIEL). Built: ${skeletonsBuilt}, Skipped: ${skeletonsSkipped}, Cache size: ${currentStats}, Hierarchy relations found: ${hierarchyRelations}`;
        
        const response = {
            summary,
            details: {
                mode: "TIMEOUT_PARTIAL",
                built: skeletonsBuilt,
                skipped: skeletonsSkipped,
                cached: currentStats,
                hierarchyRelations,
                timeoutMessage,
                nextAction: "⚠️ Relancez build_skeleton_cache pour compléter l'analyse des parentID"
            },
            debugLogs: debugLogs.slice(-20) // Garder seulement les 20 derniers logs
        };
        
        return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
    }

    async handleBuildSkeletonCache(args: { force_rebuild?: boolean; workspace_filter?: string } = {}): Promise<CallToolResult> {
        this.conversationCache.clear();
        const { force_rebuild = false, workspace_filter } = args;
        
        // 🚀 PROTECTION TIMEOUT ÉTENDU : 5 minutes pour permettre rebuilds complets
        const GLOBAL_TIMEOUT_MS = 300000; // 300s = 5 minutes (ancien: 50s)
        const globalStartTime = Date.now();
        let timeoutReached = false;
        
        // Helper pour vérifier le timeout global
        const checkGlobalTimeout = () => {
            if (Date.now() - globalStartTime > GLOBAL_TIMEOUT_MS) {
                timeoutReached = true;
                return true;
            }
            return false;
        };
        
        // 🔍 Capturer les logs de debug
        const debugLogs: string[] = [];
        const originalConsoleLog = console.log;
        console.log = (...args: any[]) => {
            const message = args.join(' ');
            if (message.includes('DEBUG') || message.includes('🎯') || message.includes('🔍') || message.includes('BALISE')) {
                debugLogs.push(`[${new Date().toISOString().split('T')[1].split('.')[0]}] ${message}`);
            }
            originalConsoleLog(...args);
        };
        
        const locations = await RooStorageDetector.detectStorageLocations(); // This returns base storage paths
        if (locations.length === 0) {
            console.log = originalConsoleLog; // Restaurer
            return { content: [{ type: 'text', text: 'Storage not found. Cache not built.' }] };
        }

        let skeletonsBuilt = 0;
        let skeletonsSkipped = 0;
        let hierarchyRelationsFound = 0;
        const mode = force_rebuild ? "FORCE_REBUILD" : "SMART_REBUILD";
        const filterMode = workspace_filter ? `WORKSPACE_FILTERED(${workspace_filter})` : "ALL_WORKSPACES";

        console.log(`🔄 Starting PROCESSUS DESCENDANT skeleton cache build in ${mode} mode, ${filterMode}...`);

        // 🚀 PROCESSUS DESCENDANT - PHASE 1: Construire tous les squelettes ET alimenter l'index RadixTree
        const skeletonsWithPrefixes: Array<{ skeleton: ConversationSkeleton; prefixes: string[] }> = [];
        
        for (const storageDir of locations) {
            // storageDir is the base storage path, we need to add 'tasks' to get to the tasks directory
            const tasksDir = path.join(storageDir, 'tasks');
            const skeletonDir = path.join(storageDir, SKELETON_CACHE_DIR_NAME);
            await fs.mkdir(skeletonDir, { recursive: true });

            let conversationDirs;
            try {
                conversationDirs = await fs.readdir(tasksDir, { withFileTypes: true });
            } catch (error) {
                console.warn(`Could not read tasks directory: ${tasksDir}`, error);
                continue;
            }
            for (const convDir of conversationDirs) {
                if (convDir.isDirectory() && convDir.name !== SKELETON_CACHE_DIR_NAME) {
                    const conversationId = convDir.name;
                    const taskPath = path.join(tasksDir, conversationId);
                    const metadataPath = path.join(taskPath, 'task_metadata.json');
                    const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
                    const uiMessagesPath = path.join(taskPath, 'ui_messages.json');
                    const skeletonPath = path.join(skeletonDir, `${conversationId}.json`);

                    try {
                        // 🔍 CORRECTION BUG: Valider la tâche si elle a au moins un fichier de conversation
                        // (pas seulement task_metadata.json qui peut manquer pour des tâches anciennes/récentes)
                        let isValidTask = false;
                        let metadataStat: any = null;
                        let validationSource = '';
                        
                        // Tentative 1: Vérifier task_metadata.json (préféré)
                        try {
                            metadataStat = await fs.stat(metadataPath);
                            isValidTask = true;
                            validationSource = 'task_metadata.json';
                        } catch {
                            // Tentative 2: Vérifier api_conversation_history.json
                            try {
                                const apiStat = await fs.stat(apiHistoryPath);
                                metadataStat = apiStat; // Utiliser la date du fichier API comme référence
                                isValidTask = true;
                                validationSource = 'api_conversation_history.json';
                            } catch {
                                // Tentative 3: Vérifier ui_messages.json
                                try {
                                    const uiStat = await fs.stat(uiMessagesPath);
                                    metadataStat = uiStat; // Utiliser la date du fichier UI comme référence
                                    isValidTask = true;
                                    validationSource = 'ui_messages.json';
                                } catch {
                                    // Aucun fichier valide trouvé
                                    console.warn(`⚠️ INVALID: Task ${conversationId} has no valid conversation files`);
                                }
                            }
                        }
                        
                        if (!isValidTask) {
                            console.log(`🔍 SKIP INVALID: ${conversationId} - no metadata/api/ui files found`);
                            skeletonsSkipped++;
                            continue;
                        }
                        
                        console.log(`✅ VALID: ${conversationId} (validated via ${validationSource})`);
                        
                        // 🎯 FILTRE WORKSPACE: Utiliser la même méthode que get_storage_stats pour cohérence
                        if (workspace_filter) {
                            try {
                                const taskWorkspace = await RooStorageDetector.detectWorkspaceForTask(taskPath);
                                
                                // Normalisation des chemins pour la comparaison
                                const normalizedFilter = path.normalize(workspace_filter).toLowerCase();
                                const normalizedWorkspace = path.normalize(taskWorkspace).toLowerCase();
                                
                                if (taskWorkspace === 'UNKNOWN' || !normalizedWorkspace.includes(normalizedFilter)) {
                                    continue; // Skip cette conversation si elle ne correspond pas au filtre
                                }
                            } catch (workspaceError) {
                                console.warn(`Could not detect workspace for filtering: ${taskPath}`, workspaceError);
                                continue; // Skip si on ne peut pas détecter le workspace
                            }
                        }
                        
                        let shouldRebuild = force_rebuild;
                        
                        if (!force_rebuild) {
                            // Mode intelligent : vérifier si le squelette est obsolète
                            try {
                                const skeletonStat = await fs.stat(skeletonPath);
                                if (skeletonStat.mtime >= metadataStat.mtime) {
                                    // Squelette à jour, le charger dans le cache
                                    try {
                                        let skeletonContent = await fs.readFile(skeletonPath, 'utf-8');
                                        if (skeletonContent.charCodeAt(0) === 0xFEFF) {
                                            skeletonContent = skeletonContent.slice(1);
                                        }
                                        const skeleton: ConversationSkeleton = JSON.parse(skeletonContent);
                                        if (skeleton && skeleton.taskId) {
                                            this.conversationCache.set(skeleton.taskId, skeleton);
                                            // 🚀 PHASE 1: Alimenter l'index avec les préfixes de ce squelette existant
                                            if (skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0) {
                                                skeletonsWithPrefixes.push({ skeleton, prefixes: skeleton.childTaskInstructionPrefixes });
                                            }
                                            skeletonsSkipped++;
                                        } else {
                                            shouldRebuild = true; // Squelette corrompu
                                        }
                                    } catch (loadError) {
                                        console.error(`Corrupted skeleton file, will rebuild: ${skeletonPath}`, loadError);
                                        shouldRebuild = true;
                                    }
                                } else {
                                    shouldRebuild = true; // Squelette obsolète
                                }
                            } catch (statError) {
                                shouldRebuild = true; // Squelette manquant
                            }
                        }
                        
                        if (shouldRebuild) {
                            try {
                                const skeleton = await RooStorageDetector.analyzeConversation(conversationId, taskPath);
                                if (skeleton) {
                                    await fs.writeFile(skeletonPath, JSON.stringify(skeleton, null, 2));
                                    // BUG FIX: Utiliser skeleton.taskId et non conversationId
                                    this.conversationCache.set(skeleton.taskId, skeleton);
                                    // 🚀 PHASE 1: Collecter les préfixes pour l'index RadixTree
                                    if (skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0) {
                                        skeletonsWithPrefixes.push({ skeleton, prefixes: skeleton.childTaskInstructionPrefixes });
                                    }
                                    skeletonsBuilt++;
                                } else {
                                    console.error(`❌ Failed to analyze conversation ${conversationId}: analyzeConversation returned null`);
                                    skeletonsSkipped++;
                                }
                            } catch (analyzeError) {
                                console.error(`❌ Error during analysis of ${conversationId}:`, analyzeError);
                                skeletonsSkipped++;
                            }
                        } else {
                        }
                        
                    } catch (error: any) {
                        // 🔍 AMÉLIORATION: Logging détaillé pour comprendre pourquoi une tâche est skipped
                        const errorMsg = error?.message || String(error);
                        if (errorMsg.includes('ENOENT')) {
                            console.warn(`⚠️ SKIP: Task ${conversationId} - File not found (${errorMsg})`);
                        } else if (errorMsg.includes('permission')) {
                            console.warn(`⚠️ SKIP: Task ${conversationId} - Permission denied`);
                        } else {
                            console.error(`❌ ERROR: Task ${conversationId} - ${errorMsg}`);
                        }
                        skeletonsSkipped++;
                    }
                }
            }
        }
        
        // 🚀 PROCESSUS DESCENDANT - PHASE 2: Alimenter le globalTaskInstructionIndex avec tous les préfixes
        console.log(`🔍 PHASE 2: Alimenting RadixTree with ${skeletonsWithPrefixes.length} tasks with prefixes...`);
        
        // Importer globalTaskInstructionIndex
        const { globalTaskInstructionIndex } = await import('./utils/task-instruction-index.js');
        
        // CORRECTION: Toujours vider l'index avant de le repeupler
        globalTaskInstructionIndex.clear();
        
        for (const { skeleton, prefixes } of skeletonsWithPrefixes) {
            for (const prefix of prefixes) {
                globalTaskInstructionIndex.addInstruction(skeleton.taskId, prefix);
            }
        }
        
        const indexStats = globalTaskInstructionIndex.getStats();
        console.log(`🎯 RadixTree populated: ${indexStats.totalInstructions} instructions, ${indexStats.totalNodes} nodes`);
        
        // Log critique seulement si problème détecté
        if (indexStats.totalInstructions === 0 && skeletonsWithPrefixes.length > 0) {
            console.log(`⚠️ ATTENTION: ${skeletonsWithPrefixes.length} squelettes avec préfixes mais index vide`);
        }
        
        // CORRECTION: Exécuter les Phases 2-3 même en mode intelligent si l'index était vide
        const shouldRunHierarchyPhase = indexStats.totalInstructions > 0;
        console.log(`🔍 Should run hierarchy phase: ${shouldRunHierarchyPhase} (index has ${indexStats.totalInstructions} instructions)`);
        
        // 🚀 PROCESSUS DESCENDANT - PHASE 3: Recalculer les relations parent-enfant avec l'index maintenant populé
        console.log(`🔗 PHASE 3: Recalculating parent-child relationships...`);
        
        const skeletonsToUpdate: Array<{ taskId: string; newParentId: string }> = [];
        const orphanSkeletons = Array.from(this.conversationCache.values()).filter(s =>
            !(((s as any)?.parentId) || s.parentTaskId) && s.metadata?.workspace
        );
        
        console.log(`🔍 Found ${orphanSkeletons.length} orphan tasks to process...`);
        
        // 🚨 VÉRIFICATION TIMEOUT AVANT PHASE HIÉRARCHIQUE
        if (checkGlobalTimeout()) {
            console.log(`⏰ TIMEOUT ANTICIPÉ atteint avant phase hiérarchique!`);
            const partialResult = this.buildTimeoutResponse(skeletonsBuilt, skeletonsSkipped, 0, debugLogs,
                "TIMEOUT: Phase hiérarchique non exécutée. Relancez le build pour compléter l'analyse des parentID.");
            console.log = originalConsoleLog; // Restaurer
            return partialResult;
        }
        
        // OPTIMISATION: Traiter par lots de 50 pour éviter les timeouts
        const BATCH_SIZE = 50;
        const MAX_PROCESSING_TIME = Math.min(35000, GLOBAL_TIMEOUT_MS - (Date.now() - globalStartTime) - 5000); // Garder 5s de marge
        const startTime = Date.now();
        
        console.log(`⏱️ Phase hiérarchique: ${MAX_PROCESSING_TIME}ms disponibles pour traiter ${orphanSkeletons.length} orphelins`);
        
        // 🎯 SOLUTION ARCHITECTURALE : Utiliser le VRAI HierarchyReconstructionEngine en MODE STRICT
        // ✅ EXÉCUTION UNIQUE sur TOUS les squelettes (pas batch par batch)
        console.log(`🚀 Utilisation du HierarchyReconstructionEngine (MODE STRICT - MATCHING EXACT) sur ${orphanSkeletons.length} orphelins...`);
        
        try {
            // Import dynamique du vrai engine
            const { HierarchyReconstructionEngine } = await import('./utils/hierarchy-reconstruction-engine.js');
            
            // Configuration STRICT comme demandé (matching exact seulement)
            const hierarchyEngine = new HierarchyReconstructionEngine({
                batchSize: 50,
                strictMode: true,        // ✅ MODE STRICT = MATCHING EXACT
                debugMode: true,
                forceRebuild: false
            });
            
            // Conversion des squelettes pour le vrai engine
            const enhancedSkeletons = Array.from(this.conversationCache.values()).map(skeleton => ({
                ...skeleton,
                // Enhanced fields requis par l'interface EnhancedConversationSkeleton
                // 🎯 FIX CRITIQUE : Ne PAS passer parsedSubtaskInstructions mais marquer phase1Completed
                // Le RadixTree est DÉJÀ alimenté aux lignes 1093-1100, donc Phase 1 doit être sautée
                parsedSubtaskInstructions: undefined,
                processingState: {
                    // ✅ CORRECTION : phase1Completed=true si les prefixes existent déjà
                    // Cela force shouldSkipPhase1() à retourner true et évite le double parsing
                    phase1Completed: !!(skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0),
                    phase2Completed: false,
                    processingErrors: [],
                    lastProcessedAt: new Date().toISOString()
                },
                sourceFileChecksums: {
                    uiMessages: undefined,
                    apiHistory: undefined,
                    metadata: undefined
                }
            }));
            
            console.log(`🎯 Lancement engine sur ${enhancedSkeletons.length} squelettes en MODE STRICT...`);
            
            // Phase 1: Extraction des instructions new_task (avec matching exact)
            console.log(`📋 Phase 1: Extraction des déclarations new_task en MODE STRICT...`);
            const phase1Result = await hierarchyEngine.executePhase1(enhancedSkeletons, { strictMode: true });
            console.log(`✅ Phase 1: ${phase1Result.processedCount} traités, ${phase1Result.totalInstructionsExtracted} instructions extraites`);
            
            // Phase 2: Reconstruction hiérarchique (avec matching exact)
            console.log(`🔗 Phase 2: Reconstruction hiérarchique MODE STRICT...`);
            const phase2Result = await hierarchyEngine.executePhase2(enhancedSkeletons, { strictMode: true });
            console.log(`✅ Phase 2: ${phase2Result.resolvedCount} relations assignées, ${phase2Result.unresolvedCount} ignorés`);
            
            // ✅ BUG FIX: Utiliser directement phase2Result.resolvedCount au lieu de re-compter
            hierarchyRelationsFound = phase2Result.resolvedCount;
            
            // Application des résultats (ne compter QUE les nouvelles relations via reconstructedParentId)
            enhancedSkeletons.forEach(skeleton => {
                const newlyResolvedParent = (skeleton as any)?.reconstructedParentId;
                if (newlyResolvedParent && newlyResolvedParent !== skeleton.taskId) {
                    skeletonsToUpdate.push({
                        taskId: skeleton.taskId,
                        newParentId: newlyResolvedParent
                    });

                    // Mettre à jour le cache en mémoire pour persister la relation avant sauvegarde disque
                    const cached = this.conversationCache.get(skeleton.taskId);
                    if (cached) {
                        cached.parentTaskId = newlyResolvedParent;
                        (cached as any).parentId = newlyResolvedParent;
                    }

                    console.log(`🎯 Relation MODE STRICT: ${skeleton.taskId.substring(0, 8)} → ${newlyResolvedParent.substring(0, 8)}`);
                }
            });
            
            console.log(`🎉 BILAN ENGINE MODE STRICT: ${hierarchyRelationsFound} relations trouvées !`);
            
        } catch (engineError) {
            console.error(`❌ Erreur HierarchyReconstructionEngine:`, engineError);
            console.log(`🔄 Fallback: Continuer sans hierarchy engine...`);
            
            // 🚨 Vérifier si c'est un timeout et adapter la réponse
            if (checkGlobalTimeout()) {
                const partialResult = this.buildTimeoutResponse(skeletonsBuilt, skeletonsSkipped, hierarchyRelationsFound, debugLogs,
                    "TIMEOUT: Build partiel terminé. Phase hiérarchique incomplète - relancez pour finaliser l'analyse parentID.");
                console.log = originalConsoleLog; // Restaurer
                return partialResult;
            }
        }
        
        // 🚨 VÉRIFICATION TIMEOUT AVANT SAUVEGARDE
        if (checkGlobalTimeout()) {
            console.log(`⏰ TIMEOUT ANTICIPÉ atteint avant sauvegarde!`);
            const partialResult = this.buildTimeoutResponse(skeletonsBuilt, skeletonsSkipped, hierarchyRelationsFound, debugLogs,
                "TIMEOUT: Relations trouvées mais sauvegarde incomplète. Relancez pour persister les changements.");
            console.log = originalConsoleLog; // Restaurer
            return partialResult;
        }
        
        console.log(`🔗 Found ${skeletonsToUpdate.length} parent-child relationships to apply...`);
        
        // Appliquer les mises à jour de hiérarchie (sans sauvegarde immédiate pour éviter timeout)
        for (const update of skeletonsToUpdate) {
            const skeleton = this.conversationCache.get(update.taskId);
            if (skeleton) {
                skeleton.parentTaskId = update.newParentId;
                // OPTIMISATION: Reporter la sauvegarde sur disque en arrière-plan
                // La sauvegarde sera faite lors du prochain rebuild ou sur demande
            }
        }
        
        // Sauvegarder TOUS les squelettes modifiés (correction bug MAX_SAVES)
        let savedCount = 0;
        for (const update of skeletonsToUpdate) {
            try {
                for (const storageDir of locations) {
                    const skeletonDir = path.join(storageDir, SKELETON_CACHE_DIR_NAME);
                    const skeletonPath = path.join(skeletonDir, `${update.taskId}.json`);
                    if (existsSync(skeletonPath)) {
                        const skeleton = this.conversationCache.get(update.taskId);
                        if (skeleton) {
                            await fs.writeFile(skeletonPath, JSON.stringify(skeleton, null, 2));
                            savedCount++;
                        }
                        break;
                    }
                }
            } catch (saveError) {
                console.error(`Failed to save updated skeleton for ${update.taskId}:`, saveError);
            }
        }
        
        console.log(`📝 Saved ${savedCount}/${skeletonsToUpdate.length} updated skeletons to disk`);
        
        console.log(`✅ Skeleton cache build complete. Mode: ${mode}, Cache size: ${this.conversationCache.size}, New relations: ${hierarchyRelationsFound}`);
        
        // 🔍 Restaurer console.log original
        console.log = originalConsoleLog;
        
        // 🔍 Inclure les logs de debug dans la réponse
        let response = `Skeleton cache build complete (${mode}). Built: ${skeletonsBuilt}, Skipped: ${skeletonsSkipped}, Cache size: ${this.conversationCache.size}, Hierarchy relations found: ${hierarchyRelationsFound}`;
        
        if (debugLogs.length > 0) {
            response += `\n\n🔍 DEBUG LOGS (${debugLogs.length} entries):\n${debugLogs.join('\n')}`;
        } else {
            response += `\n\n🔍 No debug logs captured (expected: DEBUG, 🎯, 🔍, BALISE keywords)`;
        }
        
        return { content: [{ type: 'text', text: response }] };
    }

    private truncateMessage(message: string, truncate: number): string {
        if (truncate === 0) {
            return message;
        }
        const lines = message.split('\n');
        if (lines.length <= truncate * 2) {
            return message;
        }
        const start = lines.slice(0, truncate).join('\n');
        const end = lines.slice(-truncate).join('\n');
        return `${start}\n[...]\n${end}`;
    }

    handleSimpleTest(): CallToolResult {
        return {
            content: [{ type: 'text', text: 'Test simple réussi!' }]
        };
    }

    async handleDiagnoseConversationBom(args: { fix_found?: boolean }): Promise<CallToolResult> {
        const { fix_found = false } = args;
        
        const locations = await RooStorageDetector.detectStorageLocations();
        if (locations.length === 0) {
            return { content: [{ type: 'text', text: 'Aucun emplacement de stockage Roo trouvé.' }] };
        }

        let totalFiles = 0;
        let corruptedFiles = 0;
        let repairedFiles = 0;
        const corruptedList: string[] = [];
        
        for (const location of locations) {
            try {
                const tasksPath = path.join(location, 'tasks');
                const conversationDirs = await fs.readdir(tasksPath, { withFileTypes: true });
                
                for (const convDir of conversationDirs) {
                    if (convDir.isDirectory()) {
                        const apiHistoryPath = path.join(tasksPath, convDir.name, 'api_conversation_history.json');
                        
                        try {
                            await fs.access(apiHistoryPath);
                            totalFiles++;
                            
                            const content = await fs.readFile(apiHistoryPath, 'utf-8');
                            const hasBOM = content.charCodeAt(0) === 0xFEFF;
                            
                            if (hasBOM) {
                                corruptedFiles++;
                                corruptedList.push(apiHistoryPath);
                                
                                if (fix_found) {
                                    // Réparer automatiquement
                                    const cleanContent = content.slice(1);
                                    try {
                                        JSON.parse(cleanContent); // Vérifier que c'est du JSON valide
                                        await fs.writeFile(apiHistoryPath, cleanContent, 'utf-8');
                                        repairedFiles++;
                                    } catch (jsonError) {
                                        console.error(`Fichier ${apiHistoryPath} corrompu au-delà du BOM:`, jsonError);
                                    }
                                }
                            }
                        } catch (fileError) {
                            // Fichier n'existe pas ou non accessible, on ignore
                        }
                    }
                }
            } catch (dirError) {
                console.error(`Erreur lors du scan de ${location}/tasks:`, dirError);
            }
        }
        
        let report = `# Diagnostic BOM des conversations\n\n`;
        report += `**Fichiers analysés:** ${totalFiles}\n`;
        report += `**Fichiers corrompus (BOM):** ${corruptedFiles}\n`;
        
        if (fix_found && repairedFiles > 0) {
            report += `**Fichiers réparés:** ${repairedFiles}\n\n`;
            report += `✅ Réparation automatique effectuée.\n`;
        } else if (corruptedFiles > 0) {
            report += `\n⚠️  Des fichiers corrompus ont été trouvés. Utilisez 'repair_conversation_bom' pour les réparer.\n`;
        }
        
        if (corruptedList.length > 0 && corruptedList.length <= 20) {
            report += `\n## Fichiers corrompus détectés:\n`;
            corruptedList.forEach(file => {
                report += `- ${file}\n`;
            });
        } else if (corruptedList.length > 20) {
            report += `\n## Fichiers corrompus détectés (20 premiers):\n`;
            corruptedList.slice(0, 20).forEach(file => {
                report += `- ${file}\n`;
            });
            report += `\n... et ${corruptedList.length - 20} autres fichiers.\n`;
        }
        
        return { content: [{ type: 'text', text: report }] };
    }

    async handleRepairConversationBom(args: { dry_run?: boolean }): Promise<CallToolResult> {
        const { dry_run = false } = args;
        
        const locations = await RooStorageDetector.detectStorageLocations();
        if (locations.length === 0) {
            return { content: [{ type: 'text', text: 'Aucun emplacement de stockage Roo trouvé.' }] };
        }

        let totalFiles = 0;
        let corruptedFiles = 0;
        let repairedFiles = 0;
        let failedRepairs = 0;
        const repairResults: { file: string, status: string, error?: string }[] = [];
        
        for (const location of locations) {
            try {
                const tasksPath = path.join(location, 'tasks');
                const conversationDirs = await fs.readdir(tasksPath, { withFileTypes: true });
                
                for (const convDir of conversationDirs) {
                    if (convDir.isDirectory()) {
                        const apiHistoryPath = path.join(tasksPath, convDir.name, 'api_conversation_history.json');
                        
                        try {
                            await fs.access(apiHistoryPath);
                            totalFiles++;
                            
                            const content = await fs.readFile(apiHistoryPath, 'utf-8');
                            const hasBOM = content.charCodeAt(0) === 0xFEFF;
                            
                            if (hasBOM) {
                                corruptedFiles++;
                                
                                if (dry_run) {
                                    repairResults.push({
                                        file: apiHistoryPath,
                                        status: 'SERAIT_REPARE'
                                    });
                                } else {
                                    // Effectuer la réparation
                                    try {
                                        const cleanContent = content.slice(1);
                                        JSON.parse(cleanContent); // Vérifier que c'est du JSON valide
                                        await fs.writeFile(apiHistoryPath, cleanContent, 'utf-8');
                                        repairedFiles++;
                                        repairResults.push({
                                            file: apiHistoryPath,
                                            status: 'REPARE'
                                        });
                                    } catch (repairError) {
                                        failedRepairs++;
                                        repairResults.push({
                                            file: apiHistoryPath,
                                            status: 'ECHEC',
                                            error: repairError instanceof Error ? repairError.message : String(repairError)
                                        });
                                    }
                                }
                            }
                        } catch (fileError) {
                            // Fichier n'existe pas ou non accessible, on ignore
                        }
                    }
                }
            } catch (dirError) {
                console.error(`Erreur lors du scan de ${location}/tasks:`, dirError);
            }
        }
        
        let report = `# Réparation BOM des conversations\n\n`;
        report += `**Mode:** ${dry_run ? 'Simulation (dry-run)' : 'Réparation réelle'}\n`;
        report += `**Fichiers analysés:** ${totalFiles}\n`;
        report += `**Fichiers corrompus (BOM):** ${corruptedFiles}\n`;
        
        if (!dry_run) {
            report += `**Fichiers réparés:** ${repairedFiles}\n`;
            report += `**Échecs de réparation:** ${failedRepairs}\n\n`;
            
            if (repairedFiles > 0) {
                report += `✅ ${repairedFiles} fichier(s) réparé(s) avec succès.\n`;
            }
            if (failedRepairs > 0) {
                report += `❌ ${failedRepairs} échec(s) de réparation (fichiers corrompus au-delà du BOM).\n`;
            }
        } else {
            report += `\n🔍 Simulation terminée. ${corruptedFiles} fichier(s) seraient réparés.\n`;
        }
        
        if (repairResults.length > 0 && repairResults.length <= 30) {
            report += `\n## Détails des opérations:\n`;
            repairResults.forEach(result => {
                const statusIcon = result.status === 'REPARE' ? '✅' :
                                 result.status === 'SERAIT_REPARE' ? '🔍' : '❌';
                report += `${statusIcon} ${result.file}`;
                if (result.error) {
                    report += ` - Erreur: ${result.error}`;
                }
                report += `\n`;
            });
        } else if (repairResults.length > 30) {
            report += `\n## Détails des opérations (30 premiers résultats):\n`;
            repairResults.slice(0, 30).forEach(result => {
                const statusIcon = result.status === 'REPARE' ? '✅' :
                                 result.status === 'SERAIT_REPARE' ? '🔍' : '❌';
                report += `${statusIcon} ${result.file}\n`;
            });
            report += `\n... et ${repairResults.length - 30} autres résultats.\n`;
        }
        
        return { content: [{ type: 'text', text: report }] };
    }




    /**
     * Extrait une séquence d'actions (métadonnées) depuis la séquence de messages
     */
    private extractActionSequence(sequence: any[]): ActionMetadata[] {
        const actions: ActionMetadata[] = [];
        
        for (const item of sequence) {
            // Extraire les actions des messages assistant
            if (item.role === 'assistant' && item.content) {
                const timestamp = item.timestamp || new Date().toISOString();
                
                // Support pour les deux formats : content array et content direct
                let contentArray = Array.isArray(item.content) ? item.content : [item.content];
                
                for (const contentItem of contentArray) {
                    if (contentItem.type === 'tool_use' || contentItem.type === 'tool_result') {
                        const action: ActionMetadata = {
                            type: 'tool',
                            name: contentItem.name || contentItem.tool || 'unknown_tool',
                            status: contentItem.isError ? 'failure' : 'success',
                            parameters: contentItem.input || contentItem.parameters || {},
                            timestamp: new Date(timestamp).toISOString()
                        };

                        if (contentItem.input?.path) action.file_path = contentItem.input.path;
                        if (contentItem.content) action.content_size = String(contentItem.content).length;

                        actions.push(action);
                    }
                }
            }
        }

        // Trier par timestamp
        actions.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        return actions;
    }

    /**
     * NOUVELLE MÉTHODE : Améliore un squelette du cache avec les données complètes si trouvées sur disque
     */
    private async enhanceSkeletonWithFullData(skeleton: ConversationSkeleton): Promise<ConversationSkeleton> {
        // Essayer de trouver les fichiers dans tous les workspaces connus
        const allSkeletons = Array.from(this.conversationCache.values());
        const workspaces = [...new Set(allSkeletons.map(s => s.metadata.workspace).filter(w => w && w.trim() !== ''))];

        for (const workspace of workspaces) {
            if (!workspace) continue; // Double vérification de sécurité
            const taskPath = path.join(workspace, skeleton.taskId);
            try {
                await fs.access(taskPath);
                // Trouvé ! Reconstruire avec les données complètes
                const enhanced = await this.buildCompleteConversationFromFiles(skeleton.taskId, taskPath);
                if (enhanced) {
                    return enhanced;
                }
            } catch (e) {
                // Continue vers le workspace suivant
            }
        }

        // Si aucun fichier trouvé, retourner le squelette original mais enlever la troncature
        const enhancedSequence = skeleton.sequence.map(item => {
            if ('content' in item) {
                return {
                    ...item,
                    isTruncated: false // Marquer comme non tronqué même si c'est peut-être faux
                } as MessageSkeleton;
            }
            return item;
        });

        return {
            ...skeleton,
            sequence: enhancedSequence
        };
    }

    /**
     * Gère l'export de conversations au format JSON
     */
    async handleExportConversationJson(args: {
        taskId: string;
        filePath?: string;
        jsonVariant?: 'light' | 'full';
        truncationChars?: number;
    }): Promise<CallToolResult> {
        try {
            const { taskId } = args;
            
            if (!taskId) {
                throw new Error("taskId est requis");
            }

            // Récupérer le ConversationSkeleton depuis le cache
            const conversation = this.conversationCache.get(taskId);
            if (!conversation) {
                throw new Error(`Conversation avec taskId ${taskId} introuvable`);
            }

            // Utiliser le handler de tool externe
            const getConversationSkeleton = async (id: string) => {
                return this.conversationCache.get(id) || null;
            };

            const result = await handleExportConversationJson(args, getConversationSkeleton);

            return {
                content: [{ type: 'text', text: result }]
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
            return {
                content: [{ type: 'text', text: `❌ Erreur lors de l'export JSON: ${errorMessage}` }],
                isError: true
            };
        }
    }

    /**
     * Gère l'export de conversations au format CSV
     */
    async handleExportConversationCsv(args: {
        taskId: string;
        filePath?: string;
        csvVariant?: 'conversations' | 'messages' | 'tools';
        truncationChars?: number;
    }): Promise<CallToolResult> {
        try {
            const { taskId } = args;
            
            if (!taskId) {
                throw new Error("taskId est requis");
            }

            // Récupérer le ConversationSkeleton depuis le cache
            const conversation = this.conversationCache.get(taskId);
            if (!conversation) {
                throw new Error(`Conversation avec taskId ${taskId} introuvable`);
            }

            // Utiliser le handler de tool externe
            const getConversationSkeleton = async (id: string) => {
                return this.conversationCache.get(id) || null;
            };

            const result = await handleExportConversationCsv(args, getConversationSkeleton);

            return {
                content: [{ type: 'text', text: result }]
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
            return {
                content: [{ type: 'text', text: `❌ Erreur lors de l'export CSV: ${errorMessage}` }],
                isError: true
            };
        }
    }

    
    /**
     * 🚀 NOUVEAU : Exporte un arbre de tâches au format Markdown hiérarchique
     */
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error(`Roo State Manager Server started - v${packageJson.version}`);
    }

    /**
     * FAILSAFE: Ensure skeleton cache is fresh and up-to-date
     * Vérifie si le cache des squelettes est à jour et déclenche une reconstruction différentielle si nécessaire
     *
     * @param args - Arguments optionnels pour filtrer la reconstruction par workspace
     * @param args.workspace - Filtre optionnel par workspace pour limiter la portée de la reconstruction
     */
    private async _ensureSkeletonCacheIsFresh(args?: { workspace?: string }): Promise<boolean> {
        try {
            console.log('[FAILSAFE] Checking skeleton cache freshness...');
            
            // Vérifier si le cache est vide - reconstruction nécessaire
            if (this.conversationCache.size === 0) {
                console.log('[FAILSAFE] Cache empty, triggering differential rebuild...');
                await this.handleBuildSkeletonCache({
                    force_rebuild: false,
                    workspace_filter: args?.workspace
                });
                return true;
            }
            
            // Vérifier si des nouvelles conversations existent depuis la dernière mise à jour
            const storageLocations = await RooStorageDetector.detectStorageLocations();
            if (storageLocations.length === 0) {
                console.log('[FAILSAFE] No storage locations found');
                return false;
            }
            
            let needsUpdate = false;
            const now = Date.now();
            const CACHE_VALIDITY_MS = 5 * 60 * 1000; // 5 minutes
            
            // Vérifier les modifications récentes dans chaque emplacement
            for (const location of storageLocations) {
                try {
                    const conversationDirs = await fs.readdir(location, { withFileTypes: true });
                    
                    for (const convDir of conversationDirs.slice(0, 10)) { // Limite à 10 pour performance
                        if (convDir.isDirectory() && convDir.name !== '.skeletons') {
                            const taskPath = path.join(location, convDir.name);
                            const metadataPath = path.join(taskPath, 'task_metadata.json');
                            
                            try {
                                const metadataStat = await fs.stat(metadataPath);
                                const ageMs = now - metadataStat.mtime.getTime();
                                
                                // Si metadata récent ET pas dans le cache
                                if (ageMs < CACHE_VALIDITY_MS && !this.conversationCache.has(convDir.name)) {
                                    console.log(`[FAILSAFE] New task detected: ${convDir.name}, age: ${Math.round(ageMs/1000)}s`);
                                    needsUpdate = true;
                                    break;
                                }
                            } catch (statError) {
                                // Ignorer les erreurs de stat
                            }
                        }
                    }
                    
                    if (needsUpdate) break;
                } catch (readdirError) {
                    console.warn(`[FAILSAFE] Could not read directory ${location}:`, readdirError);
                }
            }
            
            // Déclencher reconstruction différentielle si nécessaire
            if (needsUpdate) {
                console.log('[FAILSAFE] Cache outdated, triggering differential rebuild...');
                await this.handleBuildSkeletonCache({
                    force_rebuild: false,
                    workspace_filter: args?.workspace
                });
                return true;
            }
            
            console.log('[FAILSAFE] Skeleton cache is fresh');
            return false;
            
        } catch (error) {
            console.error('[FAILSAFE] Error checking skeleton cache freshness:', error);
            return false;
        }
    }

    /**
     * FAILSAFE: Ensure Qdrant index is fresh and available
     * Vérifie si l'index Qdrant est à jour et déclenche une réindexation si nécessaire
     */
    private async _ensureQdrantIndexIsFresh(): Promise<boolean> {
        try {
            console.log('[FAILSAFE] Checking Qdrant index freshness...');
            
            const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
            
            try {
                const qdrant = getQdrantClient();
                const collectionInfo = await qdrant.getCollection(collectionName);
                console.log(`[FAILSAFE] Qdrant collection "${collectionName}" exists with ${collectionInfo.vectors_count} vectors`);
                
                // Vérifier si nous avons des squelettes non indexés
                let unindexedCount = 0;
                const now = Date.now();
                const INDEX_VALIDITY_MS = 10 * 60 * 1000; // 10 minutes
                
                for (const [taskId, skeleton] of this.conversationCache.entries()) {
                    const lastIndexed = skeleton.metadata?.qdrantIndexedAt;
                    if (!lastIndexed) {
                        unindexedCount++;
                    } else {
                        const indexAge = now - new Date(lastIndexed).getTime();
                        if (indexAge > INDEX_VALIDITY_MS) {
                            unindexedCount++;
                        }
                    }
                    
                    // Limite de vérification pour performance
                    if (unindexedCount > 5) break;
                }
                
                // Déclencher réindexation si nécessaire
                if (unindexedCount > 0) {
                    console.log(`[FAILSAFE] Found ${unindexedCount}+ tasks needing indexation, triggering background indexing...`);
                    
                    // Ajouter les tâches non indexées à la queue
                    let tasksQueued = 0;
                    for (const [taskId, skeleton] of this.conversationCache.entries()) {
                        const lastIndexed = skeleton.metadata?.qdrantIndexedAt;
                        if (!lastIndexed || (now - new Date(lastIndexed).getTime()) > INDEX_VALIDITY_MS) {
                            this.qdrantIndexQueue.add(taskId);
                            tasksQueued++;
                            if (tasksQueued >= 10) break; // Limite pour éviter la surcharge
                        }
                    }
                    
                    console.log(`[FAILSAFE] Queued ${tasksQueued} tasks for indexation`);
                    return true;
                }
                
                console.log('[FAILSAFE] Qdrant index is fresh');
                return false;
                
            } catch (collectionError) {
                console.log(`[FAILSAFE] Qdrant collection "${collectionName}" not found or inaccessible:`, collectionError);
                return false;
            }
            
        } catch (error) {
            console.error('[FAILSAFE] Error checking Qdrant index freshness:', error);
            return false;
        }
    }

    /**
     * Load existing skeletons from disk at startup
     */
    private async _loadSkeletonsFromDisk(): Promise<void> {
        try {
            console.log('Loading existing skeletons from disk...');
            const storageLocations = await RooStorageDetector.detectStorageLocations();
            
            if (storageLocations.length === 0) {
                console.warn('Aucun emplacement de stockage Roo trouvé');
                return;
            }

            const skeletonsCacheDir = path.join(storageLocations[0], '.skeletons');
            
            try {
                const skeletonFiles = await fs.readdir(skeletonsCacheDir);
                const jsonFiles = skeletonFiles.filter(file => file.endsWith('.json'));
                
                console.log(`Found ${jsonFiles.length} skeleton files to load`);
                
                for (const file of jsonFiles) {
                    try {
                        const filePath = path.join(skeletonsCacheDir, file);
                        const content = await fs.readFile(filePath, 'utf8');
                        const skeleton: ConversationSkeleton = JSON.parse(content);
                        this.conversationCache.set(skeleton.taskId, skeleton);
                    } catch (error) {
                        console.warn(`Failed to load skeleton ${file}:`, error);
                    }
                }
                
                console.log(`Loaded ${this.conversationCache.size} skeletons from disk`);
            } catch (error) {
                console.warn('Skeleton cache directory not found, will be created when needed');
            }
        } catch (error) {
            console.error('Failed to load skeletons from disk:', error);
        }
    }

    /**
     * Auto-réparation proactive des métadonnées manquantes au démarrage
     * Détecte et génère les fichiers task_metadata.json manquants pour les conversations existantes
     */
    private async _startProactiveMetadataRepair(): Promise<void> {
        console.log('[Auto-Repair] 🔧 Démarrage du scan proactif de réparation des métadonnées...');
        
        try {
            const locations = await RooStorageDetector.detectStorageLocations();
            if (locations.length === 0) {
                console.log('[Auto-Repair] ℹ️ Aucun emplacement de stockage trouvé. Scan terminé.');
                return;
            }

            let repairedCount = 0;
            const tasksToRepair: { taskId: string, taskPath: string }[] = [];

            // 1. Détecter toutes les tâches nécessitant une réparation
            for (const loc of locations) {
                const tasksPath = path.join(loc, 'tasks');
                try {
                    const taskIds = await fs.readdir(tasksPath);

                    for (const taskId of taskIds) {
                        if (taskId === '.skeletons') continue; // Ignorer le répertoire de cache
                        
                        const taskPath = path.join(tasksPath, taskId);
                        const metadataPath = path.join(taskPath, 'task_metadata.json');
                        
                        try {
                            // Vérifier si le répertoire est valide et contient des fichiers
                            const stats = await fs.stat(taskPath);
                            if (!stats.isDirectory()) continue;
                            
                            const files = await fs.readdir(taskPath);
                            if (files.length === 0) continue; // Ignorer les répertoires vides
                            
                            // Vérifier si task_metadata.json existe
                            try {
                                await fs.access(metadataPath);
                            } catch {
                                // Le fichier n'existe pas, il faut le réparer
                                tasksToRepair.push({ taskId, taskPath });
                            }
                        } catch (error) {
                            // Ignorer les erreurs individuelles de tâches
                            console.debug(`[Auto-Repair] Erreur lors de l'analyse de ${taskId}:`, error);
                        }
                    }
                } catch (error) {
                    console.warn(`[Auto-Repair] ⚠️ Erreur lors de la lecture de ${tasksPath}:`, error);
                }
            }
            
            if (tasksToRepair.length === 0) {
                console.log('[Auto-Repair] ✅ Tous les squelettes sont cohérents. Scan terminé.');
                return;
            }

            console.log(`[Auto-Repair] 📋 Trouvé ${tasksToRepair.length} tâches nécessitant une réparation de métadonnées.`);

            // 2. Traiter la réparation en parallèle (avec une limite)
            const concurrencyLimit = 5; // Évite de surcharger le disque
            for (let i = 0; i < tasksToRepair.length; i += concurrencyLimit) {
                const batch = tasksToRepair.slice(i, i + concurrencyLimit);
                await Promise.all(batch.map(async (task) => {
                    try {
                        const skeleton = await RooStorageDetector.analyzeConversation(task.taskId, task.taskPath);
                        if (skeleton && skeleton.metadata) {
                            const metadataFilePath = path.join(task.taskPath, 'task_metadata.json');
                            await fs.writeFile(metadataFilePath, JSON.stringify(skeleton.metadata, null, 2), 'utf-8');
                            repairedCount++;
                        } else {
                            console.debug(`[Auto-Repair] ⚠️ Impossible de générer le squelette pour ${task.taskId}`);
                        }
                    } catch (e) {
                         console.debug(`[Auto-Repair] ❌ Échec de réparation pour ${task.taskId}:`, e);
                    }
                }));
                console.log(`[Auto-Repair] 📊 Lot traité, ${repairedCount}/${tasksToRepair.length} réparées jusqu'à présent...`);
            }

            console.log(`[Auto-Repair] ✅ Scan terminé. ${repairedCount} métadonnées réparées avec succès.`);

        } catch (error) {
            console.error('[Auto-Repair] ❌ Erreur critique lors du scan:', error);
            // Ne pas rethrow pour éviter de bloquer le démarrage du serveur
        }
    }

    /**
     * Initialise les services de background pour l'architecture à 2 niveaux
     * Niveau 1: Reconstruction temps réel des squelettes
     * Niveau 2: Indexation Qdrant asynchrone non-bloquante
     */
    private async _initializeBackgroundServices(): Promise<void> {
        try {
            console.log('🚀 Initialisation des services background à 2 niveaux...');
            
            // Niveau 1: Chargement initial des squelettes depuis le disque
            await this._loadSkeletonsFromDisk();
            
            // Auto-réparation proactive: Génération des métadonnées manquantes
            await this._startProactiveMetadataRepair();
            
            // Niveau 2: Initialisation du service d'indexation Qdrant asynchrone
            await this._initializeQdrantIndexingService();
            
            console.log('✅ Services background initialisés avec succès');
        } catch (error: any) {
            console.error('❌ Erreur lors de l\'initialisation des services background:', error);
            throw error;
        }
    }

    /**
     * Initialise le service d'indexation Qdrant asynchrone (Niveau 2)
     * Vérifie les squelettes non-indexés et lance le processus de fond
     */
    private async _initializeQdrantIndexingService(): Promise<void> {
        try {
            console.log('🔍 Initialisation du service d\'indexation Qdrant...');
            
            // Vérifier la cohérence entre squelettes et index Qdrant (filtré par machine)
            await this._verifyQdrantConsistency();
            
            // Vérifier les squelettes qui nécessitent une réindexation
            await this._scanForOutdatedQdrantIndex();
            
            // Démarrer le service d'indexation en arrière-plan (non-bloquant)
            this._startQdrantIndexingBackgroundProcess();
            
            console.log('✅ Service d\'indexation Qdrant initialisé');
        } catch (error: any) {
            console.error('⚠️  Erreur lors de l\'initialisation de l\'indexation Qdrant (non-bloquant):', error);
            // Ne pas rethrow - l'échec de Qdrant ne doit pas bloquer le serveur
            this.isQdrantIndexingEnabled = false;
        }
    }

    /**
     * Scanner pour identifier les squelettes ayant besoin d'une réindexation
     * NOUVEAU : Utilise le service de décision d'indexation avec mécanisme d'idempotence
     */
    private async _scanForOutdatedQdrantIndex(): Promise<void> {
        let indexCount = 0;
        let skipCount = 0;
        let retryCount = 0;
        let failedCount = 0;
        let migratedCount = 0;
        
        console.log(`🔍 Début du scan d'indexation avec mécanisme d'idempotence...`);
        
        for (const [taskId, skeleton] of this.conversationCache.entries()) {
            this.indexingMetrics.totalTasks++;
            
            // Migration automatique des anciens formats
            if (this.indexingDecisionService.migrateLegacyIndexingState(skeleton)) {
                migratedCount++;
                await this._saveSkeletonToDisk(skeleton);
            }
            
            // Décision d'indexation avec nouvelle logique
            const decision = this.indexingDecisionService.shouldIndex(skeleton);
            
            // 🆕 FIX CRITIQUE : Sauvegarder si une migration legacy a eu lieu durant shouldIndex
            if (decision.requiresSave) {
                await this._saveSkeletonToDisk(skeleton);
                migratedCount++; // Compter cette migration dans le rapport
            }
            
            if (decision.shouldIndex) {
                this.qdrantIndexQueue.add(taskId);
                if (decision.action === 'retry') {
                    retryCount++;
                    this.indexingMetrics.retryTasks++;
                } else {
                    indexCount++;
                }
            } else {
                skipCount++;
                this.indexingMetrics.skippedTasks++;
                // Journalisation explicite des skips pour validation anti-fuite
                console.log(`[SKIP] ${taskId}: ${decision.reason}`);
                
                if (skeleton.metadata.indexingState?.indexStatus === 'failed') {
                    failedCount++;
                    this.indexingMetrics.failedTasks++;
                }
            }
        }
        
        // Rapport de scan détaillé
        console.log(`📊 Scan terminé avec mécanisme d'idempotence:`);
        console.log(`   ✅ À indexer: ${indexCount} tâches`);
        console.log(`   🔄 À retenter: ${retryCount} tâches`);
        console.log(`   ⏭️  Skippées: ${skipCount} tâches (anti-fuite)`);
        console.log(`   ❌ Échecs permanents: ${failedCount} tâches`);
        console.log(`   🔄 Migrations legacy: ${migratedCount} tâches`);
        
        const totalToProcess = indexCount + retryCount;
        if (totalToProcess > 1000) {
            console.log(`⚠️  Queue importante détectée: ${totalToProcess} tâches à traiter`);
            console.log(`💡 Traitement progressif avec rate limiting intelligent (100 ops/min)`);
            console.log(`⏱️  Temps estimé: ${Math.ceil(totalToProcess / 100)} minutes`);
        }
        
        // Estimation de la bande passante économisée
        const estimatedSavings = skipCount * 50000; // ~50KB par tâche skippée
        this.indexingMetrics.bandwidthSaved += estimatedSavings;
        console.log(`💰 Bande passante économisée: ~${Math.round(estimatedSavings / 1024 / 1024)}MB grâce aux skips`);
        
        // Log de mode force si actif
        if (process.env.ROO_INDEX_FORCE === '1' || process.env.ROO_INDEX_FORCE === 'true') {
            console.log(`🚨 MODE FORCE ACTIF: Tous les skips ont été ignorés (ROO_INDEX_FORCE=${process.env.ROO_INDEX_FORCE})`);
        }
    }

    /**
     * Vérifie la cohérence entre les squelettes locaux et l'index Qdrant (filtré par machine)
     * 🛡️ PROTECTION ANTI-FUITE: Limitée à 1x/24h au lieu de chaque démarrage
     */
    private async _verifyQdrantConsistency(): Promise<void> {
        try {
            // 🛡️ ANTI-FUITE: Vérifier si la dernière vérification est trop récente
            const now = Date.now();
            if (now - this.lastQdrantConsistencyCheck < this.CONSISTENCY_CHECK_INTERVAL) {
                console.log('⏳ Vérification Qdrant ignorée (dernière < 24h) - Protection anti-fuite');
                return;
            }
            
            console.log('🔍 Vérification de la cohérence Qdrant vs Squelettes...');
            
            const { TaskIndexer, getHostIdentifier } = await import('./services/task-indexer.js');
            const taskIndexer = new TaskIndexer();
            
            // Obtenir l'identifiant de la machine actuelle
            const currentHostId = getHostIdentifier();
            console.log(`🖥️  Machine actuelle: ${currentHostId}`);
            
            // Compter les squelettes locaux marqués comme indexés
            let localIndexedCount = 0;
            for (const [taskId, skeleton] of this.conversationCache.entries()) {
                if (skeleton.metadata?.qdrantIndexedAt) {
                    localIndexedCount++;
                }
            }
            
            // 🛡️ APPEL RÉSEAU QDRANT (maintenant limité à 1x/24h)
            const qdrantCount = await taskIndexer.countPointsByHostOs(currentHostId);
            
            // Marquer la dernière vérification
            this.lastQdrantConsistencyCheck = now;
            
            console.log(`📊 Cohérence Qdrant:`);
            console.log(`   - Squelettes locaux indexés: ${localIndexedCount}`);
            console.log(`   - Points Qdrant (machine ${currentHostId}): ${qdrantCount}`);
            
            // Détecter les incohérences
            const discrepancy = Math.abs(localIndexedCount - qdrantCount);
            // Seuil tolérant : 25% ou min 50
            const threshold = Math.max(50, Math.floor(localIndexedCount * 0.25));
            
            if (discrepancy > threshold) {
                console.warn(`⚠️  Incohérence détectée: écart de ${discrepancy} entre squelettes et Qdrant`);
                console.log(`📊 Seuil de tolérance: ${threshold} (25% de ${localIndexedCount})`);
                console.log(`✨ Pas d'inquiétude: les tâches manquantes seront indexées par le scan automatique`);
                
                // Pas de réindexation forcée ici - le _scanForOutdatedQdrantIndex() s'en occupe
                // Cela évite la duplication de tâches dans la queue
                
            } else {
                console.log(`✅ Cohérence Qdrant-Squelettes validée (écart acceptable: ${discrepancy})`);
            }
            
        } catch (error) {
            console.error('❌ Erreur lors de la vérification de cohérence Qdrant:', error);
            // Non-bloquant, on continue
        }
    }

    /**
     * Démarre le processus d'indexation Qdrant en arrière-plan
     */
    private _startQdrantIndexingBackgroundProcess(): void {
        if (this.qdrantIndexInterval) {
            clearInterval(this.qdrantIndexInterval);
        }
        
        // 🛡️ ANTI-FUITE: 5 minutes au lieu de 30 secondes (10× moins fréquent)
        this.qdrantIndexInterval = setInterval(async () => {
            if (!this.isQdrantIndexingEnabled || this.qdrantIndexQueue.size === 0) {
                return;
            }
            
            // Prendre le premier élément de la queue
            const taskId = this.qdrantIndexQueue.values().next().value;
            if (taskId) {
                this.qdrantIndexQueue.delete(taskId);
                await this._indexTaskInQdrant(taskId);
            }
        }, this.MAX_BACKGROUND_INTERVAL); // 5 minutes au lieu de 30 secondes
        
        console.log('🔄 Service d\'indexation Qdrant en arrière-plan démarré');
    }

    /**
     * Indexe une tâche spécifique dans Qdrant et met à jour son état d'indexation
     * NOUVEAU : Utilise le service de décision d'indexation avec gestion complète des états
     */
    private async _indexTaskInQdrant(taskId: string): Promise<void> {
        try {
            const skeleton = this.conversationCache.get(taskId);
            if (!skeleton) {
                console.warn(`[WARN] Skeleton for task ${taskId} not found in cache. Skipping indexing.`);
                return;
            }
            
            // NOUVELLE LOGIQUE : Vérifier la décision d'indexation en temps réel
            const decision = this.indexingDecisionService.shouldIndex(skeleton);
            
            // 🆕 FIX CRITIQUE : Sauvegarder si migration legacy effectuée même en cas de skip
            if (decision.requiresSave) {
                await this._saveSkeletonToDisk(skeleton);
                console.log(`[MIGRATION] Task ${taskId}: Migration legacy sauvegardée`);
            }
            
            if (!decision.shouldIndex) {
                console.log(`[SKIP] Task ${taskId}: ${decision.reason} - Protection anti-fuite`);
                return;
            }
            
            console.log(`[INDEX] Task ${taskId}: ${decision.reason}`);
    
            // 🌐 APPEL RÉSEAU - Indexation Qdrant
            const taskIndexer = new TaskIndexer();
            await taskIndexer.indexTask(taskId);
    
            // NOUVEAU : Marquer le succès avec état complet
            this.indexingDecisionService.markIndexingSuccess(skeleton);
            await this._saveSkeletonToDisk(skeleton);
            
            // Maintenir la compatibilité avec l'ancien cache (LEGACY)
            this.qdrantIndexCache.set(taskId, Date.now());
    
            // Mettre à jour les métriques
            this.indexingMetrics.indexedTasks++;
    
            console.log(`[SUCCESS] Task ${taskId} successfully indexed in Qdrant.`);
    
        } catch (error: any) {
            if (error.message && error.message.includes('not found in any storage location')) {
                console.warn(`[WARN] Task ${taskId} is in cache but not on disk. Skipping indexing.`);
            } else {
                // NOUVEAU : Gestion intelligente des échecs avec classification
                const skeleton = this.conversationCache.get(taskId);
                if (skeleton) {
                    const isPermanentError = this._classifyIndexingError(error);
                    this.indexingDecisionService.markIndexingFailure(skeleton, error.message, isPermanentError);
                    await this._saveSkeletonToDisk(skeleton);
                    
                    this.indexingMetrics.failedTasks++;
                    
                    if (isPermanentError) {
                        console.error(`[PERMANENT_FAIL] Task ${taskId}: ${error.message} - Marqué pour skip définitif`);
                    } else {
                        console.error(`[RETRY_FAIL] Task ${taskId}: ${error.message} - Programmé pour retry avec backoff`);
                    }
                }
                
                console.error(`[ERROR] Failed to index task ${taskId} in Qdrant:`, error);
            }
        }
    }

    /**
     * Classifie les erreurs d'indexation pour déterminer si elles sont permanentes
     * NOUVEAU : Logique de classification des erreurs pour éviter les retry infinis
     */
    private _classifyIndexingError(error: any): boolean {
        const errorMessage = error.message ? error.message.toLowerCase() : '';
        
        // Erreurs permanentes (ne pas retry)
        const permanentErrors = [
            'file not found',
            'access denied',
            'permission denied',
            'invalid format',
            'corrupted data',
            'authentication failed',
            'quota exceeded permanently'
        ];
        
        // Erreurs temporaires (retry autorisé)
        const temporaryErrors = [
            'network error',
            'connection timeout',
            'rate limit',
            'service unavailable',
            'timeout',
            'econnreset',
            'enotfound'
        ];
        
        // Vérifier les erreurs permanentes
        if (permanentErrors.some(perm => errorMessage.includes(perm))) {
            return true; // Échec permanent
        }
        
        // Vérifier les erreurs temporaires
        if (temporaryErrors.some(temp => errorMessage.includes(temp))) {
            return false; // Échec temporaire, retry autorisé
        }
        
        // Par défaut, considérer comme temporaire mais avec limite de retry
        return false;
    }

    /**
     * Sauvegarde un squelette sur le disque
     */
    private async _saveSkeletonToDisk(skeleton: ConversationSkeleton): Promise<void> {
        try {
            const storageLocations = await RooStorageDetector.detectStorageLocations();
            if (storageLocations.length === 0) {
                throw new Error('Aucun emplacement de stockage Roo trouvé');
            }

            const skeletonsCacheDir = path.join(storageLocations[0], '.skeletons');
            await fs.mkdir(skeletonsCacheDir, { recursive: true });

            const filePath = path.join(skeletonsCacheDir, `${skeleton.taskId}.json`);
            await fs.writeFile(filePath, JSON.stringify(skeleton, null, 2), 'utf8');
        } catch (error: any) {
            console.error(`Erreur lors de la sauvegarde du squelette ${skeleton.taskId}:`, error);
        }
    }

    /**
     * Ajoute une tâche à la queue d'indexation Qdrant (appelé quand un squelette est mis à jour)
     */
    private _queueForQdrantIndexing(taskId: string): void {
        if (this.isQdrantIndexingEnabled) {
            this.qdrantIndexQueue.add(taskId);
        }
    }

    /**
     * Construire une conversation complète depuis les fichiers
     */
    private async buildCompleteConversationFromFiles(taskId: string, taskPath: string): Promise<ConversationSkeleton | null> {
        try {
            return await RooStorageDetector.analyzeConversation(taskId, taskPath);
        } catch (error) {
            console.error(`Erreur lors de la construction complète de la conversation ${taskId}:`, error);
            return null;
        }
    }

    async stop() {
        // Arrêter le service d'indexation Qdrant
        if (this.qdrantIndexInterval) {
            clearInterval(this.qdrantIndexInterval);
            this.qdrantIndexInterval = null;
        }
        
        if (this.server && this.server.transport) {
            this.server.transport.close();
        }
    }
}

try {
    const server = new RooStateManagerServer();
    server.run().catch((error) => {
        console.error('Fatal error during server execution:', error);
        process.exit(1);
    });
} catch (error) {
    console.error('Fatal error during server initialization:', error);
    process.exit(1);
}

export { RooStateManagerServer };
