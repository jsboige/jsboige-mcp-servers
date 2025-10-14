
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import os from 'os';

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
import { readVscodeLogs, rebuildAndRestart, getMcpBestPractices, manageMcpSettings, rebuildTaskIndexFixed, generateTraceSummaryTool, handleGenerateTraceSummary, generateClusterSummaryTool, handleGenerateClusterSummary, exportConversationJsonTool, handleExportConversationJson, exportConversationCsvTool, handleExportConversationCsv, viewConversationTree, getConversationSynthesisTool, handleGetConversationSynthesis, detectStorageTool, getStorageStatsTool, listConversationsTool, debugAnalyzeTool, getRawConversationTool, viewTaskDetailsTool, getTaskTreeTool, handleGetTaskTree, debugTaskParsingTool, handleDebugTaskParsing, exportTaskTreeMarkdownTool, handleExportTaskTreeMarkdown, searchTasksSemanticTool, handleSearchTasksSemanticFallback, indexTaskSemanticTool, handleDiagnoseSemanticIndex, resetQdrantCollectionTool, exportTasksXmlTool, handleExportTasksXml, exportConversationXmlTool, handleExportConversationXml, exportProjectXmlTool, handleExportProjectXml, configureXmlExportTool, handleConfigureXmlExport, roosyncTools, roosyncInit, roosyncGetStatus, roosyncCompareConfig, roosyncListDiffs, roosyncGetDecisionDetails, roosyncApproveDecision, roosyncRejectDecision, roosyncApplyDecision, roosyncRollbackDecision, buildSkeletonCacheDefinition, handleBuildSkeletonCache, diagnoseConversationBomTool, repairConversationBomTool } from './tools/index.js';
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
                    buildSkeletonCacheDefinition,
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
                    diagnoseConversationBomTool.definition,
                    repairConversationBomTool.definition,
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
                    // RooSync tools - Batch 6 synchronization
                    ...roosyncTools,
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
                    result = await handleBuildSkeletonCache(args as any, this.conversationCache);
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
                   result = await diagnoseConversationBomTool.handler(args as any);
                   break;
               case 'repair_conversation_bom':
                   result = await repairConversationBomTool.handler(args as any);
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
              // RooSync tools - Batch 6 synchronization
              case 'roosync_get_status':
                  try {
                      const roosyncResult = await roosyncGetStatus(args as any);
                      result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
                  } catch (error) {
                      result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
                  }
                  break;
              case 'roosync_compare_config':
                  try {
                      const roosyncResult = await roosyncCompareConfig(args as any);
                      result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
                  } catch (error) {
                      result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
                  }
                  break;
              case 'roosync_list_diffs':
                  try {
                      const roosyncResult = await roosyncListDiffs(args as any);
                      result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
                  } catch (error) {
                      result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
                  }
                  break;
              case 'roosync_get_decision_details':
                  try {
                      const roosyncResult = await roosyncGetDecisionDetails(args as any);
                      result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
                  } catch (error) {
                      result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
                  }
                  break;
              case 'roosync_approve_decision':
                  try {
                      const roosyncResult = await roosyncApproveDecision(args as any);
                      result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
                  } catch (error) {
                      result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
                  }
                  break;
              case 'roosync_reject_decision':
                  try {
                      const roosyncResult = await roosyncRejectDecision(args as any);
                      result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
                  } catch (error) {
                      result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
                  }
                  break;
              case 'roosync_apply_decision':
                  try {
                      const roosyncResult = await roosyncApplyDecision(args as any);
                      result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
                  } catch (error) {
                      result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
                  }
                  break;
              case 'roosync_rollback_decision':
                  try {
                      const roosyncResult = await roosyncRollbackDecision(args as any);
                      result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
                  } catch (error) {
                      result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
                  }
                  break;
              case 'roosync_init':
                  try {
                      const roosyncResult = await roosyncInit(args as any);
                      result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
                  } catch (error) {
                      result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
                  }
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
        const appDataPath = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const settingsPath = path.join(appDataPath, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json');
        const command = `(Get-Item "${settingsPath.replace(/\\/g, '/')}").LastWriteTime = Get-Date`;
        
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
                await handleBuildSkeletonCache({
                    force_rebuild: false,
                    workspace_filter: args?.workspace
                }, this.conversationCache);
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
                await handleBuildSkeletonCache({
                    force_rebuild: false,
                    workspace_filter: args?.workspace
                }, this.conversationCache);
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
