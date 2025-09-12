import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';

// Obtenir le répertoire du fichier actuel
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger les variables d'environnement AVANT tout autre import
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RooStorageDetector } from './utils/roo-storage-detector.js';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { TaskNavigator } from './services/task-navigator.js';
import { ConversationSkeleton, ActionMetadata, ClusterSummaryOptions, ClusterSummaryResult } from './types/conversation.js';
import packageJson from '../package.json' with { type: 'json' };
import { readVscodeLogs, rebuildAndRestart, getMcpDevDocs, manageMcpSettings, analyzeVSCodeGlobalState, repairVSCodeTaskHistory, scanOrphanTasks, testWorkspaceExtraction, rebuildTaskIndex, diagnoseSQLite, examineRooGlobalStateTool, repairTaskHistoryTool, normalizeWorkspacePaths, generateTraceSummaryTool, handleGenerateTraceSummary, generateClusterSummaryTool, handleGenerateClusterSummary } from './tools/index.js';
import { searchTasks } from './services/task-searcher.js';
import { indexTask } from './services/task-indexer.js';
import { XmlExporterService } from './services/XmlExporterService.js';
import { ExportConfigManager } from './services/ExportConfigManager.js';
import { TraceSummaryService } from './services/TraceSummaryService.js';

const MAX_OUTPUT_LENGTH = 100000; // Temporairement augmenté pour documentation complète
const SKELETON_CACHE_DIR_NAME = '.skeletons';

class RooStateManagerServer {
    private server: Server;
    private conversationCache: Map<string, ConversationSkeleton> = new Map();
    private xmlExporterService: XmlExporterService;
    private exportConfigManager: ExportConfigManager;
    private traceSummaryService: TraceSummaryService;

    constructor() {
        this.xmlExporterService = new XmlExporterService();
        this.exportConfigManager = new ExportConfigManager();
        this.traceSummaryService = new TraceSummaryService(this.exportConfigManager);
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
        
        this._loadSkeletonsFromDisk().catch(error => {
            console.error("Error during initial skeleton load:", error);
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
                        inputSchema: { type: 'object', properties: {}, required: [] },
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
                            },
                            required: ['conversation_id'],
                        },
                    },
                    {
                        name: 'search_tasks_semantic',
                        description: 'Recherche des tâches de manière sémantique dans une conversation.',
                         inputSchema: {
                            type: 'object',
                            properties: {
                                conversation_id: { type: 'string', description: 'ID de la conversation à fouiller.' },
                                search_query: { type: 'string', description: 'La requête de recherche sémantique.' },
                                 max_results: { type: 'number', description: 'Nombre maximum de résultats à retourner.' },
                            },
                            required: ['conversation_id', 'search_query'],
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
                        name: 'view_conversation_tree',
                        description: 'Fournit une vue arborescente et condensée des conversations pour une analyse rapide.',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                task_id: { type: 'string', description: 'L\'ID de la tâche de départ. Si non fourni, utilise la tâche la plus récente.' },
                                view_mode: { type: 'string', enum: ['single', 'chain', 'cluster'], default: 'chain', description: 'Le mode d\'affichage.' },
                                truncate: { type: 'number', default: 0, description: 'Nombre de lignes à conserver au début et à la fin de chaque message. 0 pour vue complète (défaut intelligent).' },
                                max_output_length: { type: 'number', default: 50000, description: 'Limite maximale de caractères en sortie. Au-delà, force la troncature.' },
                                full_content: { type: 'boolean', default: false, description: 'Si true, affiche le contenu complet des messages au lieu d\'un aperçu.' },
                            },
                        },
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
                       name: rebuildAndRestart.name,
                       description: rebuildAndRestart.description,
                       inputSchema: rebuildAndRestart.inputSchema,
                    },
                    {
                       name: getMcpDevDocs.name,
                       description: getMcpDevDocs.description,
                       inputSchema: getMcpDevDocs.inputSchema,
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
                       name: analyzeVSCodeGlobalState.name,
                       description: analyzeVSCodeGlobalState.description,
                       inputSchema: analyzeVSCodeGlobalState.inputSchema,
                    },
                    {
                       name: repairVSCodeTaskHistory.name,
                       description: repairVSCodeTaskHistory.description,
                       inputSchema: repairVSCodeTaskHistory.inputSchema,
                    },
                    {
                       name: scanOrphanTasks.name,
                       description: scanOrphanTasks.description,
                       inputSchema: scanOrphanTasks.inputSchema,
                    },
                    {
                       name: testWorkspaceExtraction.name,
                       description: testWorkspaceExtraction.description,
                       inputSchema: testWorkspaceExtraction.inputSchema,
                    },
                    {
                       name: rebuildTaskIndex.name,
                       description: rebuildTaskIndex.description,
                       inputSchema: rebuildTaskIndex.inputSchema,
                    },
                    {
                       name: diagnoseSQLite.name,
                       description: diagnoseSQLite.description,
                       inputSchema: diagnoseSQLite.inputSchema,
                    },
                    {
                       name: examineRooGlobalStateTool.name,
                       description: examineRooGlobalStateTool.description,
                       inputSchema: examineRooGlobalStateTool.inputSchema,
                    },
                    {
                       name: repairTaskHistoryTool.name,
                       description: repairTaskHistoryTool.description,
                       inputSchema: repairTaskHistoryTool.inputSchema,
                    },
                    {
                       name: normalizeWorkspacePaths.name,
                       description: normalizeWorkspacePaths.description,
                       inputSchema: normalizeWorkspacePaths.inputSchema,
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
                    }
                ] as any[],
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
            const { name, arguments: args } = request.params;

            let result: CallToolResult;

            switch (name) {
                case 'minimal_test_tool':
                    result = { content: [{ type: 'text', text: 'Minimal tool executed successfully! Version 2' }] };
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
                    result = await this.handleBuildSkeletonCache();
                    break;
                case 'get_task_tree':
                    result = this.handleGetTaskTree(args as any);
                    break;
                case 'view_conversation_tree':
                    result = this.handleViewConversationTree(args as any);
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
               case rebuildAndRestart.name:
                   result = await rebuildAndRestart.handler(args as any);
                   break;
               case getMcpDevDocs.name:
                   result = await getMcpDevDocs.handler();
                   break;
               case 'diagnose_conversation_bom':
                   result = await this.handleDiagnoseConversationBom(args as any);
                   break;
               case 'repair_conversation_bom':
                   result = await this.handleRepairConversationBom(args as any);
                   break;
               case analyzeVSCodeGlobalState.name:
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
                  break;
               case generateTraceSummaryTool.name:
                   result = await this.handleGenerateTraceSummary(args as any);
                   break;
               case generateClusterSummaryTool.name:
                   result = await this.handleGenerateClusterSummary(args as any);
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
        return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
    }

    async handleListConversations(args: { limit?: number, sortBy?: 'lastActivity' | 'messageCount' | 'totalSize', sortOrder?: 'asc' | 'desc' }): Promise<CallToolResult> {
        
        interface SkeletonNode extends ConversationSkeleton {
            children: SkeletonNode[];
        }

        const allSkeletons = Array.from(this.conversationCache.values()).filter(skeleton =>
            skeleton.metadata && skeleton.metadata.lastActivity
        );

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
        
        const skeletonMap = new Map<string, SkeletonNode>(allSkeletons.map(s => [s.taskId, { ...s, children: [] }]));
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
        
        // La sérialisation est correcte, le problème n'était pas là.
        // La logique de construction de l'arbre est maintenue.
        const result = JSON.stringify(limitedForest, null, 2);

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

    async handleBuildSkeletonCache(): Promise<CallToolResult> {
        this.conversationCache.clear();
        const locations = await RooStorageDetector.detectStorageLocations(); // This returns task paths now
        if (locations.length === 0) {
            return { content: [{ type: 'text', text: 'Storage not found. Cache not built.' }] };
        }

        let skeletonsBuilt = 0;
        let skeletonsSkipped = 0;

        for (const loc of locations) {
            // loc is now the tasksPath, so we need to go up one level for the skeleton dir
            const storageDir = path.dirname(loc);
            const skeletonDir = path.join(storageDir, SKELETON_CACHE_DIR_NAME);
            await fs.mkdir(skeletonDir, { recursive: true });

            const conversationDirs = await fs.readdir(loc, { withFileTypes: true });
            for (const convDir of conversationDirs) {
                if (convDir.isDirectory() && convDir.name !== SKELETON_CACHE_DIR_NAME) {
                    const conversationId = convDir.name;
                    const taskPath = path.join(loc, conversationId);
                    const metadataPath = path.join(taskPath, 'task_metadata.json');
                    const skeletonPath = path.join(skeletonDir, `${conversationId}.json`);

                    try {
                        const metadataStat = await fs.stat(metadataPath);
                        try {
                            const skeletonStat = await fs.stat(skeletonPath);
                            if (skeletonStat.mtime >= metadataStat.mtime) {
                                skeletonsSkipped++;
                                continue; // Le squelette est à jour
                            }
                        } catch (e) {
                            // Le squelette n'existe pas, il faut le créer
                        }
                        
                        const skeleton = await RooStorageDetector.analyzeConversation(conversationId, taskPath);
                        if (skeleton) {
                            await fs.writeFile(skeletonPath, JSON.stringify(skeleton, null, 2));
                            this.conversationCache.set(conversationId, skeleton);
                            skeletonsBuilt++;
                        }
                    } catch (error) {
                         console.error(`Could not process task ${conversationId}:`, error);
                    }
                }
            }
        }
        await this._loadSkeletonsFromDisk(); // Recharger le cache complet après la construction
        return { content: [{ type: 'text', text: `Skeleton cache build complete. Built: ${skeletonsBuilt}, Skipped: ${skeletonsSkipped}.` }] };
    }

    private async _loadSkeletonsFromDisk(): Promise<void> {
        const locations = await RooStorageDetector.detectStorageLocations(); // returns task paths
        if (locations.length === 0) {
            console.error("No storage locations found, cannot load skeleton cache.");
            return;
        }

        this.conversationCache.clear();
        let loadedCount = 0;
        let errorCount = 0;

        for (const loc of locations) {
            const storageDir = path.dirname(loc);
            const skeletonDir = path.join(storageDir, SKELETON_CACHE_DIR_NAME);
            try {
                await fs.access(skeletonDir);
                const skeletonFiles = await fs.readdir(skeletonDir);
                for (const file of skeletonFiles) {
                    if (file.endsWith('.json')) {
                        const filePath = path.join(skeletonDir, file);
                        try {
                            let fileContent = await fs.readFile(filePath, 'utf-8');
                            if (fileContent.charCodeAt(0) === 0xFEFF) {
                                fileContent = fileContent.slice(1);
                            }
                            const skeleton: ConversationSkeleton = JSON.parse(fileContent);
                            if (skeleton && skeleton.taskId) { // Simple validation
                                this.conversationCache.set(skeleton.taskId, skeleton);
                                loadedCount++;
                            } else {
                                console.error(`Invalid skeleton file (missing taskId): ${filePath}`);
                                errorCount++;
                            }
                        } catch (parseError) {
                            console.error(`Corrupted skeleton file, skipping: ${filePath}`, parseError);
                            errorCount++;
                        }
                    }
                }
            } catch (dirError) {
                console.error(`Could not access skeleton directory ${skeletonDir}. This may be normal on first run.`);
            }
        }
        if (loadedCount > 0 || errorCount > 0) {
             console.error(`Skeleton loading complete. Loaded: ${loadedCount}, Errored: ${errorCount}.`);
        }
    }

    handleGetTaskTree(args: { conversation_id: string, max_depth?: number }): CallToolResult {
        const { conversation_id, max_depth = Infinity } = args;

        const skeletons = Array.from(this.conversationCache.values());
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
            
            return {
                taskId: skeleton.taskId,
                title: skeleton.metadata?.title,
                children: children.length > 0 ? children : undefined,
            };
        };
        
        const tree = buildTree(conversation_id, 1);

        if (!tree) {
            throw new Error(`Could not build tree for conversation ID '${conversation_id}'. Is the cache populated and the task ID valid?`);
        }

        return { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }] };
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

    private findLatestTask(): ConversationSkeleton | undefined {
        if (this.conversationCache.size === 0) {
            return undefined;
        }
        const validTasks = Array.from(this.conversationCache.values()).filter(
            s => s.metadata && s.metadata.lastActivity
        );
        if (validTasks.length === 0) {
            return undefined;
        }
        return validTasks.reduce((latest, current) => {
            return new Date(latest.metadata.lastActivity) > new Date(current.metadata.lastActivity) ? latest : current;
        });
    }

    handleViewConversationTree(args: { task_id?: string, view_mode?: 'single' | 'chain' | 'cluster', truncate?: number, max_output_length?: number }): CallToolResult {
        const { view_mode = 'chain', max_output_length = 50000 } = args;
        let { truncate = 0 } = args;
        let { task_id } = args;

        if (!task_id) {
            const latestTask = this.findLatestTask();
            if (!latestTask) {
                throw new Error("Cache is empty and no task_id was provided. Cannot determine the latest task.");
            }
            task_id = latestTask.taskId;
        }

        const skeletons = Array.from(this.conversationCache.values());
        const skeletonMap = new Map(skeletons.map(s => [s.taskId, s]));

        const getTaskChain = (startTaskId: string): ConversationSkeleton[] => {
            const chain: ConversationSkeleton[] = [];
            let currentId: string | undefined = startTaskId;
            while (currentId) {
                const skeleton = skeletonMap.get(currentId);
                if (skeleton) {
                    chain.unshift(skeleton);
                    currentId = skeleton.parentTaskId;
                } else {
                    break;
                }
            }
            return chain;
        };

        const formatTask = (skeleton: ConversationSkeleton, indent: string): string => {
            let output = `${indent}▶️ Task: ${skeleton.metadata.title || skeleton.taskId} (ID: ${skeleton.taskId})\n`;
            output += `${indent}  Parent: ${skeleton.parentTaskId || 'None'}\n`;
            output += `${indent}  Messages: ${skeleton.metadata.messageCount}\n`;
            skeleton.sequence.forEach(item => {
                if ('role' in item) { // Message user/assistant - contenu complet préservé
                    const role = item.role === 'user' ? '👤 User' : '🤖 Assistant';
                    const message = this.truncateMessage(item.content, truncate);
                    const messageLines = message.split('\n').map(l => `${indent}    | ${l}`).join('\n');
                    output += `${indent}  [${role}]:\n${messageLines}\n`;
                } else { // Action - format squelette simple
                    const icon = item.type === 'command' ? '⚙️' : '🛠️';
                    output += `${indent}  [${icon} ${item.name}] → ${item.status}\n`;
                }
            });
            return output;
        };

        // Estimation intelligente de la taille de sortie
        const estimateOutputSize = (skeletons: ConversationSkeleton[]): number => {
            let totalSize = 0;
            for (const skeleton of skeletons) {
                totalSize += 200; // En-tête de tâche
                for (const item of skeleton.sequence) {
                    if ('role' in item) {
                        totalSize += item.content.length + 100; // Message + formatage
                    } else {
                        totalSize += 150; // Action + formatage
                    }
                }
            }
            return totalSize;
        };

        let tasksToDisplay: ConversationSkeleton[] = [];
        const mainTask = skeletonMap.get(task_id);
        if (!mainTask) {
            throw new Error(`Task with ID '${task_id}' not found in cache.`);
        }

        switch (view_mode) {
            case 'single':
                tasksToDisplay.push(mainTask);
                break;
            case 'chain':
                tasksToDisplay = getTaskChain(task_id);
                break;
            case 'cluster':
                const chain = getTaskChain(task_id);
                if (chain.length > 0) {
                    const directParentId = chain[chain.length - 1].parentTaskId;
                    if (directParentId) {
                        const siblings = skeletons.filter(s => s.parentTaskId === directParentId);
                        // Display parent, then all its children (siblings of the target + target itself)
                        const parentTask = skeletonMap.get(directParentId);
                        if(parentTask) tasksToDisplay.push(parentTask);
                        tasksToDisplay.push(...siblings);
                    } else {
                         tasksToDisplay = chain; // It's a root task, show its chain
                    }
                } else {
                     tasksToDisplay.push(mainTask);
                }
                break;
        }
        
        // Logique intelligente de troncature
        const estimatedSize = estimateOutputSize(tasksToDisplay);
        
        // Si pas de troncature spécifiée et taille raisonnable, affichage complet
        if (truncate === 0 && estimatedSize <= max_output_length) {
            // Vue complète - pas de troncature
        } else if (truncate === 0 && estimatedSize > max_output_length) {
            // Forcer une troncature intelligente basée sur la taille estimée
            const totalMessages = tasksToDisplay.reduce((count, task) =>
                count + task.sequence.filter(item => 'role' in item).length, 0);
            truncate = Math.max(2, Math.floor(max_output_length / (estimatedSize / Math.max(1, totalMessages * 20))));
        }
        
        let formattedOutput = `Conversation Tree (Mode: ${view_mode})\n======================================\n`;
        if (estimatedSize > max_output_length) {
            formattedOutput += `⚠️  Sortie estimée: ${Math.round(estimatedSize/1000)}k chars, limite: ${Math.round(max_output_length/1000)}k chars, troncature: ${truncate} lignes\n\n`;
        }
        tasksToDisplay.forEach((task, index) => {
            const indent = '  '.repeat(index);
            formattedOutput += formatTask(task, indent);
        });

        return { content: [{ type: 'text', text: formattedOutput }] };
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

    async handleSearchTasksSemantic(args: { conversation_id: string, search_query: string, max_results?: number }): Promise<CallToolResult> {
        const { search_query, max_results = 10 } = args;
        
        try {
            // Utiliser la vraie recherche sémantique avec Qdrant
            const contextWindows = await searchTasks(search_query, {
                limit: max_results,
                contextBeforeCount: 2,
                contextAfterCount: 1,
                scoreThreshold: 0.7, // Seuil de pertinence minimum
            });

            const results = contextWindows.map(window => ({
                taskId: window.taskId,
                score: window.relevanceScore,
                mainContent: this.truncateMessage(window.mainChunk.content, 3),
                contextBefore: window.contextBefore.map(c => this.truncateMessage(c.content, 1)),
                contextAfter: window.contextAfter.map(c => this.truncateMessage(c.content, 1)),
                timestamp: window.mainChunk.timestamp,
                chunkType: window.mainChunk.chunk_type,
            }));

            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };

        } catch (error) {
            console.error('Semantic search error:', error);
            // Fallback sur la recherche simple en cas d'erreur
            return this.handleSearchTasksSemanticFallback(args);
        }
    }

    private async handleSearchTasksSemanticFallback(args: { conversation_id: string, search_query: string, max_results?: number }): Promise<CallToolResult> {
        const { conversation_id, search_query, max_results = 10 } = args;
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
            
            const skeleton = this.conversationCache.get(task_id);
            if (!skeleton) {
                throw new Error(`Task with ID '${task_id}' not found in cache.`);
            }
            
            const conversation = await RooStorageDetector.findConversationById(task_id);
            const taskPath = conversation?.path;
            
            if (!taskPath) {
                throw new Error(`Task directory for '${task_id}' not found in any storage location.`);
            }
            
            const { indexTask } = await import('./services/task-indexer.js');
            const indexedPoints = await indexTask(task_id, taskPath);
            
            return {
                content: [{
                    type: "text",
                    text: `# Indexation sémantique terminée\n\n**Tâche:** ${task_id}\n**Chemin:** ${taskPath}\n**Chunks indexés:** ${indexedPoints.length}`
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

    private async _executePowerShellScript(scriptPath: string, args: string[] = []): Promise<CallToolResult> {
        const fullScriptPath = path.resolve(process.cwd(), scriptPath);
        // Important: Quote the file path to handle spaces
        const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${fullScriptPath}" ${args.join(' ')}`;
        
        return new Promise((resolve, reject) => {
            exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => { // 50MB buffer
                if (error) {
                    const errorMessage = `ERROR: ${error.message}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`;
                    reject(new Error(errorMessage));
                    return;
                }
                
                // When expecting JSON, only consider stdout if there's no error.
                if (stderr && !stdout) {
                     reject(new Error(`PowerShell script error:\n${stderr}`));
                     return;
                }

                resolve({ content: [{ type: 'text', text: stdout.trim() }] });
            });
        });
    }

    async handleDiagnoseRooState(args: { offset?: number, limit?: number }): Promise<CallToolResult> {
        const scriptPath = '../roo-extensions/scripts/audit/audit-roo-tasks.ps1';
        const scriptArgs: string[] = ['-AsJson'];
        if (args.offset) {
            scriptArgs.push(`-Offset ${args.offset}`);
        }
        if (args.limit) {
            scriptArgs.push(`-Limit ${args.limit}`);
        }
        return this._executePowerShellScript(scriptPath, scriptArgs);
    }

    async handleRepairWorkspacePaths(args: { path_pairs?: string[], whatIf?: boolean, non_interactive?: boolean }): Promise<CallToolResult> {
        const scriptPath = '../roo-extensions/scripts/repair/repair-roo-tasks.ps1';
        const scriptArgs: string[] = [];
        
        if (args.path_pairs && args.path_pairs.length > 0) {
            const pairs = args.path_pairs.map(p => `'${p.replace(/'/g, "''")}'`).join(',');
            scriptArgs.push(`-PathPairs @(${pairs})`);
        }
        
        if (args.whatIf) {
            scriptArgs.push('-WhatIf');
        }
        
        // Default to non-interactive if not specified
        if (args.non_interactive !== false) {
            scriptArgs.push('-NonInteractive');
        }

        return this._executePowerShellScript(scriptPath, scriptArgs);
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
        
        for (const tasksPath of locations) {
            try {
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
                console.error(`Erreur lors du scan de ${tasksPath}:`, dirError);
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
        
        for (const tasksPath of locations) {
            try {
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
                console.error(`Erreur lors du scan de ${tasksPath}:`, dirError);
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
                throw new Error(`Conversation avec l'ID '${conversationId}' non trouvée dans le cache.`);
            }

            // Collecter tous les descendants de la conversation
            const allSkeletons = Array.from(this.conversationCache.values());
            const children: ConversationSkeleton[] = [];
            
            const collectChildren = (parentId: string) => {
                const directChildren = allSkeletons.filter(s => s.parentTaskId === parentId);
                children.push(...directChildren);
                directChildren.forEach(child => collectChildren(child.taskId));
            };
            
            collectChildren(conversationId);

            const xmlContent = this.xmlExporterService.generateConversationXml(rootSkeleton, children, {
                maxDepth,
                includeContent,
                prettyPrint
            });

            if (filePath) {
                await this.xmlExporterService.saveXmlToFile(xmlContent, filePath);
                return {
                    content: [{
                        type: 'text',
                        text: `Export XML de la conversation '${conversationId}' (${children.length + 1} tâches) sauvegardé dans '${filePath}'.`
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
     * Gère l'export XML d'un projet complet
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
            
            // Obtenir toutes les tâches du cache qui correspondent au projet
            const allSkeletons = Array.from(this.conversationCache.values());
            
            // Pour l'instant, on utilise toutes les tâches du cache
            // Dans une version plus avancée, on pourrait filtrer par projectPath
            // en utilisant RooStorageDetector pour vérifier l'association
            
            const xmlContent = this.xmlExporterService.generateProjectXml(allSkeletons, projectPath, {
                startDate,
                endDate,
                prettyPrint
            });

            if (filePath) {
                await this.xmlExporterService.saveXmlToFile(xmlContent, filePath);
                return {
                    content: [{
                        type: 'text',
                        text: `Export XML du projet '${projectPath}' (${allSkeletons.length} tâches analysées) sauvegardé dans '${filePath}'.`
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
     * Gère la génération de résumé intelligent de trace de conversation
     */
    async handleGenerateTraceSummary(args: {
        taskId: string;
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

            // Préparer les options de génération
            const summaryOptions = {
                detailLevel: args.detailLevel || 'Full' as const,
                outputFormat: args.outputFormat || 'markdown' as const,
                truncationChars: args.truncationChars || 0,
                compactStats: args.compactStats || false,
                includeCss: args.includeCss !== undefined ? args.includeCss : true,
                generateToc: args.generateToc !== undefined ? args.generateToc : true
            };

            // Générer le résumé
            const result = await this.traceSummaryService.generateSummary(conversation, summaryOptions);

            if (!result.success) {
                throw new Error(`Erreur lors de la génération du résumé: ${result.error}`);
            }

            // Préparer la réponse avec métadonnées
            const response = [
                `**Résumé généré avec succès pour la tâche ${taskId}**`,
                ``,
                `**Statistiques:**`,
                `- Total sections: ${result.statistics.totalSections}`,
                `- Messages utilisateur: ${result.statistics.userMessages}`,
                `- Réponses assistant: ${result.statistics.assistantMessages}`,
                `- Résultats d'outils: ${result.statistics.toolResults}`,
                `- Taille totale: ${Math.round(result.statistics.totalContentSize / 1024 * 10) / 10} KB`,
                result.statistics.compressionRatio ? `- Ratio de compression: ${result.statistics.compressionRatio}x` : '',
                ``,
                `**Mode de génération:** ${summaryOptions.detailLevel}`,
                `**Format:** ${summaryOptions.outputFormat}`,
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
                    text: `Erreur lors de la génération de résumé : ${errorMessage}`
                }]
            };
        }
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


    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error(`Roo State Manager Server started - v${packageJson.version}`);
    }

    async stop() {
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