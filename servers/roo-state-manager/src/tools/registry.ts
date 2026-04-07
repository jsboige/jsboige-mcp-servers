/**
 * Registre central des outils MCP
 *
 * Ce fichier centralise l'enregistrement de tous les outils du serveur MCP.
 * Il gère le mapping entre les noms d'outils et leurs handlers.
 *
 * #1145 perf: Barrel import broken — ListTools uses static tool-definitions.ts
 * (zero handler imports), CallTool uses per-case dynamic imports.
 * Startup: tool-definitions.ts loads in <1ms. Handler modules load on first call.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ServerState } from '../services/state-manager.service.js';
import { allToolDefinitions } from './tool-definitions.js';
import { GenericError, GenericErrorCode } from '../types/errors.js';
import { RooStorageDetector } from '../utils/roo-storage-detector.js';
import { ClaudeStorageDetector } from '../utils/claude-storage-detector.js';
import * as path from 'path';
import { existsSync } from 'fs';
import { CACHE_CONFIG } from '../config/server-config.js';
import { loadFullSkeleton } from '../services/background-services.js';
import { createLogger } from '../utils/logger.js';

const registryLogger = createLogger('ToolRegistry');

/**
 * Enregistre le handler pour ListTools
 * Uses static tool-definitions.ts — zero handler imports, instant startup.
 */
export function registerListToolsHandler(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: allToolDefinitions as any[],
        };
    });
}

/**
 * Enregistre le handler pour CallTool avec tous les outils
 * Each case does its own dynamic import — only loads the module it needs.
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
        // Temporary cast: cache holds SkeletonHeader but many callees still expect ConversationSkeleton.
        // Safe because those callees only read header fields. Will be fixed in follow-up refactor.
        const cache = state.conversationCache as any as Map<string, import('../types/conversation.js').ConversationSkeleton>;

        const toolCallStart = Date.now();
        let result: CallToolResult;

        try {
        switch (name) {
           // CONS-13: Outil Storage consolidé
           case 'storage_info': {
               const m = await import('./storage/index.js');
               result = await m.handleStorageInfo(args as any);
               break;
           }
           // [DEPRECATED] list_conversations → conversation_browser action='list'
           case 'list_conversations': {
               const m = await import('./conversation/list-conversations.tool.js');
               result = await m.listConversationsTool.handler(args as any, cache);
               break;
           }
           // #519: Anciens outils storage retirés (detect_storage, get_storage_stats)
            case 'touch_mcp_settings':
                result = await handleTouchMcpSettings();
                break;
            // CONS-13: Outil Maintenance consolidé
            case 'maintenance': {
                const m = await import('./maintenance/index.js');
                result = await m.handleMaintenance(args as any, cache, state);
                break;
            }
            // [REMOVED] build_skeleton_cache — #625 dead code cleanup (not in alwaysAllow)
            // CONS-X (#457): Outil consolidé conversation_browser
            case 'conversation_browser': {
                const m = await import('./conversation/conversation-browser.js');
                result = await m.handleConversationBrowser(
                    args as any,
                    cache,
                    async () => { await ensureSkeletonCacheIsFresh(); },
                    CACHE_CONFIG.DEFAULT_WORKSPACE,  // contextWorkspace: utilise process.cwd() ou WORKSPACE_PATH
                    async (id: string) => {
                        // 1. Try RAM cache first (cache holds SkeletonHeader, no sequence)
                        const cached = cache.get(id);
                        if (cached) {
                            // #1110: Cache holds headers only — load full skeleton on demand
                            if (cached.metadata.messageCount > 0) {
                                const full = await loadFullSkeleton(id, cache);
                                if (full) return full;
                                // Fall through to disk scan if full skeleton load fails
                            } else {
                                // Empty conversation — return header as skeleton (no sequence needed)
                                return { ...cached, sequence: [] } as any;
                            }
                        }
                        // 2. Claude Code sessions (taskId starts with 'claude-')
                        if (id.startsWith('claude-')) {
                            try {
                                const skeleton = await ClaudeStorageDetector.findConversationById(id);
                                if (skeleton) {
                                    cache.set(id, skeleton);
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
                                        cache.set(id, skeleton);
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
                                    if (skeleton && !cache.has(rootId)) {
                                        cache.set(rootId, skeleton);
                                    }
                                }
                            }
                        } catch { /* ignore disk errors */ }
                        const allTasks = Array.from(cache.values());
                        return allTasks.filter(task => task.metadata?.parentTaskId === rootId);
                    },
                    state // Pass serverState for rebuild action
                );
                break;
            }
            // [DEPRECATED] CONS-9: task_browse conservé pour backward compat
            case 'task_browse': {
                const m = await import('./task/browse.js');
                result = await m.handleTaskBrowse(
                    args as any,
                    cache,
                    async () => { await ensureSkeletonCacheIsFresh(); },
                    CACHE_CONFIG.DEFAULT_WORKSPACE
                );
                break;
            }
            case 'task_export': {
                const m = await import('./task/export.js');
                result = await m.handleTaskExport(
                    args as any,
                    cache,
                    async () => { await ensureSkeletonCacheIsFresh(); }
                );
                break;
            }
            // [DEPRECATED] #457: view_conversation_tree conservé pour backward compat
            case 'view_conversation_tree': {
                const m = await import('./view-conversation-tree.js');
                result = await m.viewConversationTree.handler(args as any, cache);
                break;
            }
            case 'view_task_details': {
                const m = await import('./conversation/view-details.tool.js');
                result = await m.viewTaskDetailsTool.handler(args as any, cache);
                break;
            }
            // CONS-11: Outil unifié roosync_search
            case 'roosync_search': {
                const m = await import('./search/roosync-search.tool.js');
                const mFallback = await import('./search/search-fallback.tool.js');
                const mDiagnose = await import('./indexing/diagnose-index.tool.js');
                result = await m.handleRooSyncSearch(
                    args as any,
                    cache,
                    ensureSkeletonCacheIsFresh,
                    mFallback.handleSearchTasksSemanticFallback,
                    () => mDiagnose.handleDiagnoseSemanticIndex(cache)
                );
                break;
            }
            // #452 Phase 2: Recherche sémantique dans le code workspace
            case 'codebase_search': {
                const m = await import('./search/search-codebase.tool.js');
                result = await m.handleCodebaseSearch(args as any);
                break;
            }
            // CONS-11: Outil unifié roosync_indexing
            case 'roosync_indexing': {
                const m = await import('./indexing/roosync-indexing.tool.js');
                const mMaint = await import('./maintenance/index.js');
                result = await m.handleRooSyncIndexing(
                    args as any,
                    cache,
                    ensureSkeletonCacheIsFresh,
                    saveSkeletonToDisk,
                    state.qdrantIndexQueue,
                    (enabled: boolean) => { state.isQdrantIndexingEnabled = enabled; },
                    mMaint.handleRebuildTaskIndex,
                    {
                        qdrantIndexQueue: state.qdrantIndexQueue,
                        qdrantIndexInterval: state.qdrantIndexInterval,
                        isQdrantIndexingEnabled: state.isQdrantIndexingEnabled,
                        indexingMetrics: state.indexingMetrics
                    }
                );
                break;
            }
            // [REMOVED] search_tasks_by_content — #625 dead code cleanup (not in alwaysAllow)
            case 'debug_analyze_conversation': {
                const m = await import('./conversation/debug-analyze.tool.js');
                result = await m.debugAnalyzeTool.handler(args as any, cache);
                break;
            }
            // CONS-9: debug_task_parsing retiré (remplacé par task_export action='debug')
            case 'read_vscode_logs': {
                const m = await import('./read-vscode-logs.js');
                result = await m.readVscodeLogs.handler(args as any);
                break;
            }
            case 'manage_mcp_settings': {
                const m = await import('./manage-mcp-settings.js');
                result = await m.manageMcpSettings.handler(args as any);
                break;
            }
            case 'index_task_semantic': {
                const m = await import('./indexing/index.js');
                result = await m.indexTaskSemanticTool.handler(
                    args as any,
                    cache,
                    ensureSkeletonCacheIsFresh
                );
                break;
            }
            case 'reset_qdrant_collection': {
                const m = await import('./indexing/index.js');
                result = await m.resetQdrantCollectionTool.handler(
                    args as any,
                    cache,
                    saveSkeletonToDisk,
                    state.qdrantIndexQueue,
                    (enabled: boolean) => { state.isQdrantIndexingEnabled = enabled; }
                );
                break;
            }
            case 'rebuild_and_restart_mcp': {
                const m = await import('./rebuild-and-restart.js');
                result = await m.rebuildAndRestart.handler(args as any);
                break;
            }
            case 'get_mcp_best_practices': {
                const m = await import('./get_mcp_best_practices.js');
                result = await m.getMcpBestPractices.handler();
                break;
            }
            // #814: rebuild_task_index redirects to new implementation (backward compat)
            case 'rebuild_task_index': {
                const m = await import('./maintenance/index.js');
                result = await m.handleRebuildTaskIndex(args as any);
                break;
            }
            case 'diagnose_conversation_bom': {
                const m = await import('./repair/index.js');
                result = await m.diagnoseConversationBomTool.handler(args as any);
                break;
            }
            case 'repair_conversation_bom': {
                const m = await import('./repair/index.js');
                result = await m.repairConversationBomTool.handler(args as any);
                break;
            }

           // CONS-10: Outils Export consolidés (6→2)
           case 'export_data': {
               const m = await import('./export/export-data.js');
               result = await m.handleExportData(
                   args as any,
                   cache,
                   state.xmlExporterService,
                   async (options?: { workspace?: string }) => { await ensureSkeletonCacheIsFresh(options); },
                   async (id: string) => cache.get(id) || null
               );
               break;
           }
           case 'export_config': {
               const m = await import('./export/export-config.js');
               result = await m.handleExportConfig(args as any, state.exportConfigManager);
               break;
           }

           // [DEPRECATED] CONS-12→#457: roosync_summarize conservé pour backward compat
           case 'roosync_summarize': {
               const m = await import('./summary/roosync-summarize.tool.js');
               const summaryResult = await m.handleRooSyncSummarize(
                   args as any,
                   async (id: string) => {
                       // 1. Try RAM cache first
                       const cached = cache.get(id);
                       if (cached) return cached;
                       // 2. Fallback: scan disk for Roo conversations (#449)
                       try {
                           const locations = await RooStorageDetector.detectStorageLocations();
                           for (const loc of locations) {
                               const taskPath = path.join(loc, id);
                               if (existsSync(taskPath)) {
                                   const skeleton = await RooStorageDetector.analyzeConversation(id, taskPath);
                                   if (skeleton) {
                                       cache.set(id, skeleton);
                                       return skeleton;
                                   }
                               }
                           }
                       } catch { /* disk fallback failed, return null */ }
                       return null;
                   },
                   async (rootId: string) => {
                       // Fonction findChildTasks pour le mode cluster
                       const allTasks = Array.from(cache.values());
                       // Also check disk for child tasks (#449)
                       try {
                           const locations = await RooStorageDetector.detectStorageLocations();
                           for (const loc of locations) {
                               const taskPath = path.join(loc, rootId);
                               if (existsSync(taskPath)) {
                                   const skeleton = await RooStorageDetector.analyzeConversation(rootId, taskPath);
                                   if (skeleton && !cache.has(rootId)) {
                                       cache.set(rootId, skeleton);
                                   }
                               }
                           }
                       } catch { /* ignore disk errors */ }
                       const allTasksUpdated = Array.from(cache.values());
                       return allTasksUpdated.filter(task => task.metadata?.parentTaskId === rootId);
                   }
               );
               result = { content: [{ type: 'text', text: summaryResult }] };
               break;
           }
           // CLEANUP-2: Legacy summary tools handlers retirés (generate_trace_summary, generate_cluster_summary, get_conversation_synthesis)
           // Remplacés par roosync_summarize (CONS-12)
           // #519: Legacy export tools handlers retirés (CONS-10) - utiliser export_data et export_config
            case 'get_raw_conversation': {
                const m = await import('./conversation/get-raw.tool.js');
                result = await m.getRawConversationTool.handler(args as any);
                break;
            }
          // CLEANUP-2: getConversationSynthesisTool handler retiré (remplacé par roosync_summarize)
          // CONS-9: export_task_tree_markdown retiré (remplacé par task_export action='markdown')

          // Diagnostic Tools - WP4
          case 'analyze_roosync_problems': {
              const m = await import('./diagnostic/analyze_problems.js');
              result = await m.analyzeRooSyncProblems(args as any) as any;
              break;
          }

          // RooSync tools - Batch 6 synchronization
          case 'roosync_get_status': {
              try {
                  const m = await import('./roosync/get-status.js');
                  const roosyncResult = await m.roosyncGetStatus(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_compare_config': {
              try {
                  const m = await import('./roosync/compare-config.js');
                  const roosyncResult = await m.roosyncCompareConfig(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_list_diffs': {
              try {
                  const m = await import('./roosync/list-diffs.js');
                  const roosyncResult = await m.roosyncListDiffs(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_get_decision_details': {
              try {
                  const m = await import('./roosync/get-decision-details.js');
                  const roosyncResult = await m.roosyncGetDecisionDetails(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_approve_decision': {
              try {
                  const m = await import('./roosync/approve-decision.js');
                  const roosyncResult = await m.roosyncApproveDecision(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_reject_decision': {
              try {
                  const m = await import('./roosync/reject-decision.js');
                  const roosyncResult = await m.roosyncRejectDecision(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_apply_decision': {
              try {
                  const m = await import('./roosync/apply-decision.js');
                  const roosyncResult = await m.roosyncApplyDecision(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_rollback_decision': {
              try {
                  const m = await import('./roosync/rollback-decision.js');
                  const roosyncResult = await m.roosyncRollbackDecision(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_init': {
              try {
                  const m = await import('./roosync/roosync_init.js');
                  const roosyncResult = await m.roosyncInit(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_update_baseline': {
              try {
                  const m = await import('./roosync/update-baseline.js');
                  const roosyncResult = await m.roosyncUpdateBaseline(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_manage_baseline': {
              try {
                  const m = await import('./roosync/manage-baseline.js');
                  const roosyncResult = await m.roosync_manage_baseline(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_diagnose': {
              try {
                  const m = await import('./roosync/diagnose.js');
                  const roosyncResult = await m.roosyncDiagnose(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_export_baseline': {
              try {
                  const m = await import('./roosync/export-baseline.js');
                  const roosyncResult = await m.roosync_export_baseline(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_collect_config': {
              try {
                  const m = await import('./roosync/collect-config.js');
                  const roosyncResult = await m.roosyncCollectConfig(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_publish_config': {
              try {
                  const m = await import('./roosync/publish-config.js');
                  const roosyncResult = await m.roosyncPublishConfig(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_apply_config': {
              try {
                  const m = await import('./roosync/apply-config.js');
                  const roosyncResult = await m.roosyncApplyConfig(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          // CONS-5: Consolidated decision tools (5→2)
          case 'roosync_decision': {
              try {
                  const m = await import('./roosync/decision.js');
                  const roosyncResult = await m.roosyncDecision(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_decision_info': {
              try {
                  const m = await import('./roosync/decision-info.js');
                  const roosyncResult = await m.roosyncDecisionInfo(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          // Consolidated tools: CallTool handlers for CONS-2/3/4/6 consolidated tools
          case 'roosync_baseline': {
              try {
                  const m = await import('./roosync/baseline.js');
                  const roosyncResult = await m.roosync_baseline(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_config': {
              try {
                  const m = await import('./roosync/config.js');
                  const roosyncResult = await m.roosyncConfig(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_inventory': {
              try {
                  const m = await import('./roosync/inventory.js');
                  const invResult = await m.inventoryTool.execute(args as any, {} as any);
                  if (invResult.success) {
                      result = { content: [{ type: 'text', text: JSON.stringify(invResult.data, null, 2) }] };
                  } else {
                      result = { content: [{ type: 'text', text: `Error: ${invResult.error?.message}` }], isError: true };
                  }
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          case 'roosync_machines': {
              try {
                  const m = await import('./roosync/machines.js');
                  const machResult = await m.roosyncMachines(args as any);
                  if (machResult.success) {
                      result = { content: [{ type: 'text', text: JSON.stringify(machResult.data, null, 2) }] };
                  } else {
                      result = { content: [{ type: 'text', text: `Error: ${machResult.error?.message}` }], isError: true };
                  }
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          // CONS-#443 Groupe 1: Outil consolidé de heartbeat (2→1)
          case 'roosync_heartbeat': {
              try {
                  const m = await import('./roosync/heartbeat.js');
                  const heartbeatResult = await m.roosyncHeartbeat(args as any);
                  result = { content: [{ type: 'text', text: JSON.stringify(heartbeatResult, null, 2) }] };
              } catch (error) {
                  result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
              }
              break;
          }
          // CONS-1: Outils messagerie consolidés (6→3)
           case 'roosync_send': {
               try {
                   const m = await import('./roosync/send.js');
                   result = await m.roosyncSend(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           case 'roosync_read': {
               try {
                   const m = await import('./roosync/read.js');
                   result = await m.roosyncRead(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           case 'roosync_manage': {
               try {
                   const m = await import('./roosync/manage.js');
                   result = await m.roosyncManage(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
          // #613 ISS-1: Cleanup en masse des messages RooSync
           case 'roosync_cleanup_messages': {
               try {
                   const m = await import('./roosync/cleanup.js');
                   result = await m.cleanupMessages(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
          // [REMOVED] 6 legacy messaging wrappers — #625 dead code cleanup (not in alwaysAllow)
           // roosync_send_message, roosync_read_inbox, roosync_get_message,
           // roosync_mark_message_read, roosync_archive_message, roosync_reply_message
           // Replaced by: roosync_send, roosync_read, roosync_manage
           // CONS-7: Outil consolidé gestion pièces jointes
           case 'roosync_attachments': {
               try {
                   const m = await import('./roosync/roosync-attachments.tool.js');
                   result = await m.roosyncAttachments(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           // #674: Outils legacy (backward compat — utiliser roosync_attachments à la place)
           case 'roosync_list_attachments': {
               try {
                   const m = await import('./roosync/roosync-attachments.tool.js');
                   result = await m.roosyncListAttachments(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           case 'roosync_get_attachment': {
               try {
                   const m = await import('./roosync/roosync-attachments.tool.js');
                   result = await m.roosyncGetAttachment(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           case 'roosync_delete_attachment': {
               try {
                   const m = await import('./roosync/roosync-attachments.tool.js');
                   result = await m.roosyncDeleteAttachment(args as any) as CallToolResult;
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           // NOUVEAU: Outil d'inventaire
           case 'roosync_get_machine_inventory': {
               try {
                   const m = await import('./roosync/get-machine-inventory.js');
                   const invResult = await m.getMachineInventoryTool.execute(args as any, {} as any);
                   if (invResult.success) {
                       result = { content: [{ type: 'text', text: JSON.stringify(invResult.data, null, 2) }] };
                   } else {
                       result = { content: [{ type: 'text', text: `Error: ${invResult.error?.message}` }], isError: true };
                   }
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           // NOUVEAU: Outil de refresh dashboard (T3.17)
           case 'roosync_refresh_dashboard': {
               try {
                   const m = await import('./roosync/refresh-dashboard.js');
                   const roosyncResult = await m.roosyncRefreshDashboard(args as any);
                   result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           // #546: Dashboard hiérarchique
           case 'roosync_update_dashboard': {
               try {
                   const m = await import('./roosync/update-dashboard.js');
                   const roosyncResult = await m.roosyncUpdateDashboard(args as any);
                   result = { content: [{ type: 'text', text: JSON.stringify(roosyncResult, null, 2) }] };
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           // #675: Dashboards markdown partagés cross-machine
           case 'roosync_dashboard': {
               try {
                   const m = await import('./roosync/dashboard.js');
                   const dashboardResult = await m.roosyncDashboard(args as any);
                   result = { content: [{ type: 'text', text: JSON.stringify(dashboardResult, null, 2) }] };
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           // CONS-#443 Groupe 2: Consolidation sync events (sync_on_offline + sync_on_online → roosync_sync_event)
           case 'roosync_sync_event': {
               try {
                   const m = await import('./roosync/sync-event.js');
                   const syncEventResult = await m.roosyncSyncEvent(args as any);
                   result = { content: [{ type: 'text', text: JSON.stringify(syncEventResult, null, 2) }] };
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           // CONS-#443 Groupe 3: Consolidation MCP management (manage_mcp_settings + rebuild_and_restart_mcp + touch_mcp_settings → roosync_mcp_management)
           case 'roosync_mcp_management': {
               try {
                   const m = await import('./roosync/mcp-management.js');
                   const mcpManagementResult = await m.roosyncMcpManagement(args as any);
                   result = { content: [{ type: 'text', text: JSON.stringify(mcpManagementResult, null, 2) }] };
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           // #595/#603: roosync_modes_management removed — modes-management.ts is an internal API only.
           // Use roosync_config(targets: ["modes-yaml"]) for mode config sync instead.
           // CONS-#443 Groupe 4: Consolidation Storage management (storage_info + maintenance → roosync_storage_management)
           case 'roosync_storage_management': {
               try {
                   const m = await import('./roosync/storage-management.js');
                   const storageManagementResult = await m.roosyncStorageManagement(args as any, cache, state);
                   result = { content: [{ type: 'text', text: JSON.stringify(storageManagementResult, null, 2) }] };
               } catch (error) {
                   result = { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
               }
               break;
           }
           default:
               throw new GenericError(`Tool not found: ${name}`, GenericErrorCode.INVALID_ARGUMENT);
       }

        } catch (error) {
            const elapsed = Date.now() - toolCallStart;
            registryLogger.error(`Tool call FAILED: ${name}`, {
                tool: name,
                elapsed: `${elapsed}ms`,
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3).join(' | ') : undefined
            });
            throw error;
        }

        // Log successful tool calls with duration
        const elapsed = Date.now() - toolCallStart;
        const isError = result?.isError === true;
        if (isError) {
            registryLogger.warn(`Tool call returned error: ${name}`, { tool: name, elapsed: `${elapsed}ms` });
        } else if (elapsed > 5000) {
            registryLogger.warn(`Tool call SLOW: ${name}`, { tool: name, elapsed: `${elapsed}ms` });
        } else {
            registryLogger.info(`Tool call OK: ${name}`, { tool: name, elapsed: `${elapsed}ms` });
        }

        return result;
    });
}
