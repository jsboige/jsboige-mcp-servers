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
                toolExports.detectStorageTool.definition,
                toolExports.getStorageStatsTool.definition,
                toolExports.listConversationsTool.definition,
                {
                    name: 'touch_mcp_settings',
                    description: 'Touche le fichier de paramètres pour forcer le rechargement des MCPs Roo.',
                    inputSchema: { type: 'object', properties: {}, required: [] },
                },
                toolExports.buildSkeletonCacheDefinition,
                toolExports.getTaskTreeTool,
                toolExports.debugTaskParsingTool,
                toolExports.searchTasksSemanticTool.definition,
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
                toolExports.diagnoseConversationBomTool.definition,
                toolExports.repairConversationBomTool.definition,
                toolExports.exportTasksXmlTool,
                toolExports.exportConversationXmlTool,
                toolExports.exportProjectXmlTool,
                toolExports.configureXmlExportTool,
                {
                    name: toolExports.generateTraceSummaryTool.name,
                    description: toolExports.generateTraceSummaryTool.description,
                    inputSchema: toolExports.generateTraceSummaryTool.inputSchema,
                },
                {
                    name: toolExports.generateClusterSummaryTool.name,
                    description: toolExports.generateClusterSummaryTool.description,
                    inputSchema: toolExports.generateClusterSummaryTool.inputSchema,
                },
                {
                    name: toolExports.exportConversationJsonTool.name,
                    description: toolExports.exportConversationJsonTool.description,
                    inputSchema: toolExports.exportConversationJsonTool.inputSchema,
                },
                {
                    name: toolExports.exportConversationCsvTool.name,
                    description: toolExports.exportConversationCsvTool.description,
                    inputSchema: toolExports.exportConversationCsvTool.inputSchema,
                },
                toolExports.viewTaskDetailsTool.definition,
                toolExports.getRawConversationTool.definition,
                {
                    name: toolExports.getConversationSynthesisTool.name,
                    description: toolExports.getConversationSynthesisTool.description,
                    inputSchema: toolExports.getConversationSynthesisTool.inputSchema,
                },
                toolExports.exportTaskTreeMarkdownTool,
                // RooSync tools - Batch 6 synchronization
                ...toolExports.roosyncTools,
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
            case 'build_skeleton_cache':
                result = await toolExports.handleBuildSkeletonCache(args as any, state.conversationCache);
                break;
            case 'get_task_tree':
                result = await toolExports.handleGetTaskTree(args as any, state.conversationCache, async () => { await ensureSkeletonCacheIsFresh(); });
                break;
            case toolExports.viewConversationTree.name:
                result = await toolExports.viewConversationTree.handler(args as any, state.conversationCache);
                break;
            case toolExports.viewTaskDetailsTool.definition.name:
                result = await toolExports.viewTaskDetailsTool.handler(args as any, state.conversationCache);
                break;
            case toolExports.searchTasksSemanticTool.definition.name:
                result = await toolExports.searchTasksSemanticTool.handler(
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
           case 'debug_task_parsing':
               result = await toolExports.handleDebugTaskParsing(args as any);
               break;
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
           case toolExports.generateTraceSummaryTool.name: {
               const summaryText = await toolExports.handleGenerateTraceSummary(args as any, async (id: string) => {
                   return state.conversationCache.get(id) || null;
               });
               result = { content: [{ type: 'text', text: summaryText }] };
               break;
           }
           case toolExports.generateClusterSummaryTool.name: {
               const clusterText = await toolExports.handleGenerateClusterSummary(args as any, async (id: string) => {
                   return state.conversationCache.get(id) || null;
               });
               result = { content: [{ type: 'text', text: clusterText }] };
               break;
           }
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
          case toolExports.getConversationSynthesisTool.name: {
              const synthResult = await toolExports.handleGetConversationSynthesis(args as any, async (id: string) => {
                  return state.conversationCache.get(id) || null;
              });
              result = { content: [{ type: 'text', text: typeof synthResult === 'string' ? synthResult : JSON.stringify(synthResult, null, 2) }] };
              break;
          }
          case 'export_task_tree_markdown':
              result = await toolExports.handleExportTaskTreeMarkdown(
                  args as any,
                  async (treeArgs: any) => await toolExports.handleGetTaskTree(treeArgs, state.conversationCache, async () => { await ensureSkeletonCacheIsFresh(); }),
                  async () => { await ensureSkeletonCacheIsFresh(); },
                  state.conversationCache
              );
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
          default:
              throw new Error(`Tool not found: ${name}`);
      }

        return result;
    });
}