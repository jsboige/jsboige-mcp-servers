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
                // CONS-13: Outil Storage consolidé (2→1)
                toolExports.storageInfoTool.definition,
                // CLEANUP-3: detect_storage, get_storage_stats, list_conversations retirés de ListTools
                // (CallTool handlers conservés pour backward compat)
                {
                    name: 'touch_mcp_settings',
                    description: 'Touche le fichier de paramètres pour forcer le rechargement des MCPs Roo.',
                    inputSchema: { type: 'object', properties: {}, required: [] },
                },
                // CONS-13: Outil Maintenance consolidé (3→1)
                toolExports.maintenanceToolDefinition,
                // CLEANUP-3: build_skeleton_cache retiré de ListTools (backward compat via CallTool)
                // CONS-X (#457): Outil consolidé conversation_browser (task_browse + view_conversation_tree + roosync_summarize → 1)
                toolExports.conversationBrowserTool,
                // [DEPRECATED] task_browse, view_conversation_tree, roosync_summarize retirés de ListTools
                // (CallTool handlers conservés pour backward compat)
                toolExports.taskExportTool,
                // CONS-11: Outils Search/Indexing consolidés (4→2)
                toolExports.roosyncSearchTool,
                toolExports.roosyncIndexingTool,
                // CLEANUP-3: search_tasks_by_content, debug_analyze retirés de ListTools (backward compat via CallTool)
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
                // CLEANUP-3: index_task_semantic, reset_qdrant_collection, rebuild_task_index_fixed retirés de ListTools
                // (remplacés par roosync_indexing, CallTool handlers conservés pour backward compat)
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
                // CLEANUP-3: diagnose_conversation_bom, repair_conversation_bom retirés de ListTools
                // (remplacés par maintenance action=diagnose_bom/repair_bom, CallTool handlers conservés)
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
    handleExportConversationJson: (args: any) => Promise<CallToolResult>,
    handleExportConversationCsv: (args: any) => Promise<CallToolResult>,
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
                        // 2. Fallback: scan disk for Roo conversations
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
                    }
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
          // [DEPRECATED] Legacy messaging tools - backward compat via CONS-1
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