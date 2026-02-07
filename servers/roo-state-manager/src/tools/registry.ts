/**
 * Registre central des outils MCP
 *
 * Ce fichier centralise l'enregistrement de tous les outils du serveur MCP.
 * Il gère le mapping entre les noms d'outils et leurs handlers.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ServerState } from '../services/state-manager.service.js';
import * as toolExports from './index.js';
import { GenericError, GenericErrorCode } from '../types/errors.js';

/**
 * Enregistre le handler pour ListTools
 */
export function registerListToolsHandler(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: 'minimal_test_tool',
                    description: 'This is a minimal tool to check if the MCP is reloading.',
                    inputSchema: { type: 'object', properties: {}, required: [] },
                },
                // CONS-13: Outil Storage consolidé (2→1)
                toolExports.storageInfoTool.definition,
                // [DEPRECATED] Anciens outils storage (backward compatibility)
                toolExports.detectStorageTool.definition,
                toolExports.getStorageStatsTool.definition,
                toolExports.listConversationsTool.definition,
                {
                    name: 'touch_mcp_settings',
                    description: 'Touche le fichier de paramètres pour forcer le rechargement des MCPs Roo.',
                    inputSchema: { type: 'object', properties: {}, required: [] },
                },
                // CONS-13: Outil Maintenance consolidé (3→1)
                toolExports.maintenanceToolDefinition,
                // [DEPRECATED] Ancien outil cache (backward compatibility)
                toolExports.buildSkeletonCacheDefinition,
                // CONS-9: Outils Tasks consolidés (4→2)
                toolExports.taskBrowseTool,
                toolExports.taskExportTool,
                // CONS-11: Outils Search/Indexing consolidés (4→2)
                toolExports.roosyncSearchTool,
                toolExports.roosyncIndexingTool,
                // CONS-11 Legacy: conservés pour compatibilité backward
                toolExports.searchTasksByContentTool.definition,
                toolExports.debugAnalyzeTool.definition,
                {
                    name: toolExports.viewConversationTree.name,
                    description: toolExports.viewConversationTree.description,
                    inputSchema: toolExports.viewConversationTree.inputSchema,
                },
                {
                    name: toolExports.readVscodeLogs.name,
                    description: toolExports.readVscodeLogs.description,
                    inputSchema: toolExports.readVscodeLogs.inputSchema,
                },
                {
                    name: toolExports.manageMcpSettings.name,
                    description: toolExports.manageMcpSettings.description,
                    inputSchema: toolExports.manageMcpSettings.inputSchema,
                },
                toolExports.indexTaskSemanticTool.definition,
                toolExports.resetQdrantCollectionTool.definition,
                {
                   name: toolExports.rebuildAndRestart.name,
                   description: toolExports.rebuildAndRestart.description,
                   inputSchema: toolExports.rebuildAndRestart.inputSchema,
                },
                {
                   name: toolExports.getMcpBestPractices.name,
                   description: toolExports.getMcpBestPractices.description,
                   inputSchema: toolExports.getMcpBestPractices.inputSchema,
                },
                {
                   name: toolExports.rebuildTaskIndexFixed.name,
                   description: toolExports.rebuildTaskIndexFixed.description,
                   inputSchema: toolExports.rebuildTaskIndexFixed.inputSchema,
                },
                // [DEPRECATED] Anciens outils BOM (backward compatibility via maintenance)
                toolExports.diagnoseConversationBomTool.definition,
                toolExports.repairConversationBomTool.definition,
                // CONS-10: Outils Export consolidés (6→2)
                toolExports.exportDataTool,
                toolExports.exportConfigTool,
                // CONS-12: Outil unifié consolidé
                {
                    name: toolExports.roosyncSummarizeTool.name,
                    description: toolExports.roosyncSummarizeTool.description,
                    inputSchema: toolExports.roosyncSummarizeTool.inputSchema,
                },
                // CLEANUP-2: Legacy summary tools retirés (generate_trace_summary, generate_cluster_summary, get_conversation_synthesis)
                // Remplacés par roosync_summarize (CONS-12)
                // CONS-10: exportConversationJsonTool et exportConversationCsvTool retirés
                // (remplacés par export_data avec format='json'/'csv')
                toolExports.viewTaskDetailsTool.definition,
                toolExports.getRawConversationTool.definition,
                // CONS-9: exportTaskTreeMarkdownTool retiré (remplacé par task_export action='markdown')

                // Diagnostic Tools - WP4
                {
                    name: toolExports.analyze_roosync_problems.name,
                    description: toolExports.analyze_roosync_problems.description,
                    inputSchema: toolExports.analyze_roosync_problems.inputSchema,
                },
                {
                    name: toolExports.diagnose_env.name,
                    description: toolExports.diagnose_env.description,
                    inputSchema: toolExports.diagnose_env.inputSchema,
                },

                // RooSync tools - Batch 6 synchronization
                ...toolExports.roosyncTools,
                // RooSync Messaging tools - Phase 1
                {
                    name: 'roosync_send_message',
                    description: 'Envoyer un message structuré à une autre machine via RooSync',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            to: {
                                type: 'string',
                                description: 'ID de la machine destinataire (ex: myia-ai-01)'
                            },
                            subject: {
                                type: 'string',
                                description: 'Sujet du message'
                            },
                            body: {
                                type: 'string',
                                description: 'Corps du message (markdown supporté)'
                            },
                            priority: {
                                type: 'string',
                                enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
                                description: 'Priorité du message (défaut: MEDIUM)'
                            },
                            tags: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Tags optionnels pour catégoriser le message'
                            },
                            thread_id: {
                                type: 'string',
                                description: 'ID du thread pour regrouper les messages'
                            },
                            reply_to: {
                                type: 'string',
                                description: 'ID du message auquel on répond'
                            }
                        },
                        required: ['to', 'subject', 'body']
                    }
                },
                {
                    name: 'roosync_read_inbox',
                    description: 'Lire la boîte de réception des messages RooSync',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            status: {
                                type: 'string',
                                enum: ['unread', 'read', 'all'],
                                description: 'Filtrer par status (défaut: all)'
                            },
                            limit: {
                                type: 'number',
                                description: 'Nombre maximum de messages à retourner'
                            }
                        }
                    }
                },
                {
                    name: 'roosync_get_message',
                    description: 'Obtenir les détails complets d\'un message spécifique',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            message_id: {
                                type: 'string',
                                description: 'ID du message à récupérer'
                            },
                            mark_as_read: {
                                type: 'boolean',
                                description: 'Marquer automatiquement comme lu (défaut: false)'
                            }
                        },
                        required: ['message_id']
                    }
                },
                // RooSync Messaging tools - Phase 2 (Management)
                {
                    name: 'roosync_mark_message_read',
                    description: 'Marquer un message comme lu en mettant à jour son statut',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            message_id: {
                                type: 'string',
                                description: 'ID du message à marquer comme lu'
                            }
                        },
                        required: ['message_id']
                    }
                },
                {
                    name: 'roosync_archive_message',
                    description: 'Archiver un message en le déplaçant de inbox/ vers archive/',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            message_id: {
                                type: 'string',
                                description: 'ID du message à archiver'
                            }
                        },
                        required: ['message_id']
                    }
                },
                {
                    name: 'roosync_reply_message',
                    description: 'Répondre à un message existant en créant un nouveau message lié',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            message_id: {
                                type: 'string',
                                description: 'ID du message auquel répondre'
                            },
                            body: {
                                type: 'string',
                                description: 'Corps de la réponse'
                            },
                            priority: {
                                type: 'string',
                                enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
                                description: 'Priorité de la réponse (défaut: priorité du message original)'
                            },
                            tags: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Tags supplémentaires (le tag "reply" est ajouté automatiquement)'
                            }
                        },
                        required: ['message_id', 'body']
                    }
                },
            ] as any[],
        };
    });
}

/**
 * Enregistre le handler pour CallTool avec tous les outils
 */
export function registerCallToolHandler(
    server: Server,
    state: ServerState,
    handleTouchMcpSettings: () => Promise<CallToolResult>,
    handleExportConversationJson: (args: any) => Promise<CallToolResult>,
    handleExportConversationCsv: (args: any) => Promise<CallToolResult>,
    ensureSkeletonCacheIsFresh: (args?: { workspace?: string }) => Promise<boolean>,
    saveSkeletonToDisk: (skeleton: any) => Promise<void>
): void {
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
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
           // CONS-13: Outil Storage consolidé
           case 'storage_info':
               result = await toolExports.handleStorageInfo(args as any);
               break;
           // [DEPRECATED] Anciens outils storage
           case toolExports.detectStorageTool.definition.name:
               result = await toolExports.detectStorageTool.handler({});
               break;
          case toolExports.getStorageStatsTool.definition.name:
                result = await toolExports.getStorageStatsTool.handler({});
                break;
            case toolExports.listConversationsTool.definition.name:
                result = await toolExports.listConversationsTool.handler(args as any, state.conversationCache);
                break;
            case 'touch_mcp_settings':
                result = await handleTouchMcpSettings();
                break;
            // CONS-13: Outil Maintenance consolidé
            case 'maintenance':
                result = await toolExports.handleMaintenance(args as any, state.conversationCache, state);
                break;
            // [DEPRECATED] Ancien outil cache
            case 'build_skeleton_cache':
                result = await toolExports.handleBuildSkeletonCache(args as any, state.conversationCache, state);
                break;
            // CONS-9: Nouveaux outils consolidés
            case 'task_browse':
                result = await toolExports.handleTaskBrowse(
                    args as any,
                    state.conversationCache,
                    async () => { await ensureSkeletonCacheIsFresh(); },
                    undefined  // contextWorkspace
                );
                break;
            case 'task_export':
                result = await toolExports.handleTaskExport(
                    args as any,
                    state.conversationCache,
                    async () => { await ensureSkeletonCacheIsFresh(); }
                );
                break;
            case toolExports.viewConversationTree.name:
                result = await toolExports.viewConversationTree.handler(args as any, state.conversationCache);
                break;
            case toolExports.viewTaskDetailsTool.definition.name:
                result = await toolExports.viewTaskDetailsTool.handler(args as any, state.conversationCache);
                break;
            // CONS-11: Outil unifié roosync_search
            case 'roosync_search':
                result = await toolExports.handleRooSyncSearch(
                    args as any,
                    state.conversationCache,
                    ensureSkeletonCacheIsFresh,
                    toolExports.handleSearchTasksSemanticFallback,
                    () => toolExports.handleDiagnoseSemanticIndex(state.conversationCache)
                );
                break;
            // CONS-11: Outil unifié roosync_indexing
            case 'roosync_indexing':
                result = await toolExports.handleRooSyncIndexing(
                    args as any,
                    state.conversationCache,
                    ensureSkeletonCacheIsFresh,
                    saveSkeletonToDisk,
                    state.qdrantIndexQueue,
                    (enabled: boolean) => { state.isQdrantIndexingEnabled = enabled; },
                    toolExports.rebuildTaskIndexFixed.handler
                );
                break;
            // CONS-11 Legacy: search_tasks_by_content conservé pour backward compat
            case toolExports.searchTasksByContentTool.definition.name:
                result = await toolExports.searchTasksByContentTool.handler(
                    args as any,
                    state.conversationCache,
                    ensureSkeletonCacheIsFresh,
                    toolExports.handleSearchTasksSemanticFallback,
                    () => toolExports.handleDiagnoseSemanticIndex(state.conversationCache)
                );
                break;
           case toolExports.debugAnalyzeTool.definition.name:
               result = await toolExports.debugAnalyzeTool.handler(args as any, state.conversationCache);
               break;
           // CONS-9: debug_task_parsing retiré (remplacé par task_export action='debug')
           case toolExports.readVscodeLogs.name:
               result = await toolExports.readVscodeLogs.handler(args as any);
               break;
           case toolExports.manageMcpSettings.name:
               result = await toolExports.manageMcpSettings.handler(args as any);
               break;
           case toolExports.indexTaskSemanticTool.definition.name:
               result = await toolExports.indexTaskSemanticTool.handler(
                   args as any,
                   state.conversationCache,
                   ensureSkeletonCacheIsFresh
               );
               break;
           case toolExports.resetQdrantCollectionTool.definition.name:
               result = await toolExports.resetQdrantCollectionTool.handler(
                   args as any,
                   state.conversationCache,
                   saveSkeletonToDisk,
                   state.qdrantIndexQueue,
                   (enabled: boolean) => { state.isQdrantIndexingEnabled = enabled; }
               );
               break;
           case toolExports.rebuildAndRestart.name:
               result = await toolExports.rebuildAndRestart.handler(args as any);
               break;
           case toolExports.getMcpBestPractices.name:
               result = await toolExports.getMcpBestPractices.handler();
               break;
           case toolExports.rebuildTaskIndexFixed.name:
               result = await toolExports.rebuildTaskIndexFixed.handler(args as any);
               break;
           case 'diagnose_conversation_bom':
               result = await toolExports.diagnoseConversationBomTool.handler(args as any);
               break;
           case 'repair_conversation_bom':
               result = await toolExports.repairConversationBomTool.handler(args as any);
              break;

           // CONS-10: Outils Export consolidés (6→2)
           case toolExports.exportDataTool.name:
               result = await toolExports.handleExportData(
                   args as any,
                   state.conversationCache,
                   state.xmlExporterService,
                   async (options?: { workspace?: string }) => { await ensureSkeletonCacheIsFresh(options); },
                   async (id: string) => state.conversationCache.get(id) || null
               );
               break;
           case toolExports.exportConfigTool.name:
               result = await toolExports.handleExportConfig(args as any, state.exportConfigManager);
               break;

           // CONS-12: Outil unifié consolidé
           case toolExports.roosyncSummarizeTool.name: {
               const summaryResult = await toolExports.handleRooSyncSummarize(
                   args as any,
                   async (id: string) => state.conversationCache.get(id) || null,
                   async (rootId: string) => {
                       // Fonction findChildTasks pour le mode cluster
                       const allTasks = Array.from(state.conversationCache.values());
                       return allTasks.filter(task => task.metadata?.parentTaskId === rootId);
                   }
               );
               result = { content: [{ type: 'text', text: summaryResult }] };
               break;
           }
           // CLEANUP-2: Legacy summary tools handlers retirés (generate_trace_summary, generate_cluster_summary, get_conversation_synthesis)
           // Remplacés par roosync_summarize (CONS-12)
           // CONS-10: [DEPRECATED] Handlers conservés pour backward compatibility
           // Ces outils seront retirés dans une version future - utiliser export_data et export_config
           case toolExports.exportConversationJsonTool.name:
              result = await handleExportConversationJson(args as any);
              break;
           case toolExports.exportConversationCsvTool.name:
              result = await handleExportConversationCsv(args as any);
              break;
          case toolExports.exportTasksXmlTool.name:
             result = await toolExports.handleExportTasksXml(args as any, state.conversationCache, state.xmlExporterService, async () => { await ensureSkeletonCacheIsFresh(); });
             break;
         case toolExports.exportConversationXmlTool.name:
             result = await toolExports.handleExportConversationXml(args as any, state.conversationCache, state.xmlExporterService, async () => { await ensureSkeletonCacheIsFresh(); });
             break;
         case toolExports.exportProjectXmlTool.name:
             result = await toolExports.handleExportProjectXml(args as any, state.conversationCache, state.xmlExporterService, async (options?: { workspace?: string }) => { await ensureSkeletonCacheIsFresh(options); });
             break;
         case toolExports.configureXmlExportTool.name:
             result = await toolExports.handleConfigureXmlExport(args as any, state.exportConfigManager);
             break;
            case toolExports.getRawConversationTool.definition.name:
                result = await toolExports.getRawConversationTool.handler(args as any);
                break;
          // CLEANUP-2: getConversationSynthesisTool handler retiré (remplacé par roosync_summarize)
          // CONS-9: export_task_tree_markdown retiré (remplacé par task_export action='markdown')

          // Diagnostic Tools - WP4
          case toolExports.analyze_roosync_problems.name:
              result = await toolExports.analyzeRooSyncProblems(args as any) as any;
              break;
          case toolExports.diagnose_env.name:
              result = await toolExports.diagnoseEnv(args as any);
              break;

          // RooSync tools - Batch 6 synchronization
          case 'roosync_get_status':
              try {
                  const roosyncResult = await toolExports.roosyncGetStatus(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_compare_config':
              try {
                  const roosyncResult = await toolExports.roosyncCompareConfig(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_list_diffs':
              try {
                  const roosyncResult = await toolExports.roosyncListDiffs(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_get_decision_details':
              try {
                  const roosyncResult = await toolExports.roosyncGetDecisionDetails(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_approve_decision':
              try {
                  const roosyncResult = await toolExports.roosyncApproveDecision(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_reject_decision':
              try {
                  const roosyncResult = await toolExports.roosyncRejectDecision(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_apply_decision':
              try {
                  const roosyncResult = await toolExports.roosyncApplyDecision(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_rollback_decision':
              try {
                  const roosyncResult = await toolExports.roosyncRollbackDecision(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_init':
              try {
                  const roosyncResult = await toolExports.roosyncInit(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_update_baseline':
              try {
                  const roosyncResult = await toolExports.roosyncUpdateBaseline(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_manage_baseline':
              try {
                  const roosyncResult = await toolExports.roosync_manage_baseline(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_debug_reset':
              try {
                  const roosyncResult = await toolExports.roosync_debug_reset(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_export_baseline':
              try {
                  const roosyncResult = await import('./roosync/export-baseline.js').then(m => m.roosync_export_baseline(args as any));
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_collect_config':
              try {
                  const roosyncResult = await toolExports.roosyncCollectConfig(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_publish_config':
              try {
                  const roosyncResult = await toolExports.roosyncPublishConfig(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_apply_config':
              try {
                  const roosyncResult = await toolExports.roosyncApplyConfig(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          // RooSync Messaging tools - Phase 1
           case 'roosync_send_message':
               try {
                   result = await toolExports.sendMessage(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           case 'roosync_read_inbox':
               try {
                   result = await toolExports.readInbox(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           case 'roosync_get_message':
               try {
                   result = await toolExports.getMessage(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           // RooSync Messaging tools - Phase 2 (Management)
           case 'roosync_mark_message_read':
               try {
                   result = await toolExports.markMessageRead(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           case 'roosync_archive_message':
               try {
                   result = await toolExports.archiveMessage(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           case 'roosync_reply_message':
               try {
                   result = await toolExports.replyMessage(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           // NOUVEAU: Outil d'inventaire
           case 'roosync_get_machine_inventory':
               try {
                   const invResult = await toolExports.getMachineInventoryTool.execute(args as any, {} as any);
                   if (invResult.success) {
                       result = { content: [{ type: 'text', text: JSON.stringify(invResult.data, null, 2) }] };
                   } else {
                       result = { content: [{ type: 'text', text: `Error: ${invResult.error?.message}` }], isError: true };
                   }
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           // NOUVEAU: Outil de refresh dashboard (T3.17)
           case 'roosync_refresh_dashboard':
               try {
                   const roosyncResult = await toolExports.roosyncRefreshDashboard(args as any);
                   result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           default:
               throw new GenericError(`Tool not found: ${name}`, GenericErrorCode.INVALID_ARGUMENT);
       }

        return result;
    });
}