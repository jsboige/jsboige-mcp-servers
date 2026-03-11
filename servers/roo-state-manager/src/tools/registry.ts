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
import { RooStorageDetector } from '../utils/roo-storage-detector.js';
import { ClaudeStorageDetector } from '../utils/claude-storage-detector.js';
import * as path from 'path';
import { existsSync } from 'fs';
import { CACHE_CONFIG } from '../config/server-config.js';

/**
 * Enregistre le handler pour ListTools
 */
export function registerListToolsHandler(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                // B4 (#603): storage_info, touch_mcp_settings, maintenance, manage_mcp_settings, rebuild_and_restart
                // retirés de ListTools — couverts par roosync_storage_management et roosync_mcp_management (CONS-#443)
                // CallTool handlers conservés pour backward compat

                // CONS-X (#457): Outil consolidé conversation_browser (task_browse + view_conversation_tree + roosync_summarize → 1)
                toolExports.conversationBrowserTool,
                toolExports.taskExportTool,
                // CONS-11: Outils Search/Indexing consolidés (4→2)
                toolExports.roosyncSearchTool,
                toolExports.roosyncIndexingTool,
                // #452 Phase 2: Recherche sémantique dans le code workspace (Roo index)
                toolExports.codebaseSearchTool,
                {
                    name: toolExports.readVscodeLogs.name,
                    description: toolExports.readVscodeLogs.description,
                    inputSchema: toolExports.readVscodeLogs.inputSchema,
                },
                {
                   name: toolExports.getMcpBestPractices.name,
                   description: toolExports.getMcpBestPractices.description,
                   inputSchema: toolExports.getMcpBestPractices.inputSchema,
                },
                // CONS-10: Outils Export consolidés (6→2)
                toolExports.exportDataTool,
                toolExports.exportConfigTool,
                // CONS-12→#457: roosync_summarize retiré de ListTools (remplacé par conversation_browser action=summarize)
                // CallTool handler conservé pour backward compat
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

                // RooSync tools - Batch 6 synchronization
                ...toolExports.roosyncTools,
                // CONS-1: Les 6 outils messagerie legacy sont maintenant dans roosyncTools via les metadata
                // (roosync_send, roosync_read, roosync_manage)
                // Les anciens noms (roosync_send_message, etc.) restent fonctionnels via CallTool pour backward compat
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
    // #519: handleExportConversationJson et handleExportConversationCsv retirés (CONS-10 legacy)
    ensureSkeletonCacheIsFresh: (args?: { workspace?: string }) => Promise<boolean>,
    saveSkeletonToDisk: (skeleton: any) => Promise<void>
): void {
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
        const { name, arguments: args } = request.params;

        let result: CallToolResult;

        switch (name) {
           // CONS-13: Outil Storage consolidé
           case 'storage_info':
               result = await toolExports.handleStorageInfo(args as any);
               break;
           // [DEPRECATED] list_conversations → conversation_browser action='list'
           case 'list_conversations':
               result = await toolExports.listConversationsTool.handler(
                   args as any,
                   state.conversationCache
               );
               break;
           // #519: Anciens outils storage retirés (detect_storage, get_storage_stats)
            case 'touch_mcp_settings':
                result = await handleTouchMcpSettings();
                break;
            // CONS-13: Outil Maintenance consolidé
            case 'maintenance':
                result = await toolExports.handleMaintenance(args as any, state.conversationCache, state);
                break;
            // [REMOVED] build_skeleton_cache — #625 dead code cleanup (not in alwaysAllow)
            // CONS-X (#457): Outil consolidé conversation_browser
            case 'conversation_browser':
                result = await toolExports.handleConversationBrowser(
                    args as any,
                    state.conversationCache,
                    async () => { await ensureSkeletonCacheIsFresh(); },
                    CACHE_CONFIG.DEFAULT_WORKSPACE,  // contextWorkspace: utilise process.cwd() ou WORKSPACE_PATH
                    async (id: string) => {
                        // 1. Try RAM cache first
                        const cached = state.conversationCache.get(id);
                        if (cached) return cached;
                        // 2. Claude Code sessions (taskId starts with 'claude-')
                        if (id.startsWith('claude-')) {
                            try {
                                const skeleton = await ClaudeStorageDetector.findConversationById(id);
                                if (skeleton) {
                                    state.conversationCache.set(id, skeleton);
                                    return skeleton;
                                }
                            } catch { /* Claude fallback failed */ }
                            return null;
                        }
                        // 3. Fallback: scan disk for Roo conversations
                        try {
                            const locations = await RooStorageDetector.detectStorageLocations();
                            for (const loc of locations) {
                                const taskPath = path.join(loc, id);
                                if (existsSync(taskPath)) {
                                    const skeleton = await RooStorageDetector.analyzeConversation(id, taskPath);
                                    if (skeleton) {
                                        state.conversationCache.set(id, skeleton);
                                        return skeleton;
                                    }
                                }
                            }
                        } catch { /* disk fallback failed */ }
                        return null;
                    },
                    async (rootId: string) => {
                        // Fonction findChildTasks pour le mode cluster
                        try {
                            const locations = await RooStorageDetector.detectStorageLocations();
                            for (const loc of locations) {
                                const taskPath = path.join(loc, rootId);
                                if (existsSync(taskPath)) {
                                    const skeleton = await RooStorageDetector.analyzeConversation(rootId, taskPath);
                                    if (skeleton && !state.conversationCache.has(rootId)) {
                                        state.conversationCache.set(rootId, skeleton);
                                    }
                                }
                            }
                        } catch { /* ignore disk errors */ }
                        const allTasks = Array.from(state.conversationCache.values());
                        return allTasks.filter(task => task.metadata?.parentTaskId === rootId);
                    },
                    state // Pass serverState for rebuild action
                );
                break;
            // [DEPRECATED] CONS-9: task_browse conservé pour backward compat
            case 'task_browse':
                result = await toolExports.handleTaskBrowse(
                    args as any,
                    state.conversationCache,
                    async () => { await ensureSkeletonCacheIsFresh(); },
                    CACHE_CONFIG.DEFAULT_WORKSPACE  // contextWorkspace: utilise process.cwd() ou WORKSPACE_PATH
                );
                break;
            case 'task_export':
                result = await toolExports.handleTaskExport(
                    args as any,
                    state.conversationCache,
                    async () => { await ensureSkeletonCacheIsFresh(); }
                );
                break;
            // [DEPRECATED] #457: view_conversation_tree conservé pour backward compat
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
            // #452 Phase 2: Recherche sémantique dans le code workspace
            case 'codebase_search':
                result = await toolExports.handleCodebaseSearch(args as any);
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
            // [REMOVED] search_tasks_by_content — #625 dead code cleanup (not in alwaysAllow)
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

           // [DEPRECATED] CONS-12→#457: roosync_summarize conservé pour backward compat
           case toolExports.roosyncSummarizeTool.name: {
               const summaryResult = await toolExports.handleRooSyncSummarize(
                   args as any,
                   async (id: string) => {
                       // 1. Try RAM cache first
                       const cached = state.conversationCache.get(id);
                       if (cached) return cached;
                       // 2. Fallback: scan disk for Roo conversations (#449)
                       try {
                           const locations = await RooStorageDetector.detectStorageLocations();
                           for (const loc of locations) {
                               const taskPath = path.join(loc, id);
                               if (existsSync(taskPath)) {
                                   const skeleton = await RooStorageDetector.analyzeConversation(id, taskPath);
                                   if (skeleton) {
                                       state.conversationCache.set(id, skeleton);
                                       return skeleton;
                                   }
                               }
                           }
                       } catch { /* disk fallback failed, return null */ }
                       return null;
                   },
                   async (rootId: string) => {
                       // Fonction findChildTasks pour le mode cluster
                       const allTasks = Array.from(state.conversationCache.values());
                       // Also check disk for child tasks (#449)
                       try {
                           const locations = await RooStorageDetector.detectStorageLocations();
                           for (const loc of locations) {
                               const taskPath = path.join(loc, rootId);
                               if (existsSync(taskPath)) {
                                   const skeleton = await RooStorageDetector.analyzeConversation(rootId, taskPath);
                                   if (skeleton && !state.conversationCache.has(rootId)) {
                                       state.conversationCache.set(rootId, skeleton);
                                   }
                               }
                           }
                       } catch { /* ignore disk errors */ }
                       const allTasksUpdated = Array.from(state.conversationCache.values());
                       return allTasksUpdated.filter(task => task.metadata?.parentTaskId === rootId);
                   }
               );
               result = { content: [{ type: 'text', text: summaryResult }] };
               break;
           }
           // CLEANUP-2: Legacy summary tools handlers retirés (generate_trace_summary, generate_cluster_summary, get_conversation_synthesis)
           // Remplacés par roosync_summarize (CONS-12)
           // #519: Legacy export tools handlers retirés (CONS-10) - utiliser export_data et export_config
            case toolExports.getRawConversationTool.definition.name:
                result = await toolExports.getRawConversationTool.handler(args as any);
                break;
          // CLEANUP-2: getConversationSynthesisTool handler retiré (remplacé par roosync_summarize)
          // CONS-9: export_task_tree_markdown retiré (remplacé par task_export action='markdown')

          // Diagnostic Tools - WP4
          case toolExports.analyze_roosync_problems.name:
              result = await toolExports.analyzeRooSyncProblems(args as any) as any;
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
          case 'roosync_diagnose':
              try {
                  const roosyncResult = await toolExports.roosyncDiagnose(args as any);
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
          // CONS-5: Consolidated decision tools (5→2)
          case 'roosync_decision':
              try {
                  const roosyncResult = await toolExports.roosyncDecision(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_decision_info':
              try {
                  const roosyncResult = await toolExports.roosyncDecisionInfo(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          // Consolidated tools: CallTool handlers for CONS-2/3/4/6 consolidated tools
          case 'roosync_baseline':
              try {
                  const roosyncResult = await toolExports.roosync_baseline(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_config':
              try {
                  const roosyncResult = await toolExports.roosyncConfig(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_inventory':
              try {
                  const invResult = await toolExports.inventoryTool.execute(args as any, {} as any);
                  if (invResult.success) {
                      result = { content: [{ type: 'text', text: JSON.stringify(invResult.data, null, 2) }] };
                  } else {
                      result = { content: [{ type: 'text', text: `Error: ${invResult.error?.message}` }], isError: true };
                  }
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          case 'roosync_machines':
              try {
                  const machResult = await toolExports.roosyncMachines(args as any);
                  if (machResult.success) {
                      result = { content: [{ type: 'text', text: JSON.stringify(machResult.data, null, 2) }] };
                  } else {
                      result = { content: [{ type: 'text', text: `Error: ${machResult.error?.message}` }], isError: true };
                  }
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          // CONS-#443 Groupe 1: Outil consolidé de heartbeat (2→1)
          case 'roosync_heartbeat':
              try {
                  const heartbeatResult = await toolExports.roosyncHeartbeat(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(heartbeatResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          // CONS-1: Outils messagerie consolidés (6→3)
           case 'roosync_send':
               try {
                   result = await toolExports.roosyncSend(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           case 'roosync_read':
               try {
                   result = await toolExports.roosyncRead(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           case 'roosync_manage':
               try {
                   result = await toolExports.roosyncManage(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
          // #613 ISS-1: Cleanup en masse des messages RooSync
           case 'roosync_cleanup_messages':
               try {
                   result = await toolExports.cleanupMessages(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
          // [REMOVED] 6 legacy messaging wrappers — #625 dead code cleanup (not in alwaysAllow)
           // roosync_send_message, roosync_read_inbox, roosync_get_message,
           // roosync_mark_message_read, roosync_archive_message, roosync_reply_message
           // Replaced by: roosync_send, roosync_read, roosync_manage
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
           // #546: Dashboard hiérarchique
           case 'roosync_update_dashboard':
               try {
                   const roosyncResult = await toolExports.roosyncUpdateDashboard(args as any);
                   result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           // CONS-#443 Groupe 2: Consolidation sync events (sync_on_offline + sync_on_online → roosync_sync_event)
           case 'roosync_sync_event':
               try {
                   const syncEventResult = await toolExports.roosyncSyncEvent(args as any);
                   result = { content: [{ type: 'text', text: JSON.stringify(syncEventResult, null, 2) }] };
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           // CONS-#443 Groupe 3: Consolidation MCP management (manage_mcp_settings + rebuild_and_restart_mcp + touch_mcp_settings → roosync_mcp_management)
           case 'roosync_mcp_management':
               try {
                   const mcpManagementResult = await toolExports.roosyncMcpManagement(args as any);
                   result = { content: [{ type: 'text', text: JSON.stringify(mcpManagementResult, null, 2) }] };
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           // #595/#603: roosync_modes_management removed — modes-management.ts is an internal API only.
           // Use roosync_config(targets: ["modes-yaml"]) for mode config sync instead.
           // CONS-#443 Groupe 4: Consolidation Storage management (storage_info + maintenance → roosync_storage_management)
           case 'roosync_storage_management':
               try {
                   const storageManagementResult = await toolExports.roosyncStorageManagement(args as any, state.conversationCache, state);
                   result = { content: [{ type: 'text', text: JSON.stringify(storageManagementResult, null, 2) }] };
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