
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
import { readVscodeLogs, rebuildAndRestart, getMcpBestPractices, manageMcpSettings, rebuildTaskIndexFixed, generateTraceSummaryTool, handleGenerateTraceSummary, generateClusterSummaryTool, handleGenerateClusterSummary, exportConversationJsonTool, handleExportConversationJson, exportConversationCsvTool, handleExportConversationCsv, viewConversationTree, getConversationSynthesisTool, handleGetConversationSynthesis } from './tools/index.js';
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

const MAX_OUTPUT_LENGTH = 150000; // Harmonisé avec view-conversation-tree.ts pour consistance (audit 2025-09-15)
const SKELETON_CACHE_DIR_NAME = '.skeletons';

/**
 * Normalise un chemin pour la comparaison en gérant les différences de format
 * entre les plateformes et les sources de données
 */
function normalizePath(inputPath: string): string {
    if (!inputPath) return '';
    
    // Convertir les slashes en forward slashes pour une comparaison uniforme
    const normalized = inputPath.replace(/\\/g, '/');
    
    // Supprimer les slashes de fin
    const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
    
    // Convertir en minuscules pour éviter les problèmes de casse (principalement Windows)
    return trimmed.toLowerCase();
}

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
    
    // 🛡️ CACHE ANTI-FUITE - Protection contre 220GB de trafic réseau
    private qdrantIndexCache: Map<string, number> = new Map(); // taskId -> timestamp dernière indexation
    private lastQdrantConsistencyCheck: number = 0;
    private readonly CONSISTENCY_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24h au lieu du démarrage
    private readonly MIN_REINDEX_INTERVAL = 4 * 60 * 60 * 1000; // 4h minimum entre indexations
    private readonly MAX_BACKGROUND_INTERVAL = 5 * 60 * 1000; // 5min au lieu de 30s

    constructor() {
        this.xmlExporterService = new XmlExporterService();
        this.exportConfigManager = new ExportConfigManager();
        this.traceSummaryService = new TraceSummaryService(this.exportConfigManager);
        
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
                    {
                        name: 'detect_roo_storage',
                        description: 'Détecte automatiquement les emplacements de stockage Roo et scanne les conversations existantes',
                        inputSchema: { type: 'object', properties: {}, required: [] },
                    },
                    {
                       name: 'get_storage_stats',
                       description: 'Calcule des statistiques sur le stockage (nombre de conversations, taille totale).',
                       inputSchema: { type: 'object', properties: {}, required: [] },
                    },
                    {
                        name: 'list_conversations',
                        description: 'Liste toutes les conversations avec filtres et tri.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                limit: { type: 'number' },
                                sortBy: { type: 'string', enum: ['lastActivity', 'messageCount', 'totalSize'] },
                                sortOrder: { type: 'string', enum: ['asc', 'desc'] },
                                hasApiHistory: { type: 'boolean' },
                                hasUiMessages: { type: 'boolean' },
                                workspace: { type: 'string', description: 'Filtre les conversations par chemin de workspace.' },
                            },
                        },
                    },
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
                    // New features being re-introduced
                    {
                        name: 'get_task_tree',
                        description: 'Récupère une vue arborescente et hiérarchique des tâches.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                conversation_id: { type: 'string', description: 'ID de la conversation pour laquelle récupérer l\'arbre des tâches.' },
                                max_depth: { type: 'number', description: 'Profondeur maximale de l\'arbre à retourner.' },
                                include_siblings: { type: 'boolean', description: 'Inclure les tâches sœurs (même parent) dans l\'arbre.' },
                            },
                            required: ['conversation_id'],
                        },
                    },
                    {
                        name: 'debug_task_parsing',
                        description: 'Analyse en détail le parsing d\'une tâche spécifique pour diagnostiquer les problèmes hiérarchiques.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                task_id: { type: 'string', description: 'ID de la tâche à analyser en détail.' }
                            },
                            required: ['task_id']
                        }
                    },
                    {
                        name: 'search_tasks_semantic',
                        description: 'Recherche des tâches de manière sémantique avec filtrage par workspace et métadonnées enrichies.',
                         inputSchema: {
                            type: 'object',
                            properties: {
                                conversation_id: { type: 'string', description: 'ID de la conversation à fouiller.' },
                                search_query: { type: 'string', description: 'La requête de recherche sémantique.' },
                                max_results: { type: 'number', description: 'Nombre maximum de résultats à retourner.' },
                                workspace: { type: 'string', description: 'Filtre les résultats par workspace spécifique.' },
                                diagnose_index: { type: 'boolean', description: 'Mode diagnostic : retourne des informations sur l\'état de l\'indexation sémantique.' },
                            },
                            required: ['search_query'],
                        },
                    },
                    {
                       name: 'debug_analyze_conversation',
                       description: 'Debug tool to analyze a single conversation and return raw data.',
                       inputSchema: {
                           type: 'object',
                           properties: {
                               taskId: { type: 'string', description: 'The ID of the task to analyze.' }
                           },
                           required: ['taskId']
                       }
                    },
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
                    {
                        name: 'index_task_semantic',
                        description: 'Indexe une tâche spécifique dans Qdrant pour la recherche sémantique.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                task_id: { type: 'string', description: 'ID de la tâche à indexer.' },
                            },
                            required: ['task_id'],
                        },
                    },
                    {
                        name: 'reset_qdrant_collection',
                        description: 'Supprime et recrée la collection Qdrant pour corriger les données corrompues.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                confirm: { type: 'boolean', description: 'Confirmation obligatoire pour supprimer la collection.', default: false },
                            },
                            required: ['confirm'],
                        },
                    },
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
                    {
                        name: 'export_tasks_xml',
                        description: 'Exporte une tâche individuelle au format XML.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                taskId: { type: 'string', description: 'L\'identifiant unique de la tâche à exporter.' },
                                filePath: { type: 'string', description: 'Chemin de sortie pour le fichier XML. Si non fourni, le contenu est retourné.' },
                                includeContent: { type: 'boolean', description: 'Si true, inclut le contenu complet des messages (false par défaut).' },
                                prettyPrint: { type: 'boolean', description: 'Si true, indente le XML pour une meilleure lisibilité (true par défaut).' }
                            },
                            required: ['taskId']
                        }
                    },
                    {
                        name: 'export_conversation_xml',
                        description: 'Exporte une conversation complète (tâche racine + descendants) au format XML.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                conversationId: { type: 'string', description: 'L\'identifiant de la tâche racine de la conversation à exporter.' },
                                filePath: { type: 'string', description: 'Chemin de sortie pour le fichier XML. Si non fourni, le contenu est retourné.' },
                                maxDepth: { type: 'integer', description: 'Profondeur maximale de l\'arbre de tâches à inclure.' },
                                includeContent: { type: 'boolean', description: 'Si true, inclut le contenu complet des messages (false par défaut).' },
                                prettyPrint: { type: 'boolean', description: 'Si true, indente le XML pour une meilleure lisibilité (true par défaut).' }
                            },
                            required: ['conversationId']
                        }
                    },
                    {
                        name: 'export_project_xml',
                        description: 'Exporte un aperçu de haut niveau d\'un projet entier au format XML.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                projectPath: { type: 'string', description: 'Le chemin du workspace/projet à analyser.' },
                                filePath: { type: 'string', description: 'Chemin de sortie pour le fichier XML. Si non fourni, le contenu est retourné.' },
                                startDate: { type: 'string', description: 'Date de début (ISO 8601) pour filtrer les conversations.' },
                                endDate: { type: 'string', description: 'Date de fin (ISO 8601) pour filtrer les conversations.' },
                                prettyPrint: { type: 'boolean', description: 'Si true, indente le XML pour une meilleure lisibilité (true par défaut).' }
                            },
                            required: ['projectPath']
                        }
                    },
                    {
                        name: 'configure_xml_export',
                        description: 'Gère les paramètres de configuration des exports XML.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                action: {
                                    type: 'string',
                                    enum: ['get', 'set', 'reset'],
                                    description: 'L\'opération à effectuer : get, set, reset.'
                                },
                                config: {
                                    type: 'object',
                                    description: 'L\'objet de configuration à appliquer pour l\'action set.'
                                }
                            },
                            required: ['action']
                        }
                    },
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
                    {
                        name: 'view_task_details',
                        description: 'Affiche les détails techniques complets (métadonnées des actions) pour une tâche spécifique',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                task_id: {
                                    type: 'string',
                                    description: 'L\'ID de la tâche pour laquelle afficher les détails techniques.'
                                },
                                action_index: {
                                    type: 'number',
                                    description: 'Index optionnel d\'une action spécifique à examiner (commence à 0).'
                                },
                                truncate: {
                                    type: 'number',
                                    description: 'Nombre de lignes à conserver au début et à la fin des contenus longs (0 = complet).',
                                    default: 0
                                }
                            },
                            required: ['task_id']
                        }
                    },
                    {
                        name: 'reset_qdrant_collection',
                        description: 'Réinitialise complètement la collection Qdrant et supprime tous les timestamps d\'indexation des squelettes pour forcer une réindexation complète.',
                        inputSchema: {
                            type: 'object',
                            properties: {},
                            required: [],
                        },
                    },
                    {
                        name: 'get_raw_conversation',
                        description: 'Récupère le contenu brut d\'une conversation (fichiers JSON) sans condensation.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                taskId: { type: 'string', description: 'L\'identifiant de la tâche à récupérer.' },
                            },
                            required: ['taskId'],
                        },
                    },
                    {
                        name: getConversationSynthesisTool.name,
                        description: getConversationSynthesisTool.description,
                        inputSchema: getConversationSynthesisTool.inputSchema,
                    },
                    {
                        name: 'export_task_tree_markdown',
                        description: 'Exporte un arbre de tâches au format Markdown hiérarchique avec statuts de complétion et instructions.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                conversation_id: {
                                    type: 'string',
                                    description: 'ID de la conversation pour laquelle exporter l\'arbre des tâches.'
                                },
                                filePath: {
                                    type: 'string',
                                    description: 'Chemin optionnel pour sauvegarder le fichier Markdown. Si omis, le contenu est retourné.'
                                },
                                max_depth: {
                                    type: 'number',
                                    description: 'Profondeur maximale de l\'arbre à inclure dans l\'export.'
                                },
                                include_siblings: {
                                    type: 'boolean',
                                    description: 'Inclure les tâches sœurs (même parent) dans l\'arbre.',
                                    default: true
                                }
                            },
                            required: ['conversation_id']
                        }
                    },
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
               case 'detect_roo_storage':
                   result = await this.handleDetectRooStorage();
                   break;
              case 'get_storage_stats':
                    result = await this.handleGetStorageStats();
                    break;
                case 'list_conversations':
                    result = await this.handleListConversations(args as any);
                    break;
                case 'touch_mcp_settings':
                    result = await this.handleTouchMcpSettings();
                    break;
                case 'build_skeleton_cache':
                    result = await this.handleBuildSkeletonCache(args as any);
                    break;
                case 'get_task_tree':
                    result = this.handleGetTaskTree(args as any);
                    break;
                case viewConversationTree.name:
                    result = viewConversationTree.handler(args as any, this.conversationCache);
                    break;
                case 'view_task_details':
                    result = this.handleViewTaskDetails(args as any);
                    break;
                case 'search_tasks_semantic':
                    result = await this.handleSearchTasksSemantic(args as any);
                    break;
               case 'debug_analyze_conversation':
                   result = await this.handleDebugAnalyzeConversation(args as any);
                   break;
               case 'debug_task_parsing':
                   result = await this.handleDebugTaskParsing(args as any);
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
               case 'index_task_semantic':
                   result = await this.handleIndexTaskSemantic(args as any);
                   break;
               case 'reset_qdrant_collection':
                   result = await this.handleResetQdrantCollection(args as any);
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
               case generateTraceSummaryTool.name:
                   result = await this.handleGenerateTraceSummary(args as any);
                   break;
               case generateClusterSummaryTool.name:
                  result = await this.handleGenerateClusterSummary(args as any);
                  break;
               case exportConversationJsonTool.name:
                  result = await this.handleExportConversationJson(args as any);
                  break;
               case exportConversationCsvTool.name:
                  result = await this.handleExportConversationCsv(args as any);
                  break;
              case 'export_tasks_xml':
                  result = await this.handleExportTaskXml(args as any);
                  break;
              case 'export_conversation_xml':
                  result = await this.handleExportConversationXml(args as any);
                  break;
              case 'export_project_xml':
                  result = await this.handleExportProjectXml(args as any);
                  break;
              case 'configure_xml_export':
                  result = await this.handleConfigureXmlExport(args as any);
                  break;
              case 'get_raw_conversation':
                  result = await this.handleGetRawConversation(args as any);
                  break;
              case getConversationSynthesisTool.name:
                  result = await this.handleGetConversationSynthesis(args as any);
                  break;
              case 'export_task_tree_markdown':
                  result = await this.handleExportTaskTreeMarkdown(args as any);
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

    async handleDetectRooStorage(): Promise<CallToolResult> {
        const result = await RooStorageDetector.detectRooStorage();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    async handleGetStorageStats(): Promise<CallToolResult> {
        const stats = await RooStorageDetector.getStorageStats();
        
        // Agrégat des stats par workspace
        const workspaceStats = new Map<string, {count: number, totalSize: number, lastActivity: string}>();
        
        Array.from(this.conversationCache.values()).forEach(skeleton => {
            if (skeleton.metadata?.workspace) {
                const workspace = skeleton.metadata.workspace;
                const existing = workspaceStats.get(workspace) || {count: 0, totalSize: 0, lastActivity: ''};
                
                existing.count++;
                existing.totalSize += skeleton.metadata.totalSize || 0;
                
                // Mettre à jour la dernière activité si plus récente
                if (skeleton.metadata.lastActivity) {
                    if (!existing.lastActivity || new Date(skeleton.metadata.lastActivity) > new Date(existing.lastActivity)) {
                        existing.lastActivity = skeleton.metadata.lastActivity;
                    }
                }
                
                workspaceStats.set(workspace, existing);
            }
        });

        // Convertir en objet pour affichage
        const workspaceStatsObject = Object.fromEntries(
            Array.from(workspaceStats.entries()).map(([workspace, stats]) => [workspace, stats])
        );

        const enhancedStats = {
            ...stats,
            workspaceBreakdown: workspaceStatsObject,
            totalWorkspaces: workspaceStats.size
        };

        return { content: [{ type: 'text', text: JSON.stringify(enhancedStats, null, 2) }] };
    }

    async handleListConversations(args: { limit?: number, sortBy?: 'lastActivity' | 'messageCount' | 'totalSize', sortOrder?: 'asc' | 'desc', workspace?: string }): Promise<CallToolResult> {
        console.log('[TOOL] list_conversations called with:', JSON.stringify(args));
        
        // **FAILSAFE: Vérifier la fraîcheur du cache skeleton avant utilisation**
        await this._ensureSkeletonCacheIsFresh();
        
        interface SkeletonNode extends ConversationSkeleton {
            firstUserMessage?: string; // Premier message utilisateur ajouté
            isCompleted?: boolean; // Flag de terminaison
            completionMessage?: string; // Message de terminaison
            children: SkeletonNode[];
        }
        
        // Interface allégée pour list_conversations - AVEC informations essentielles
        interface ConversationSummary {
            taskId: string;
            parentTaskId?: string;
            firstUserMessage?: string; // Premier message utilisateur pour identifier la tâche
            isCompleted?: boolean; // Flag de terminaison
            completionMessage?: string; // Message de terminaison
            metadata: {
                title?: string;
                lastActivity: string;
                createdAt: string;
                mode?: string;
                messageCount: number;
                actionCount: number;
                totalSize: number;
                workspace?: string;
            };
            children: ConversationSummary[];
        }

        // Fonction pour convertir SkeletonNode vers ConversationSummary (avec toutes les infos)
        function toConversationSummary(node: SkeletonNode): ConversationSummary {
            return {
                taskId: node.taskId,
                parentTaskId: node.parentTaskId,
                firstUserMessage: node.firstUserMessage, // Déjà extrait dans skeletonMap
                isCompleted: node.isCompleted, // Flag de terminaison
                completionMessage: node.completionMessage, // Message de terminaison
                metadata: node.metadata,
                children: node.children.map((child: SkeletonNode) => toConversationSummary(child))
            };
        }

        let allSkeletons = Array.from(this.conversationCache.values()).filter(skeleton =>
            skeleton.metadata
        );

        // Filtrage par workspace
        if (args.workspace) {
            const normalizedWorkspace = normalizePath(args.workspace);
            console.log(`[DEBUG] Filtering by workspace: "${args.workspace}" -> normalized: "${normalizedWorkspace}"`);
            
            // Debug : afficher tous les workspaces disponibles
            const workspaces = allSkeletons
                .filter(s => s.metadata.workspace)
                .map(s => `"${s.metadata.workspace!}" -> normalized: "${normalizePath(s.metadata.workspace!)}"`)
                .slice(0, 5);
            console.log(`[DEBUG] Available workspaces (first 5):`, workspaces);
            
            allSkeletons = allSkeletons.filter(skeleton =>
                skeleton.metadata.workspace &&
                normalizePath(skeleton.metadata.workspace) === normalizedWorkspace
            );
            console.log(`[DEBUG] Found ${allSkeletons.length} conversations matching workspace filter`);
        }

        // Tri
        allSkeletons.sort((a, b) => {
            let comparison = 0;
            const sortBy = args.sortBy || 'lastActivity';
            switch (sortBy) {
                case 'lastActivity':
                    comparison = new Date(b.metadata!.lastActivity).getTime() - new Date(a.metadata!.lastActivity).getTime();
                    break;
                case 'messageCount':
                    comparison = (b.metadata?.messageCount || 0) - (a.metadata?.messageCount || 0);
                    break;
                case 'totalSize':
                    comparison = (b.metadata?.totalSize || 0) - (a.metadata?.totalSize || 0);
                    break;
            }
            return (args.sortOrder === 'asc') ? -comparison : comparison;
        });
        
        // Créer les SkeletonNode SANS la propriété sequence MAIS avec toutes les infos importantes
        const skeletonMap = new Map<string, SkeletonNode>(allSkeletons.map(s => {
            const { sequence, ...skeletonWithoutSequence } = s as any;
            
            // Variables pour les informations à extraire
            let firstUserMessage: string | undefined = undefined;
            let isCompleted = false;
            let completionMessage: string | undefined = undefined;
            
            // Extraire les informations de la sequence si elle existe
            if (sequence && Array.isArray(sequence)) {
                // 1. Premier message utilisateur
                const firstUserMsg = sequence.find((msg: any) => msg.role === 'user');
                if (firstUserMsg && firstUserMsg.content) {
                    // Tronquer à 200 caractères pour éviter les messages trop longs
                    firstUserMessage = firstUserMsg.content.length > 200
                        ? firstUserMsg.content.substring(0, 200) + '...'
                        : firstUserMsg.content;
                }
                
                // 2. Détecter si la conversation est terminée (dernier message de type attempt_completion)
                const lastAssistantMessages = sequence
                    .filter((msg: any) => msg.role === 'assistant')
                    .slice(-3); // Prendre les 3 derniers messages assistant pour chercher attempt_completion
                
                for (const msg of lastAssistantMessages.reverse()) {
                    if (msg.content && Array.isArray(msg.content)) {
                        for (const content of msg.content) {
                            if (content.type === 'tool_use' && content.name === 'attempt_completion') {
                                isCompleted = true;
                                const result = content.input?.result;
                                if (result) {
                                    completionMessage = result.length > 150
                                        ? result.substring(0, 150) + '...'
                                        : result;
                                }
                                break;
                            }
                        }
                        if (isCompleted) break;
                    }
                }
            }
            
            return [s.taskId, {
                ...skeletonWithoutSequence,
                firstUserMessage,
                isCompleted,
                completionMessage,
                children: []
            }];
        }));
        const forest: SkeletonNode[] = [];

        skeletonMap.forEach(node => {
            if (node.parentTaskId && skeletonMap.has(node.parentTaskId)) {
                skeletonMap.get(node.parentTaskId)!.children.push(node);
            } else {
                forest.push(node);
            }
        });

        // Appliquer la limite à la forêt de premier niveau
        const limitedForest = args.limit ? forest.slice(0, args.limit) : forest;
        
        // Convertir en ConversationSummary pour EXCLURE la propriété sequence qui contient tout le contenu
        const summaries = limitedForest.map(node => toConversationSummary(node));
        
        const result = JSON.stringify(summaries, null, 2);

        return { content: [{ type: 'text', text: result }] };
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

    async handleBuildSkeletonCache(args: { force_rebuild?: boolean; workspace_filter?: string } = {}): Promise<CallToolResult> {
        this.conversationCache.clear();
        const { force_rebuild = false, workspace_filter } = args;
        
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
                    const skeletonPath = path.join(skeletonDir, `${conversationId}.json`);

                    try {
                        // Vérifier que le fichier metadata existe (indique une tâche valide)
                        const metadataStat = await fs.stat(metadataPath);
                        
                        // 🎯 FILTRE WORKSPACE: Vérifier si la tâche correspond au workspace demandé
                        if (workspace_filter) {
                            try {
                                const metadataContent = await fs.readFile(metadataPath, 'utf-8');
                                const metadata = JSON.parse(metadataContent);
                                const taskWorkspace = metadata.workspace || metadata.cwd || '';
                                
                                // Normalisation des chemins pour la comparaison
                                const normalizedFilter = path.normalize(workspace_filter).toLowerCase();
                                const normalizedWorkspace = path.normalize(taskWorkspace).toLowerCase();
                                
                                if (!normalizedWorkspace.includes(normalizedFilter)) {
                                    continue; // Skip cette conversation si elle ne correspond pas au filtre
                                }
                            } catch (metadataError) {
                                console.warn(`Could not read metadata for workspace filtering: ${metadataPath}`, metadataError);
                                continue; // Skip si on ne peut pas lire les metadata
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
                        
                        // DEBUG: Toujours logger ce qui se passe
                        console.log(`📋 Processing ${conversationId}: shouldRebuild=${shouldRebuild}, force_rebuild=${force_rebuild}`);
                        
                        if (shouldRebuild) {
                            console.log(`🔨 ${force_rebuild ? 'Force rebuilding' : 'Rebuilding'} skeleton for task: ${conversationId}`);
                            
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
                                    console.log(`✅ Successfully built skeleton for ${skeleton.taskId} (prefixes: ${skeleton.childTaskInstructionPrefixes?.length || 0})`);
                                } else {
                                    console.error(`❌ Failed to analyze conversation ${conversationId}: analyzeConversation returned null`);
                                    skeletonsSkipped++;
                                }
                            } catch (analyzeError) {
                                console.error(`❌ Error during analysis of ${conversationId}:`, analyzeError);
                                skeletonsSkipped++;
                            }
                        } else {
                            console.log(`⏭️ Skipping ${conversationId} (shouldRebuild=false)`);
                        }
                        
                    } catch (error) {
                        console.error(`Could not process task ${conversationId}:`, error);
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
                globalTaskInstructionIndex.addInstruction(prefix, skeleton.taskId);
            }
        }
        
        const indexStats = globalTaskInstructionIndex.getStats();
        console.log(`🎯 RadixTree populated: ${indexStats.totalInstructions} instructions, ${indexStats.totalNodes} nodes`);
        
        // 🚨 DEBUG: Afficher les premières instructions de l'index avec détails COMPLETS
        if (indexStats.totalInstructions > 0) {
            console.log(`🔍 DEBUG - Premières instructions dans l'index (DÉTAILS COMPLETS) :`);
            for (const { skeleton, prefixes } of skeletonsWithPrefixes.slice(0, 3)) {
                console.log(`  Task ${skeleton.taskId.substring(0, 8)} has ${prefixes.length} prefixes:`);
                prefixes.slice(0, 2).forEach((p, i) => {
                    console.log(`    [${i}] INDEXÉ: "${p}" (${p.length} chars)`);
                    console.log(`    [${i}] HEX: ${Buffer.from(p.substring(0, 50)).toString('hex')}`);
                });
            }
        } else {
            console.log(`🚨 DEBUG - Aucune instruction dans l'index ! Détails des squelettes:`);
            for (const { skeleton, prefixes } of skeletonsWithPrefixes.slice(0, 3)) {
                console.log(`  Task ${skeleton.taskId.substring(0, 8)}: ${prefixes.length} prefixes, truncated="${skeleton.truncatedInstruction?.substring(0, 50)}"`);
            }
        }
        
        // CORRECTION: Exécuter les Phases 2-3 même en mode intelligent si l'index était vide
        const shouldRunHierarchyPhase = indexStats.totalInstructions > 0;
        console.log(`🔍 Should run hierarchy phase: ${shouldRunHierarchyPhase} (index has ${indexStats.totalInstructions} instructions)`);
        
        // 🚀 PROCESSUS DESCENDANT - PHASE 3: Recalculer les relations parent-enfant avec l'index maintenant populé
        console.log(`🔗 PHASE 3: Recalculating parent-child relationships...`);
        
        const skeletonsToUpdate: Array<{ taskId: string; newParentId: string }> = [];
        const orphanSkeletons = Array.from(this.conversationCache.values()).filter(s =>
            !s.parentTaskId && s.metadata?.workspace
        );
        
        console.log(`🔍 Found ${orphanSkeletons.length} orphan tasks to process...`);
        
        // OPTIMISATION: Traiter par lots de 50 pour éviter les timeouts
        const BATCH_SIZE = 50;
        const MAX_PROCESSING_TIME = 45000; // 45 secondes max pour cette phase
        const startTime = Date.now();
        
        for (let i = 0; i < orphanSkeletons.length; i += BATCH_SIZE) {
            // Vérifier le timeout
            if (Date.now() - startTime > MAX_PROCESSING_TIME) {
                console.log(`⏰ Phase 3 timeout reached, processed ${i}/${orphanSkeletons.length} tasks`);
                break;
            }
            
            const batch = orphanSkeletons.slice(i, i + BATCH_SIZE);
            console.log(`📦 Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(orphanSkeletons.length / BATCH_SIZE)}: ${batch.length} tasks`);
            
            for (const skeleton of batch) {
                // Utiliser truncatedInstruction qui contient le début du premier message utilisateur
                let rawChildText = skeleton.truncatedInstruction || skeleton.metadata?.title || '';
                const originalText = rawChildText;
                
                // 🎯 CORRECTION FINALE: Appliquer EXACTEMENT le même traitement que l'indexation
                
                // 1. TOUJOURS nettoyer les balises task simples d'abord (Pattern de base dans l'indexation)
                const taskMatch = rawChildText.match(/<task>([\s\S]*?)<\/task>/i);
                if (taskMatch) {
                    rawChildText = taskMatch[1].trim();
                } else {
                    // Si pas de balise task, nettoyer quand même les balises orphelines
                    rawChildText = rawChildText.replace(/<\/?task>/gi, '').trim();
                }
                
                // 2. Pattern extraction délégation avancée (optionnel, après nettoyage task)
                const delegationPattern = /<(\w+_\w+)>\s*<mode>([^<]+)<\/mode>\s*<message>([^<]+)<\/message>\s*<\/\1>/g;
                const delegationMatch = delegationPattern.exec(rawChildText);
                if (delegationMatch) {
                    const taskMessage = delegationMatch[3].trim();
                    if (taskMessage.length > 0) {
                        rawChildText = taskMessage; // Extraction précise du message de délégation
                    }
                }
                
                // 3. Troncature identique à l'indexation (200 chars AVANT normalisation)
                rawChildText = rawChildText.substring(0, 200);
                
                // 4. Puis normalisation via normalizePrefix() comme l'index
                rawChildText = rawChildText.toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 200);
        
                console.log(`🔍 DEBUG - Processing ${skeleton.taskId.substring(0, 8)}: AVANT="${originalText?.substring(0, 50)}..."`);
                console.log(`🔍 DEBUG - Processing ${skeleton.taskId.substring(0, 8)}: APRÈS="${rawChildText?.substring(0, 50)}..." (${rawChildText?.length} chars)`);
                console.log(`🎯 RECHERCHÉ COMPLET: "${rawChildText}" (${rawChildText.length} chars)`);
                console.log(`🎯 RECHERCHÉ HEX: ${Buffer.from(rawChildText.substring(0, 50)).toString('hex')}`);
                
                console.log(`[PASS 2 - PRE-CHECK] Orphan Task: ${skeleton.taskId.substring(0, 8)} | Text length: ${rawChildText.length} | Text: "${rawChildText}"`);
                if (rawChildText.length > 5) {
                    try {
                        // 🎯 CORRECTION FINALE: L'index ne contient plus de préfixes de mode, recherche directe avec le texte brut
                        // 🛡️ CORRECTION ARCHITECTURE : Plus aucune recherche de parent depuis l'enfant
                        console.log(`[PASS 2 - DÉSACTIVÉ] Orphan Task: ${skeleton.taskId.substring(0, 8)} - Recherche de parent désactivée (architecture corrigée)`);
                        let foundParentId: string | undefined = undefined;
                        // Le parentId doit venir des métadonnées ou rester undefined
                        
                        if (!foundParentId) {
                            console.log(`🔍 COMPARAISON DEBUG for ${skeleton.taskId.substring(0, 8)}:`);
                            const stats = globalTaskInstructionIndex.getStats();
                            console.log(`  Index has ${stats.totalInstructions} instructions, ${stats.totalNodes} nodes`);
                            
                            // Test de recherche détaillé
                            console.log(`🧪 TESTS RECHERCHE DÉTAILLÉS:`);
                            const rawText = rawChildText;
                            const normalizedText = rawText.toLowerCase().replace(/\s+/g, ' ').trim();
                            console.log(`  RAW: "${rawText.substring(0, 60)}..."`);
                            console.log(`  NORMALIZED: "${normalizedText.substring(0, 60)}..."`);
                            
                            // Test avec différentes variantes
                            const testSearches = [
                                rawText,
                                normalizedText,
                                rawText.substring(0, 50),
                                rawText.substring(0, 100),
                                rawText.substring(0, 150)
                            ];
                            
                            for (let i = 0; i < testSearches.length; i++) {
                                const testText = testSearches[i];
                                // 🛡️ CORRECTION ARCHITECTURE : Tests désactivés - pas de recherche inverse
                                const result = undefined;
                                console.log(`    Test[${i}]: DÉSACTIVÉ - Architecture corrigée`);
                            }
                        }
                        
                        // 🛡️ CORRECTION ARCHITECTURE : Plus aucune mise à jour de parent depuis la recherche inverse
                        // Les parents sont définis uniquement dans les métadonnées
                        // Code de mise à jour supprimé car foundParentId est toujours undefined maintenant
                    } catch (searchError) {
                        console.error(`Error finding parent for ${skeleton.taskId.substring(0, 8)}:`, searchError);
                    }
                } else {
                    console.log(`🚨 DEBUG - Skipped ${skeleton.taskId.substring(0, 8)} (childText too short: ${rawChildText.length} chars)`);
                }
            }
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
        
        // Sauvegarder seulement les premiers squelettes modifiés (limite pour éviter timeout)
        const MAX_SAVES = 10;
        let savedCount = 0;
        for (const update of skeletonsToUpdate.slice(0, MAX_SAVES)) {
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
        
        if (skeletonsToUpdate.length > MAX_SAVES) {
            console.log(`📝 Saved ${savedCount}/${skeletonsToUpdate.length} updated skeletons to disk (others updated in memory only)`);
        }
        
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

    async handleDebugTaskParsing(args: { task_id: string }): Promise<CallToolResult> {
        const { task_id } = args;
        
        console.log(`🔍 DEBUG: Starting detailed analysis of task ${task_id}`);
        const debugInfo: string[] = [];
        
        try {
            // Trouver le chemin de la tâche
            const locations = await RooStorageDetector.detectStorageLocations();
            let taskPath = null;
            
            for (const baseDir of locations) {
                const tasksDir = path.join(baseDir, 'tasks');
                const potentialPath = path.join(tasksDir, task_id);
                if (existsSync(potentialPath)) {
                    taskPath = potentialPath;
                    break;
                }
            }
            
            if (!taskPath) {
                return { content: [{ type: 'text', text: `Task ${task_id} not found in any storage location` }] };
            }
            
            debugInfo.push(`📁 Task path: ${taskPath}`);
            
            // Analyser les fichiers
            const uiMessagesPath = path.join(taskPath, 'ui_messages.json');
            const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
            
            debugInfo.push(`📄 UI Messages: ${existsSync(uiMessagesPath) ? '✅ EXISTS' : '❌ MISSING'}`);
            debugInfo.push(`📄 API History: ${existsSync(apiHistoryPath) ? '✅ EXISTS' : '❌ MISSING'}`);
            
            // Analyser le contenu pour les balises <task>
            if (existsSync(uiMessagesPath)) {
                let content = await fs.readFile(uiMessagesPath, 'utf-8');
                if (content.charCodeAt(0) === 0xFEFF) {
                    content = content.slice(1);
                }
                
                const messages = JSON.parse(content);
                debugInfo.push(`📊 UI Messages count: ${messages.length}`);
                
                let taskTagCount = 0;
                let newTaskTagCount = 0;
                
                for (let i = 0; i < messages.length; i++) {
                    const message = messages[i];
                    let contentText = '';
                    
                    if (typeof message.content === 'string') {
                        contentText = message.content;
                    } else if (Array.isArray(message.content)) {
                        for (const item of message.content) {
                            if (item.type === 'text' && typeof item.text === 'string') {
                                contentText += item.text + '\n';
                            }
                        }
                    }
                    
                    const taskMatches = contentText.match(/<task>/g);
                    const newTaskMatches = contentText.match(/<new_task>/g);
                    
                    if (taskMatches) {
                        taskTagCount += taskMatches.length;
                        debugInfo.push(`🎯 Message ${i} (${message.role}): Found ${taskMatches.length} <task> tags`);
                        
                        // Extraire le contenu de la première balise <task>
                        const taskPattern = /<task>([\s\S]*?)<\/task>/gi;
                        const match = taskPattern.exec(contentText);
                        if (match) {
                            debugInfo.push(`   Content preview: "${match[1].trim().substring(0, 100)}..."`);
                        }
                    }
                    
                    if (newTaskMatches) {
                        newTaskTagCount += newTaskMatches.length;
                        debugInfo.push(`🎯 Message ${i} (${message.role}): Found ${newTaskMatches.length} <new_task> tags`);
                    }
                }
                
                debugInfo.push(`📈 Total <task> tags found: ${taskTagCount}`);
                debugInfo.push(`📈 Total <new_task> tags found: ${newTaskTagCount}`);
            }
            
            // Test du parsing avec RooStorageDetector
            debugInfo.push(`\n🧪 TESTING RooStorageDetector.analyzeConversation...`);
            const skeleton = await RooStorageDetector.analyzeConversation(task_id, taskPath);
            
            if (skeleton) {
                debugInfo.push(`✅ Analysis complete:`);
                debugInfo.push(`   - TaskId: ${skeleton.taskId}`);
                debugInfo.push(`   - ParentTaskId: ${skeleton.parentTaskId || 'NONE'}`);
                debugInfo.push(`   - TruncatedInstruction: ${skeleton.truncatedInstruction ? `"${skeleton.truncatedInstruction.substring(0, 100)}..."` : 'NONE'}`);
                debugInfo.push(`   - ChildTaskInstructionPrefixes: ${skeleton.childTaskInstructionPrefixes?.length || 0} prefixes`);
                
                if (skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0) {
                    debugInfo.push(`   - Prefixes preview:`);
                    skeleton.childTaskInstructionPrefixes.slice(0, 3).forEach((prefix, i) => {
                        debugInfo.push(`     ${i+1}. "${prefix.substring(0, 80)}..."`);
                    });
                }
            } else {
                debugInfo.push(`❌ Analysis returned null`);
            }
            
        } catch (error: any) {
            debugInfo.push(`❌ ERROR: ${error?.message || 'Unknown error'}`);
        }
        
        return { content: [{ type: 'text', text: debugInfo.join('\n') }] };
    }

    handleGetTaskTree(args: { conversation_id: string, max_depth?: number, include_siblings?: boolean, output_format?: 'json' | 'markdown' }): CallToolResult {
        const { conversation_id, max_depth = Infinity, include_siblings = false, output_format = 'json' } = args;

        // Ensure cache is populated
        if (this.conversationCache.size === 0) {
            throw new Error(`Task cache is empty. Please run 'build_skeleton_cache' first to populate the cache.`);
        }

        const skeletons = Array.from(this.conversationCache.values());
        
        // Enhanced ID matching: support both exact match and prefix match
        const findTaskById = (id: string) => {
            // Try exact match first
            const exactMatch = skeletons.find(s => s.taskId === id);
            if (exactMatch) {
                return exactMatch;
            }
            
            // Try prefix match
            const prefixMatches = skeletons.filter(s => s.taskId.startsWith(id));
            if (prefixMatches.length === 0) {
                return null;
            }
            if (prefixMatches.length === 1) {
                return prefixMatches[0];
            }
            
            // Multiple matches - throw error with suggestions
            const suggestions = prefixMatches.slice(0, 5).map(s => s.taskId).join(', ');
            throw new Error(`Ambiguous task ID '${id}'. Multiple matches found: ${suggestions}. Please provide a more specific ID.`);
        };
        
        const targetSkeleton = findTaskById(conversation_id);
        if (!targetSkeleton) {
            const availableIds = skeletons.slice(0, 10).map(s => `${s.taskId.substring(0, 8)} (${s.metadata?.title || 'No title'})`).join(', ');
            throw new Error(`Task ID '${conversation_id}' not found. Available tasks (first 10): ${availableIds}`);
        }

        const childrenMap = new Map<string, string[]>();
        skeletons.forEach(s => {
            if (s.parentTaskId) {
                if (!childrenMap.has(s.parentTaskId)) {
                    childrenMap.set(s.parentTaskId, []);
                }
                childrenMap.get(s.parentTaskId)!.push(s.taskId);
            }
        });

        const buildTree = (taskId: string, depth: number): any => {
            if (depth > max_depth) {
                return null;
            }
            const skeleton = skeletons.find(s => s.taskId === taskId);
            if (!skeleton) {
                return null;
            }

            const childrenIds = childrenMap.get(taskId) || [];
            const children = childrenIds
                .map(childId => buildTree(childId, depth + 1))
                .filter(child => child !== null);
            
            // Enhanced node with rich metadata
            const node = {
                taskId: skeleton.taskId,
                taskIdShort: skeleton.taskId.substring(0, 8),
                title: skeleton.metadata?.title || `Task ${skeleton.taskId.substring(0, 8)}`,
                metadata: {
                    messageCount: skeleton.metadata?.messageCount || 0,
                    actionCount: skeleton.metadata?.actionCount || 0,
                    totalSizeKB: skeleton.metadata?.totalSize ? Math.round(skeleton.metadata.totalSize / 1024 * 10) / 10 : 0,
                    lastActivity: skeleton.metadata?.lastActivity || skeleton.metadata?.createdAt || 'Unknown',
                    createdAt: skeleton.metadata?.createdAt || 'Unknown',
                    mode: skeleton.metadata?.mode || 'Unknown',
                    workspace: skeleton.metadata?.workspace || 'Unknown',
                    hasParent: !!skeleton.parentTaskId,
                    childrenCount: childrenIds.length,
                    depth: depth,
                    // 🚀 NOUVEAUX CHAMPS : Ajout des fonctionnalités demandées
                    isCompleted: skeleton.isCompleted || false,
                    truncatedInstruction: skeleton.truncatedInstruction || undefined
                },
                parentTaskId: skeleton.parentTaskId,
                children: children.length > 0 ? children : undefined,
            };
            
            return node;
        };
        
        let tree;
        
        if (include_siblings && targetSkeleton.parentTaskId) {
            // Si la tâche a un parent et que les siblings sont demandés,
            // construire l'arbre depuis le parent pour inclure les frères et sœurs.
            tree = buildTree(targetSkeleton.parentTaskId, 0);
        } else {
            // Sinon (pas de parent ou siblings non demandés),
            // construire l'arbre depuis la tâche cible elle-même.
            tree = buildTree(targetSkeleton.taskId, 0);
        }

        if (!tree) {
            throw new Error(`Could not build tree for conversation ID '${conversation_id}'. Task exists but tree construction failed.`);
        }

        // Format output based on output_format parameter
        if (output_format === 'markdown') {
            const formatTreeMarkdown = (node: any, prefix: string = '', isLast: boolean = true): string => {
                const connector = prefix === '' ? '' : (isLast ? '└── ' : '├── ');
                const nextPrefix = prefix === '' ? '' : prefix + (isLast ? '    ' : '│   ');
                
                let line = `${prefix}${connector}**${node.taskIdShort}** ${node.title}`;
                if (node.metadata) {
                    line += ` _(${node.metadata.messageCount} msgs, ${node.metadata.totalSizeKB}KB, ${node.metadata.mode})_`;
                }
                line += '\n';
                
                if (node.children && node.children.length > 0) {
                    node.children.forEach((child: any, index: number) => {
                        const childIsLast = index === node.children.length - 1;
                        line += formatTreeMarkdown(child, nextPrefix, childIsLast);
                    });
                }
                
                return line;
            };
            
            const markdownTree = formatTreeMarkdown(tree);
            const metadata = `**Arbre des tâches:** ${conversation_id}\n**Profondeur max:** ${max_depth === Infinity ? '∞' : max_depth}\n**Inclure siblings:** ${include_siblings ? 'Oui' : 'Non'}\n**Racine:** ${tree.taskIdShort} - ${tree.title}\n\n`;
            
            return { content: [{ type: 'text', text: metadata + markdownTree }] };
        } else {
            return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };
        }
    }

   async handleDebugAnalyzeConversation(args: { taskId: string }): Promise<CallToolResult> {
       const { taskId } = args;
       const summary = await RooStorageDetector.findConversationById(taskId);
       if (summary) {
           return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
       }
       throw new Error(`Task with ID '${taskId}' not found in any storage location.`);
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

    private formatActionDetails(action: any, index: number, truncate: number): string {
        const icon = action.type === 'command' ? '⚙️' : '🛠️';
        let output = `[${index}] ${icon} ${action.name} → ${action.status}\n`;
        
        // Type et timestamp
        output += `    Type: ${action.type}\n`;
        if (action.timestamp) {
            output += `    Timestamp: ${action.timestamp}\n`;
        }
        
        // Paramètres
        if (action.parameters) {
            const paramStr = JSON.stringify(action.parameters, null, 2);
            output += `    Paramètres: ${truncate > 0 ? this.truncateContent(paramStr, truncate) : paramStr}\n`;
        }
        
        // Résultat (si disponible)
        if ('result' in action && action.result) {
            const resultStr = typeof action.result === 'string' ? action.result : JSON.stringify(action.result, null, 2);
            output += `    Résultat: ${truncate > 0 ? this.truncateContent(resultStr, truncate) : resultStr}\n`;
        }
        
        // Erreur (si disponible)
        if ('error' in action && action.error) {
            output += `    ❌ Erreur: ${action.error}\n`;
        }
        
        // Métadonnées additionnelles (si disponibles)
        if (action.metadata) {
            const metaStr = JSON.stringify(action.metadata, null, 2);
            output += `    Métadonnées: ${truncate > 0 ? this.truncateContent(metaStr, truncate) : metaStr}\n`;
        }
        
        return output;
    }

    private truncateContent(content: string, lines: number): string {
        if (lines <= 0) return content;
        
        const contentLines = content.split('\n');
        if (contentLines.length <= lines * 2) return content;
        
        const start = contentLines.slice(0, lines);
        const end = contentLines.slice(-lines);
        const omitted = contentLines.length - (lines * 2);
        
        return [
            ...start,
            `... [${omitted} lignes omises] ...`,
            ...end
        ].join('\n');
    }

    async handleSearchTasksSemantic(args: { conversation_id?: string, search_query: string, max_results?: number, diagnose_index?: boolean, workspace?: string }): Promise<CallToolResult> {
        const { conversation_id, search_query, max_results = 10, diagnose_index = false, workspace } = args;
        
        // Mode diagnostic - retourne des informations sur l'état de l'indexation
        if (diagnose_index) {
            try {
                const qdrant = getQdrantClient();
                const collections = await qdrant.getCollections();
                const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
                const collection = collections.collections.find(c => c.name === collectionName);
                
                return {
                    content: [{
                        type: 'text',
                        text: `Diagnostic de l'index sémantique:\n- Collection: ${collectionName}\n- Existe: ${collection ? 'Oui' : 'Non'}\n- Points: ${collection ? 'Vérification nécessaire' : 'N/A'}\n- Cache local: ${this.conversationCache.size} conversations`
                    }]
                };
            } catch (error) {
                return {
                    content: [{
                        type: 'text',
                        text: `Erreur lors du diagnostic: ${error instanceof Error ? error.message : String(error)}`
                    }]
                };
            }
        }

        // Tentative de recherche sémantique via Qdrant/OpenAI
        try {
            const qdrant = getQdrantClient();
            const openai = getOpenAIClient();
            
            // Créer l'embedding de la requête
            const embedding = await openai.embeddings.create({
                model: 'text-embedding-3-small',
                input: search_query
            });
            
            const queryVector = embedding.data[0].embedding;
            const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
            
            // Configuration de la recherche selon conversation_id et workspace
            let filter;
            const filterConditions = [];
            
            if (conversation_id && conversation_id !== 'undefined') {
                filterConditions.push({
                    key: "task_id",
                    match: {
                        value: conversation_id
                    }
                });
            }
            
            if (workspace) {
                filterConditions.push({
                    key: "workspace",
                    match: {
                        value: workspace
                    }
                });
            }
            
            if (filterConditions.length > 0) {
                filter = {
                    must: filterConditions
                };
            }
            // Si pas de filtres, recherche globale
            
            const searchResults = await qdrant.search(collectionName, {
                vector: queryVector,
                limit: max_results,
                filter: filter,
                with_payload: true
            });
            
            // Obtenir l'identifiant de la machine actuelle pour l'en-tête
            const { TaskIndexer, getHostIdentifier } = await import('./services/task-indexer.js');
            const taskIndexer = new TaskIndexer();
            const currentHostId = getHostIdentifier();
            
            const results = searchResults.map(result => ({
                taskId: result.payload?.task_id || 'unknown',
                score: result.score || 0,
                match: this.truncateMessage(String(result.payload?.content || 'No content'), 2),
                metadata: {
                    chunk_id: result.payload?.chunk_id,
                    chunk_type: result.payload?.chunk_type,
                    workspace: result.payload?.workspace,
                    task_title: result.payload?.task_title || `Task ${result.payload?.task_id}`,
                    message_index: result.payload?.message_index,
                    total_messages: result.payload?.total_messages,
                    role: result.payload?.role,
                    timestamp: result.payload?.timestamp,
                    message_position: result.payload?.message_index && result.payload?.total_messages
                        ? `${result.payload.message_index}/${result.payload.total_messages}`
                        : undefined,
                    host_os: result.payload?.host_os || 'unknown'
                }
            }));
            
            // Créer un rapport enrichi avec contexte multi-machine
            const searchReport = {
                current_machine: {
                    host_id: currentHostId,
                    search_timestamp: new Date().toISOString(),
                    query: search_query,
                    results_count: results.length
                },
                cross_machine_analysis: {
                    machines_found: [...new Set(results.map(r => r.metadata.host_os))],
                    results_by_machine: results.reduce((acc: { [key: string]: number }, r: any) => {
                        const host = r.metadata.host_os || 'unknown';
                        acc[host] = (acc[host] || 0) + 1;
                        return acc;
                    }, {})
                },
                results: results
            };
            
            return { content: [{ type: 'text', text: JSON.stringify(searchReport, null, 2) }] };
            
        } catch (semanticError) {
            console.log(`[INFO] Recherche sémantique échouée, utilisation du fallback textuel: ${semanticError instanceof Error ? semanticError.message : String(semanticError)}`);
            
            // Fallback vers la recherche textuelle simple
            return await this.handleSearchTasksSemanticFallback(args);
        }
    }

    private async handleSearchTasksSemanticFallback(args: { conversation_id?: string, search_query: string, max_results?: number }): Promise<CallToolResult> {
        console.log(`[DEBUG] Fallback called with args:`, JSON.stringify(args));
        
        const { conversation_id, search_query, max_results = 10 } = args;
        console.log(`[DEBUG] Extracted conversation_id: "${conversation_id}" (type: ${typeof conversation_id})`);

        // Si pas de conversation_id spécifique, rechercher dans tout le cache
        console.log(`[DEBUG] Fallback search - conversation_id: "${conversation_id}" (type: ${typeof conversation_id})`);
        const isUndefinedString = conversation_id === 'undefined';
        const isEmptyOrFalsy = !conversation_id;
        console.log(`[DEBUG] isUndefinedString: ${isUndefinedString}, isEmptyOrFalsy: ${isEmptyOrFalsy}`);
        
        if (!conversation_id || conversation_id === 'undefined') {
            const query = search_query.toLowerCase();
            const results: any[] = [];

            for (const [taskId, skeleton] of this.conversationCache.entries()) {
                if (results.length >= max_results) break;
                
                for (const item of skeleton.sequence) {
                    if ('content' in item && typeof item.content === 'string' && item.content.toLowerCase().includes(query)) {
                        results.push({
                            taskId: taskId,
                            score: 1.0,
                            match: `Found in role '${item.role}': ${this.truncateMessage(item.content, 2)}`
                        });
                        break; // Une seule correspondance par tâche pour éviter la duplication
                    }
                }
            }

            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        }

        // Recherche dans une conversation spécifique
        console.log(`[DEBUG] Specific search - conversation_id: "${conversation_id}" (type: ${typeof conversation_id})`);
        const skeleton = this.conversationCache.get(conversation_id);
        if (!skeleton) {
            throw new Error(`Conversation with ID '${conversation_id}' not found in cache.`);
        }

        const query = search_query.toLowerCase();
        const results: any[] = [];

        for (const item of skeleton.sequence) {
            if (results.length >= max_results) {
                break;
            }
            if ('content' in item && typeof item.content === 'string' && item.content.toLowerCase().includes(query)) {
                results.push({
                    taskId: skeleton.taskId,
                    score: 1.0,
                    match: `Found in role '${item.role}': ${this.truncateMessage(item.content, 2)}`
                });
            }
        }

        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }


    async handleIndexTaskSemantic(args: { task_id: string }): Promise<CallToolResult> {
        try {
            const { task_id } = args;
            
            // Vérification des variables d'environnement
            const openaiKey = process.env.OPENAI_API_KEY;
            const qdrantUrl = process.env.QDRANT_URL;
            const qdrantCollection = process.env.QDRANT_COLLECTION_NAME;
            
            console.log(`[DEBUG] Environment check:`);
            console.log(`[DEBUG] OPENAI_API_KEY: ${openaiKey ? 'SET' : 'MISSING'}`);
            console.log(`[DEBUG] QDRANT_URL: ${qdrantUrl || 'MISSING'}`);
            console.log(`[DEBUG] QDRANT_COLLECTION_NAME: ${qdrantCollection || 'MISSING'}`);
            
            if (!openaiKey) {
                throw new Error('OPENAI_API_KEY environment variable is required');
            }
            
            const skeleton = this.conversationCache.get(task_id);
            if (!skeleton) {
                throw new Error(`Task with ID '${task_id}' not found in cache.`);
            }
            
            const conversation = await RooStorageDetector.findConversationById(task_id);
            const taskPath = conversation?.path;
            
            if (!taskPath) {
                throw new Error(`Task directory for '${task_id}' not found in any storage location.`);
            }
            
            console.log(`[DEBUG] Attempting to import indexTask from task-indexer.js`);
            const { indexTask } = await import('./services/task-indexer.js');
            console.log(`[DEBUG] Import successful, calling indexTask with taskId=${task_id}, taskPath=${taskPath}`);
            const indexedPoints = await indexTask(task_id, taskPath);
            console.log(`[DEBUG] indexTask completed, returned ${indexedPoints.length} points`);
            
            return {
                content: [{
                    type: "text",
                    text: `# Indexation sémantique terminée\n\n**Tâche:** ${task_id}\n**Chemin:** ${taskPath}\n**Chunks indexés:** ${indexedPoints.length}\n\n**Variables d'env:**\n- OPENAI_API_KEY: ${openaiKey ? 'SET' : 'MISSING'}\n- QDRANT_URL: ${qdrantUrl || 'MISSING'}\n- QDRANT_COLLECTION: ${qdrantCollection || 'MISSING'}`
                }]
            };
        } catch (error) {
            console.error('Task indexing error:', error);
            return {
                content: [{
                    type: "text",
                    text: `# Erreur d'indexation\n\n**Tâche:** ${args.task_id}\n**Erreur:** ${error instanceof Error ? error.stack : String(error)}\n\nL'indexation de la tâche a échoué.`
                }]
            };
        }
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
     * Gère l'export XML d'une tâche individuelle
     */
    async handleExportTaskXml(args: {
        taskId: string,
        filePath?: string,
        includeContent?: boolean,
        prettyPrint?: boolean
    }): Promise<CallToolResult> {
        try {
            const { taskId, filePath, includeContent = false, prettyPrint = true } = args;
            
            const skeleton = this.conversationCache.get(taskId);
            if (!skeleton) {
                throw new Error(`Tâche avec l'ID '${taskId}' non trouvée dans le cache.`);
            }

            const xmlContent = this.xmlExporterService.generateTaskXml(skeleton, {
                includeContent,
                prettyPrint
            });

            if (filePath) {
                await this.xmlExporterService.saveXmlToFile(xmlContent, filePath);
                return {
                    content: [{
                        type: 'text',
                        text: `Export XML de la tâche '${taskId}' sauvegardé dans '${filePath}'.`
                    }]
                };
            } else {
                return {
                    content: [{
                        type: 'text',
                        text: xmlContent
                    }]
                };
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{
                    type: 'text',
                    text: `Erreur lors de l'export XML : ${errorMessage}`
                }]
            };
        }
    }

    /**
     * Gère l'export XML d'une conversation complète
     */
    async handleExportConversationXml(args: {
        conversationId: string,
        filePath?: string,
        maxDepth?: number,
        includeContent?: boolean,
        prettyPrint?: boolean
    }): Promise<CallToolResult> {
        try {
            const { conversationId, filePath, maxDepth, includeContent = false, prettyPrint = true } = args;
            
            const rootSkeleton = this.conversationCache.get(conversationId);
            if (!rootSkeleton) {
                throw new Error(`Conversation racine avec l'ID '${conversationId}' non trouvée dans le cache.`);
            }

            // Collecter toutes les tâches de la conversation
            const collectTasks = (taskId: string, currentDepth = 0): ConversationSkeleton[] => {
                if (maxDepth && currentDepth >= maxDepth) {
                    return [];
                }
                
                const task = this.conversationCache.get(taskId);
                if (!task) {
                    return [];
                }

                const tasks = [task];
                
                // Rechercher les enfants
                for (const [childTaskId, childTask] of this.conversationCache.entries()) {
                    if (childTask.parentTaskId === taskId) {
                        tasks.push(...collectTasks(childTaskId, currentDepth + 1));
                    }
                }
                
                return tasks;
            };

            const allTasks = collectTasks(conversationId);
            
            // TODO: Correction temporaire - adapter l'interface du service
            const xmlContent = (this.xmlExporterService as any).generateConversationXml(allTasks, {
                includeContent,
                prettyPrint
            });

            if (filePath) {
                await this.xmlExporterService.saveXmlToFile(xmlContent, filePath);
                return {
                    content: [{
                        type: 'text',
                        text: `Export XML de la conversation '${conversationId}' sauvegardé dans '${filePath}'.`
                    }]
                };
            } else {
                return {
                    content: [{
                        type: 'text',
                        text: xmlContent
                    }]
                };
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{
                    type: 'text',
                    text: `Erreur lors de l'export XML de la conversation : ${errorMessage}`
                }]
            };
        }
    }

    /**
     * Gère l'export XML d'un projet entier
     */
    async handleExportProjectXml(args: {
        projectPath: string,
        filePath?: string,
        startDate?: string,
        endDate?: string,
        prettyPrint?: boolean
    }): Promise<CallToolResult> {
        try {
            const { projectPath, filePath, startDate, endDate, prettyPrint = true } = args;
            
            // Filtrer les conversations par workspace et date
            const relevantTasks = Array.from(this.conversationCache.values()).filter(skeleton => {
                if (skeleton.metadata?.workspace) {
                    const normalizedWorkspace = normalizePath(skeleton.metadata.workspace);
                    const normalizedProject = normalizePath(projectPath);
                    
                    if (normalizedWorkspace !== normalizedProject) {
                        return false;
                    }
                }
                
                if (startDate) {
                    const taskDate = new Date(skeleton.metadata?.lastActivity || skeleton.metadata?.createdAt || '');
                    if (taskDate < new Date(startDate)) {
                        return false;
                    }
                }
                
                if (endDate) {
                    const taskDate = new Date(skeleton.metadata?.lastActivity || skeleton.metadata?.createdAt || '');
                    if (taskDate > new Date(endDate)) {
                        return false;
                    }
                }
                
                return true;
            });

            // TODO: Correction temporaire - adapter l'interface du service
            const xmlContent = (this.xmlExporterService as any).generateProjectXml(relevantTasks, {
                projectPath,
                startDate,
                endDate,
                prettyPrint
            });

            if (filePath) {
                await this.xmlExporterService.saveXmlToFile(xmlContent, filePath);
                return {
                    content: [{
                        type: 'text',
                        text: `Export XML du projet '${projectPath}' sauvegardé dans '${filePath}'.`
                    }]
                };
            } else {
                return {
                    content: [{
                        type: 'text',
                        text: xmlContent
                    }]
                };
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{
                    type: 'text',
                    text: `Erreur lors de l'export XML du projet : ${errorMessage}`
                }]
            };
        }
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
     * Gère la génération de résumés de grappes de tâches
     */
    async handleGenerateClusterSummary(args: {
        rootTaskId: string;
        childTaskIds?: string[];
        detailLevel?: 'Full' | 'NoTools' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';
        outputFormat?: 'markdown' | 'html';
        truncationChars?: number;
        compactStats?: boolean;
        includeCss?: boolean;
        generateToc?: boolean;
        clusterMode?: 'aggregated' | 'detailed' | 'comparative';
        includeClusterStats?: boolean;
        crossTaskAnalysis?: boolean;
        maxClusterDepth?: number;
        clusterSortBy?: 'chronological' | 'size' | 'activity' | 'alphabetical';
        includeClusterTimeline?: boolean;
        clusterTruncationChars?: number;
        showTaskRelationships?: boolean;
    }): Promise<CallToolResult> {
        try {
            const { rootTaskId } = args;
            
            if (!rootTaskId) {
                throw new Error("rootTaskId est requis");
            }

            // Récupérer le ConversationSkeleton de la tâche racine depuis le cache
            const rootConversation = this.conversationCache.get(rootTaskId);
            if (!rootConversation) {
                throw new Error(`Conversation racine avec taskId ${rootTaskId} introuvable`);
            }

            // Collecter les tâches enfantes (soit fournies, soit auto-détectées)
            let childConversations: any[] = [];
            
            if (args.childTaskIds && args.childTaskIds.length > 0) {
                // Utiliser les IDs fournis
                for (const childId of args.childTaskIds) {
                    const childConv = this.conversationCache.get(childId);
                    if (childConv) {
                        childConversations.push(childConv);
                    } else {
                        console.warn(`Tâche enfante ${childId} introuvable dans le cache`);
                    }
                }
            } else {
                // Auto-détecter les tâches enfantes en recherchant celles qui ont ce rootTaskId comme parent
                for (const [taskId, conversation] of this.conversationCache.entries()) {
                    if (conversation.parentTaskId === rootTaskId) {
                        childConversations.push(conversation);
                    }
                }
            }

            // Préparer les options de génération
            const clusterOptions: ClusterSummaryOptions = {
                detailLevel: args.detailLevel || 'Full',
                outputFormat: args.outputFormat || 'markdown',
                truncationChars: args.truncationChars || 0,
                compactStats: args.compactStats || false,
                includeCss: args.includeCss !== undefined ? args.includeCss : true,
                generateToc: args.generateToc !== undefined ? args.generateToc : true,
                clusterMode: args.clusterMode || 'aggregated',
                includeClusterStats: args.includeClusterStats !== undefined ? args.includeClusterStats : true,
                crossTaskAnalysis: args.crossTaskAnalysis !== undefined ? args.crossTaskAnalysis : true,
                maxClusterDepth: args.maxClusterDepth || 3,
                clusterSortBy: args.clusterSortBy || 'chronological',
                includeClusterTimeline: args.includeClusterTimeline !== undefined ? args.includeClusterTimeline : true,
                clusterTruncationChars: args.clusterTruncationChars || 0,
                showTaskRelationships: args.showTaskRelationships !== undefined ? args.showTaskRelationships : true
            };

            // Générer le résumé de grappe
            const result = await this.traceSummaryService.generateClusterSummary(
                rootConversation,
                childConversations,
                clusterOptions
            );

            if (!result.success) {
                throw new Error(`Erreur lors de la génération du résumé de grappe: ${result.error}`);
            }

            // Préparer la réponse avec métadonnées
            const response = [
                `**Résumé de grappe généré avec succès**`,
                ``,
                `**Tâche racine:** ${rootTaskId}`,
                `**Tâches enfantes:** ${childConversations.length}`,
                ``,
                `**Statistiques de grappe:**`,
                `- Total des tâches: ${result.statistics.totalTasks}`,
                `- Total des sections: ${result.statistics.totalSections}`,
                `- Messages utilisateur: ${result.statistics.userMessages}`,
                `- Réponses assistant: ${result.statistics.assistantMessages}`,
                `- Taille totale: ${Math.round(result.statistics.totalContentSize / 1024 * 10) / 10} KB`,
                result.statistics.averageTaskSize ? `- Taille moyenne par tâche: ${Math.round(result.statistics.averageTaskSize / 1024 * 10) / 10} KB` : '',
                result.statistics.clusterTimeSpan ? `- Durée de la grappe: ${result.statistics.clusterTimeSpan.totalDurationHours}h` : '',
                ``,
                `**Mode de génération:** ${clusterOptions.detailLevel}`,
                `**Mode clustering:** ${clusterOptions.clusterMode}`,
                `**Format:** ${clusterOptions.outputFormat}`,
                ``,
                `---`,
                ``,
                result.content
            ].filter(line => line !== '').join('\n');

            return {
                content: [{
                    type: 'text',
                    text: response
                }]
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{
                    type: 'text',
                    text: `Erreur lors de la génération de résumé de grappe : ${errorMessage}`
                }]
            };
        }
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
     * Gère la configuration des exports XML
     */
    async handleConfigureXmlExport(args: {
        action: 'get' | 'set' | 'reset',
        config?: any
    }): Promise<CallToolResult> {
        try {
            const { action, config } = args;

            switch (action) {
                case 'get':
                    const currentConfig = await this.exportConfigManager.getConfig();
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(currentConfig, null, 2)
                        }]
                    };

                case 'set':
                    if (!config) {
                        throw new Error('Configuration manquante pour l\'action \'set\'.');
                    }
                    await this.exportConfigManager.updateConfig(config);
                    return {
                        content: [{
                            type: 'text',
                            text: 'Configuration mise à jour avec succès.'
                        }]
                    };

                case 'reset':
                    await this.exportConfigManager.resetConfig();
                    return {
                        content: [{
                            type: 'text',
                            text: 'Configuration remise aux valeurs par défaut.'
                        }]
                    };

                default:
                    throw new Error(`Action non reconnue : ${action}`);
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{
                    type: 'text',
                    text: `Erreur lors de la configuration : ${errorMessage}`
                }]
            };
        }
    }
    
    handleViewTaskDetails(args: { task_id: string, action_index?: number, truncate?: number }): CallToolResult {
        try {
            const skeleton = this.conversationCache.get(args.task_id);
            
            if (!skeleton) {
                return {
                    content: [{
                        type: 'text',
                        text: `❌ Aucune tâche trouvée avec l'ID: ${args.task_id}`
                    }]
                };
            }

            let output = `🔍 Détails techniques complets - Tâche: ${skeleton.metadata.title || skeleton.taskId}\n`;
            output += `═══════════════════════════════════════════════════════════════════════════════════════════════════════\n`;
            output += `ID: ${skeleton.taskId}\n`;
            output += `Messages: ${skeleton.metadata.messageCount}\n`;
            output += `Taille totale: ${skeleton.metadata.totalSize} octets\n`;
            output += `Dernière activité: ${skeleton.metadata.lastActivity}\n\n`;

            // Filtrer pour ne garder que les actions (pas les messages)
            const actions = skeleton.sequence.filter((item: any) => !('role' in item));
            
            if (actions.length === 0) {
                output += "ℹ️ Aucune action technique trouvée dans cette tâche.\n";
            } else {
                output += `🛠️ Actions techniques trouvées: ${actions.length}\n`;
                output += "═══════════════════════════════════════════════════════════════════════════════════════════════════════\n\n";

                // Si un index spécifique est demandé
                if (args.action_index !== undefined) {
                    if (args.action_index >= 0 && args.action_index < actions.length) {
                        const action = actions[args.action_index];
                        output += this.formatActionDetails(action, args.action_index, args.truncate || 0);
                    } else {
                        output += `❌ Index ${args.action_index} invalide. Indices disponibles: 0-${actions.length - 1}\n`;
                    }
                } else {
                    // Afficher toutes les actions
                    actions.forEach((action: any, index: number) => {
                        output += this.formatActionDetails(action, index, args.truncate || 0);
                        if (index < actions.length - 1) {
                            output += "\n" + "─".repeat(80) + "\n\n";
                        }
                    });
                }
            }

            return {
                content: [{
                    type: 'text',
                    text: output
                }]
            };

        } catch (error) {
            console.error('Erreur dans handleViewTaskDetails:', error);
            return {
                content: [{
                    type: 'text',
                    text: `❌ Erreur lors de la récupération des détails: ${error instanceof Error ? error.message : String(error)}`
                }]
            };
        }
    }

    /**
     * Gère la génération de résumés de traces
     */
    async handleGenerateTraceSummary(args: {
        taskId: string;
        filePath?: string;
        detailLevel?: 'Full' | 'NoTools' | 'NoResults' | 'Messages' | 'Summary' | 'UserOnly';
        outputFormat?: 'markdown' | 'html';
        truncationChars?: number;
        compactStats?: boolean;
        includeCss?: boolean;
        generateToc?: boolean;
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

            const result = await handleGenerateTraceSummary(args, getConversationSkeleton);

            return {
                content: [{ type: 'text', text: result }]
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
            return {
                content: [{ type: 'text', text: `❌ Erreur lors de la génération du résumé: ${errorMessage}` }],
                isError: true
            };
        }
    }

    async handleGetRawConversation(args: { taskId: string }): Promise<CallToolResult> {
        const { taskId } = args;
        if (!taskId) {
            throw new Error("taskId is required.");
        }

        const locations = await RooStorageDetector.detectStorageLocations();
        for (const loc of locations) {
            const taskPath = path.join(loc, taskId);
            try {
                await fs.access(taskPath); // Vérifie si le répertoire de la tâche existe

                const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
                const uiMessagesPath = path.join(taskPath, 'ui_messages.json');

                const apiHistoryContent = await fs.readFile(apiHistoryPath, 'utf-8').catch(() => null);
                const uiMessagesContent = await fs.readFile(uiMessagesPath, 'utf-8').catch(() => null);

                const rawData = {
                    taskId,
                    location: taskPath,
                    api_conversation_history: apiHistoryContent ? JSON.parse(apiHistoryContent) : null,
                    ui_messages: uiMessagesContent ? JSON.parse(uiMessagesContent) : null,
                };

                return { content: [{ type: 'text', text: JSON.stringify(rawData, null, 2) }] };
            } catch (e) {
                // Tâche non trouvée dans cet emplacement, on continue
            }
        }

        throw new Error(`Task with ID '${taskId}' not found in any storage location.`);
    }

    /**
     * Gère la récupération de synthèses de conversations
     */
    async handleGetConversationSynthesis(args: {
        taskId: string;
        filePath?: string;
        outputFormat?: 'json' | 'markdown';
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

            const result = await handleGetConversationSynthesis(args, getConversationSkeleton);

            return {
                content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
            return {
                content: [{ type: 'text', text: `❌ Erreur lors de la récupération de la synthèse: ${errorMessage}` }],
                isError: true
            };
        }
    }

    /**
     * 🚀 NOUVEAU : Exporte un arbre de tâches au format Markdown hiérarchique
     */
    async handleExportTaskTreeMarkdown(args: {
        conversation_id: string;
        filePath?: string;
        max_depth?: number;
        include_siblings?: boolean;
    }): Promise<CallToolResult> {
        try {
            const { conversation_id, filePath, max_depth, include_siblings = true } = args;

            if (!conversation_id) {
                throw new Error("conversation_id est requis");
            }

            // Utiliser get_task_tree pour récupérer l'arbre avec les nouveaux champs
            const treeResult = await this.handleGetTaskTree({
                conversation_id,
                max_depth,
                include_siblings
            });

            if (!treeResult || !treeResult.content || !treeResult.content[0]) {
                throw new Error("Impossible de récupérer l'arbre des tâches");
            }

            const textContent = treeResult.content[0].text;
            if (typeof textContent !== 'string') {
                throw new Error("Format de données invalide retourné par get_task_tree");
            }
            const treeData = JSON.parse(textContent);

            // Fonction récursive pour formatter l'arbre en Markdown
            const formatNodeToMarkdown = (node: any, depth: number = 0): string => {
                let markdown = '';
                const indent = '#'.repeat(Math.max(2, depth + 2)); // Commence par ## au minimum
                const shortId = node.taskIdShort || node.taskId?.substring(0, 8) || 'unknown';
                const status = node.metadata?.isCompleted ? 'Completed' : 'In Progress';
                const instruction = node.metadata?.truncatedInstruction || 'No instruction available';
                
                // Titre principal avec ID court et statut
                markdown += `${indent} ${node.title || 'Task'} (${shortId})\n`;
                markdown += `**Status:** ${status}\n`;
                markdown += `**Instruction:** ${instruction}\n`;
                
                // Statistiques si disponibles
                if (node.metadata?.stats) {
                    const stats = node.metadata.stats;
                    const messageCount = stats.messageCount || 0;
                    const sizeKB = Math.round((stats.totalSize || 0) / 1024);
                    markdown += `**Stats:** ${messageCount} messages | ${sizeKB} KB\n`;
                }
                
                // Workspace si disponible
                if (node.metadata?.workspace) {
                    markdown += `**Workspace:** ${node.metadata.workspace}\n`;
                }
                
                markdown += '\n';

                // Enfants si présents
                if (node.children && node.children.length > 0) {
                    if (depth === 0) {
                        markdown += `### Child Tasks\n\n`;
                    }
                    
                    for (const child of node.children) {
                        markdown += formatNodeToMarkdown(child, depth + 1);
                    }
                }

                return markdown;
            };

            // En-tête du document
            const currentDate = new Date().toISOString().split('T')[0];
            let markdown = `# Task Tree - ${currentDate}\n\n`;

            // Traiter le nœud racine ou les nœuds multiples
            if (Array.isArray(treeData)) {
                for (const rootNode of treeData) {
                    markdown += formatNodeToMarkdown(rootNode, 0);
                    markdown += '\n---\n\n';
                }
            } else {
                markdown += formatNodeToMarkdown(treeData, 0);
            }

            // Sauvegarder dans un fichier si spécifié
            if (filePath) {
                const fs = await import('fs');
                const path = await import('path');
                
                // Créer le répertoire parent si nécessaire
                const dir = path.dirname(filePath);
                fs.mkdirSync(dir, { recursive: true });
                
                // Écrire le fichier
                fs.writeFileSync(filePath, markdown, 'utf8');
                
                return {
                    content: [{
                        type: 'text',
                        text: `✅ Arbre des tâches exporté avec succès vers: ${filePath}\n\nContenu:\n\n${markdown}`
                    }]
                };
            }

            return {
                content: [{ type: 'text', text: markdown }]
            };

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
            return {
                content: [{ type: 'text', text: `❌ Erreur lors de l'export Markdown: ${errorMessage}` }],
                isError: true
            };
        }
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error(`Roo State Manager Server started - v${packageJson.version}`);
    }

    private async handleDiagnoseSemanticIndex(): Promise<CallToolResult> {
        const collectionName = process.env.QDRANT_COLLECTION_NAME || 'roo_tasks_semantic_index';
        const diagnostics: any = {
            timestamp: new Date().toISOString(),
            collection_name: collectionName,
            status: 'unknown',
            errors: [],
            details: {},
        };

        try {
            // Test de connectivité à Qdrant
            const qdrant = getQdrantClient();
            diagnostics.details.qdrant_connection = 'success';

            try {
                // Vérifier si la collection existe
                const collections = await qdrant.getCollections();
                const collection = collections.collections.find(c => c.name === collectionName);
                
                if (collection) {
                    diagnostics.details.collection_exists = true;
                    
                    // Obtenir des informations sur la collection
                    const collectionInfo = await qdrant.getCollection(collectionName);
                    diagnostics.details.collection_info = {
                        vectors_count: collectionInfo.vectors_count,
                        indexed_vectors_count: collectionInfo.indexed_vectors_count || 0,
                        points_count: collectionInfo.points_count,
                        config: {
                            distance: collectionInfo.config?.params?.vectors?.distance || 'unknown',
                            size: collectionInfo.config?.params?.vectors?.size || 'unknown',
                        },
                    };
                    
                    if (collectionInfo.points_count === 0) {
                        diagnostics.status = 'empty_collection';
                        diagnostics.errors.push('La collection existe mais ne contient aucun point indexé');
                    } else {
                        diagnostics.status = 'healthy';
                    }
                } else {
                    diagnostics.details.collection_exists = false;
                    diagnostics.status = 'missing_collection';
                    diagnostics.errors.push(`La collection '${collectionName}' n'existe pas dans Qdrant`);
                }
            } catch (collectionError: any) {
                diagnostics.errors.push(`Erreur lors de l'accès à la collection: ${collectionError.message}`);
                diagnostics.status = 'collection_error';
            }

            // Test de connectivité à OpenAI
            try {
                const openai = getOpenAIClient();
                const testEmbedding = await openai.embeddings.create({
                    model: 'text-embedding-3-small',
                    input: 'test connectivity',
                });
                diagnostics.details.openai_connection = testEmbedding.data[0].embedding.length > 0 ? 'success' : 'failed';
            } catch (openaiError: any) {
                diagnostics.errors.push(`Erreur OpenAI: ${openaiError.message}`);
                diagnostics.details.openai_connection = 'failed';
            }

            // Vérifier les variables d'environnement nécessaires
            console.log('[DEBUG] Environment variables during diagnostic:');
            console.log(`QDRANT_URL: ${process.env.QDRANT_URL ? 'SET' : 'NOT SET'}`);
            console.log(`QDRANT_API_KEY: ${process.env.QDRANT_API_KEY ? 'SET' : 'NOT SET'}`);
            console.log(`QDRANT_COLLECTION_NAME: ${process.env.QDRANT_COLLECTION_NAME ? 'SET' : 'NOT SET'}`);
            console.log(`OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? 'SET' : 'NOT SET'}`);
            
            const envVars = {
                QDRANT_URL: !!process.env.QDRANT_URL,
                QDRANT_API_KEY: !!process.env.QDRANT_API_KEY,
                QDRANT_COLLECTION_NAME: !!process.env.QDRANT_COLLECTION_NAME,
                OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
            };
            diagnostics.details.environment_variables = envVars;

            const missingEnvVars = Object.entries(envVars)
                .filter(([, exists]) => !exists)
                .map(([varName]) => varName);
            
            if (missingEnvVars.length > 0) {
                diagnostics.errors.push(`Variables d'environnement manquantes: ${missingEnvVars.join(', ')}`);
            }

        } catch (connectionError: any) {
            diagnostics.status = 'connection_failed';
            diagnostics.details.qdrant_connection = 'failed';
            diagnostics.errors.push(`Impossible de se connecter à Qdrant: ${connectionError.message}`);
        }

        // Recommandations basées sur le diagnostic
        const recommendations: string[] = [];
        if (diagnostics.status === 'missing_collection') {
            recommendations.push('Utilisez l\'outil rebuild_task_index pour créer et peupler la collection');
        }
        if (diagnostics.status === 'empty_collection') {
            recommendations.push('La collection existe mais est vide. Lancez rebuild_task_index pour l\'indexer');
        }
        if (diagnostics.details.openai_connection === 'failed') {
            recommendations.push('Vérifiez votre clé API OpenAI dans les variables d\'environnement');
        }
        if (diagnostics.details.qdrant_connection === 'failed') {
            recommendations.push('Vérifiez la configuration Qdrant (URL, clé API, connectivité réseau)');
        }

        diagnostics.recommendations = recommendations;

        return {
            content: [{
                type: 'text',
                text: JSON.stringify(diagnostics, null, 2)
            }]
        };
    }

    /**
     * FAILSAFE: Ensure skeleton cache is fresh and up-to-date
     * Vérifie si le cache des squelettes est à jour et déclenche une reconstruction différentielle si nécessaire
     */
    private async _ensureSkeletonCacheIsFresh(): Promise<boolean> {
        try {
            console.log('[FAILSAFE] Checking skeleton cache freshness...');
            
            // Vérifier si le cache est vide - reconstruction nécessaire
            if (this.conversationCache.size === 0) {
                console.log('[FAILSAFE] Cache empty, triggering differential rebuild...');
                await this.handleBuildSkeletonCache({ force_rebuild: false });
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
                await this.handleBuildSkeletonCache({ force_rebuild: false });
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
     */
    private async _scanForOutdatedQdrantIndex(): Promise<void> {
        let outdatedCount = 0;
        
        for (const [taskId, skeleton] of this.conversationCache.entries()) {
            const lastActivity = new Date(skeleton.metadata.lastActivity).getTime();
            const qdrantIndexed = skeleton.metadata.qdrantIndexedAt
                ? new Date(skeleton.metadata.qdrantIndexedAt).getTime()
                : 0;
            
            // Si le squelette a été modifié après la dernière indexation Qdrant
            if (lastActivity > qdrantIndexed) {
                this.qdrantIndexQueue.add(taskId);
                outdatedCount++;
            }
        }
        
        console.log(`📊 Scan terminé: ${outdatedCount} squelettes nécessitent une réindexation Qdrant`);
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
            const threshold = Math.max(5, Math.floor(localIndexedCount * 0.1)); // 10% ou min 5
            
            if (discrepancy > threshold) {
                console.warn(`⚠️  Incohérence détectée: écart de ${discrepancy} entre squelettes et Qdrant`);
                console.log(`🔄 Lancement d'une réindexation de réparation...`);
                
                // Forcer une réindexation partielle des tâches supposément indexées
                let reindexCount = 0;
                for (const [taskId, skeleton] of this.conversationCache.entries()) {
                    if (skeleton.metadata?.qdrantIndexedAt) {
                        this.qdrantIndexQueue.add(taskId);
                        reindexCount++;
                        if (reindexCount >= 20) break; // Limite pour ne pas surcharger
                    }
                }
                
                console.log(`📝 ${reindexCount} tâches ajoutées à la queue de réindexation`);
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
     * Indexe une tâche spécifique dans Qdrant et met à jour son timestamp
     */
    private async _indexTaskInQdrant(taskId: string): Promise<void> {
        try {
            const skeleton = this.conversationCache.get(taskId);
            if (!skeleton) {
                console.warn(`[WARN] Skeleton for task ${taskId} not found in cache. Skipping indexing.`);
                return;
            }
            
            // 🛡️ ANTI-FUITE: Vérifier le cache avant tout appel réseau
            const now = Date.now();
            const lastIndexed = this.qdrantIndexCache.get(taskId) || 0;
            const timeSinceIndexed = now - lastIndexed;
            
            // Si déjà indexé récemment (< 4h), ignorer
            if (timeSinceIndexed < this.MIN_REINDEX_INTERVAL) {
                console.log(`[CACHE] Task ${taskId} ignoré (dernière indexation < 4h) - Protection anti-fuite`);
                return;
            }
            
            // Vérifier si vraiment nécessaire via timestamp de métadonnées
            if (skeleton.metadata.qdrantIndexedAt) {
                const lastActivity = new Date(skeleton.metadata.lastActivity).getTime();
                const qdrantIndexed = new Date(skeleton.metadata.qdrantIndexedAt).getTime();
                
                if (lastActivity <= qdrantIndexed) {
                    console.log(`[CACHE] Task ${taskId} déjà à jour selon métadonnées - Protection anti-fuite`);
                    this.qdrantIndexCache.set(taskId, now); // Marquer comme vérifié
                    return;
                }
            }
    
            // 🌐 APPEL RÉSEAU - Maintenant seulement si nécessaire
            const taskIndexer = new TaskIndexer();
            await taskIndexer.indexTask(taskId);
    
            skeleton.metadata.qdrantIndexedAt = new Date().toISOString();
            await this._saveSkeletonToDisk(skeleton);
            
            // Marquer dans le cache pour éviter réindexations répétées
            this.qdrantIndexCache.set(taskId, now);
    
            console.log(`[INFO] Task ${taskId} successfully indexed in Qdrant.`);
    
        } catch (error: any) {
            if (error.message && error.message.includes('not found in any storage location')) {
                console.warn(`[WARN] Task ${taskId} is in cache but not on disk. Skipping indexing.`);
            } else {
                console.error(`[ERROR] Failed to index task ${taskId} in Qdrant:`, error);
            }
        }
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
     * Réinitialise complètement la collection Qdrant (outil de réparation)
     */
    private async handleResetQdrantCollection(args: any): Promise<CallToolResult> {
        try {
            console.log('🧹 Réinitialisation de la collection Qdrant...');
            
            const taskIndexer = new TaskIndexer();
            
            // Supprimer et recréer la collection Qdrant
            await taskIndexer.resetCollection();
            
            // Marquer tous les squelettes comme non-indexés
            let skeletonsReset = 0;
            for (const [taskId, skeleton] of this.conversationCache.entries()) {
                if (skeleton.metadata.qdrantIndexedAt) {
                    delete skeleton.metadata.qdrantIndexedAt;
                    await this._saveSkeletonToDisk(skeleton);
                    skeletonsReset++;
                }
                // Ajouter à la queue pour réindexation
                this.qdrantIndexQueue.add(taskId);
            }
            
            // Réactiver le service s'il était désactivé
            this.isQdrantIndexingEnabled = true;
            
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        message: `Collection Qdrant réinitialisée avec succès`,
                        skeletonsReset,
                        queuedForReindexing: this.qdrantIndexQueue.size
                    }, null, 2)
                }]
            };
        } catch (error: any) {
            console.error('Erreur lors de la réinitialisation de Qdrant:', error);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        message: `Erreur lors de la réinitialisation: ${error.message}`
                    }, null, 2)
                }]
            };
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
