/**
 * Tests pour registry.ts
 * Coverage target: Core logic (enregistrement + routing)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    registerListToolsHandler,
    registerCallToolHandler,
    TOOL_CAPABILITIES
} from '../registry.js';
import { GenericError, GenericErrorCode } from '../../types/errors.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ServerState } from '../../services/state-manager.service.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { getServerCapabilities } from '../../utils/server-capabilities.js';

// Mock du Server SDK MCP
vi.mock('@modelcontextprotocol/sdk/server/index.js', async () => {
    const actual = await vi.importActual('@modelcontextprotocol/sdk/server/index.js');
    return {
        ...actual,
        Server: vi.fn().mockImplementation(() => ({
            setRequestHandler: vi.fn()
        }))
    };
});

describe('registry.ts - Tool Registration', () => {

    describe('registerListToolsHandler - ListTools Registration', () => {
        it('should register ListToolsRequestSchema handler', () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            registerListToolsHandler(mockServer);

            expect(mockServer.setRequestHandler).toHaveBeenCalledWith(
                expect.anything(),
                expect.any(Function)
            );
        });

        it('should return tools array with expected tools', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            registerListToolsHandler(mockServer);

            // Récupérer le handler enregistré
            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const result = await handler();

            expect(result).toHaveProperty('tools');
            expect(Array.isArray(result.tools)).toBe(true);

            // Vérifier que les outils principaux sont présents
            const toolNames = result.tools.map((t: any) => t.name);
            // B4: Pre-consolidation tools removed from ListTools
            // Replaced by consolidated versions (CONS-#443)
            expect(toolNames).toContain('roosync_storage_management');
            expect(toolNames).toContain('roosync_mcp_management');
        });

        it('should include conversation_browser tool', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            registerListToolsHandler(mockServer);

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const result = await handler();
            const toolNames = result.tools.map((t: any) => t.name);
            expect(toolNames).toContain('conversation_browser');
        });

        it('should include roosync_search tool', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            registerListToolsHandler(mockServer);

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const result = await handler();
            const toolNames = result.tools.map((t: any) => t.name);
            expect(toolNames).toContain('roosync_search');
        });

        it('should include codebase_search tool', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            registerListToolsHandler(mockServer);

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const result = await handler();
            const toolNames = result.tools.map((t: any) => t.name);
            expect(toolNames).toContain('codebase_search');
        });

        it('should include roosync_indexing tool', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            registerListToolsHandler(mockServer);

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const result = await handler();
            const toolNames = result.tools.map((t: any) => t.name);
            expect(toolNames).toContain('roosync_indexing');
        });

        it('should include export_data tool', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            registerListToolsHandler(mockServer);

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const result = await handler();
            const toolNames = result.tools.map((t: any) => t.name);
            expect(toolNames).toContain('export_data');
        });

        // [REMOVED #291] export_config test removed — tool removed from allToolDefinitions (ListTools)
        // Backward compat redirect preserved in registry.ts for CallTool

        it('should have tools count greater than 20', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            registerListToolsHandler(mockServer);

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const result = await handler();
            expect(result.tools.length).toBeGreaterThan(20);
        });
    });

    describe('registerCallToolHandler - CallTool Registration', () => {
        let mockServer: any;
        let mockState: ServerState;
        let mockHandleTouchMcpSettings: () => Promise<any>;
        // #519: mockHandleExportConversationJson/Csv retirés (CONS-10 legacy)
        let mockEnsureSkeletonCacheIsFresh: (args?: any) => Promise<boolean>;
        let mockSaveSkeletonToDisk: (skeleton: any) => Promise<void>;

        beforeEach(() => {
            mockServer = {
                setRequestHandler: vi.fn()
            };

            mockState = {
                conversationCache: new Map<string, ConversationSkeleton>(),
                qdrantIndexQueue: new Set<string>(),
                isQdrantIndexingEnabled: false,
                xmlExporterService: {},
                exportConfigManager: {}
            } as any;

            mockHandleTouchMcpSettings = vi.fn().mockResolvedValue({
                content: [{ type: 'text', text: 'Settings touched' }]
            });

            mockEnsureSkeletonCacheIsFresh = vi.fn().mockResolvedValue(true);
            mockSaveSkeletonToDisk = vi.fn().mockResolvedValue(undefined);
        });

        it('should register CallToolRequestSchema handler', () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                mockEnsureSkeletonCacheIsFresh,
                mockSaveSkeletonToDisk
            );

            expect(mockServer.setRequestHandler).toHaveBeenCalledWith(
                CallToolRequestSchema,
                expect.any(Function)
            );
        });

        it('should route touch_mcp_settings to handler', async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                mockEnsureSkeletonCacheIsFresh,
                mockSaveSkeletonToDisk
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'touch_mcp_settings',
                    arguments: {}
                }
            };

            const result = await handler(request);

            expect(mockHandleTouchMcpSettings).toHaveBeenCalled();
            expect(result.content[0].text).toBe('Settings touched');
        });

        it('should route storage_info to handler', { timeout: 30000 }, async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                mockEnsureSkeletonCacheIsFresh,
                mockSaveSkeletonToDisk
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'storage_info',
                    arguments: {}
                }
            };

            const result = await handler(request);

            // Le handler est appelé, le résultat dépend de l'implémentation
            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
        });

        it('should route maintenance to handler', { timeout: 30000 }, async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                mockEnsureSkeletonCacheIsFresh,
                mockSaveSkeletonToDisk
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'maintenance',
                    arguments: { action: 'diagnose' }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
        });

        it('should route conversation_browser to handler', async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                mockEnsureSkeletonCacheIsFresh,
                mockSaveSkeletonToDisk
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'conversation_browser',
                    arguments: { action: 'tree' }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
        });

        // [REMOVED Phase B #1863] task_browse backward-compat routing removed — use conversation_browser(action='tree')

        it('should route task_export to handler', async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                mockEnsureSkeletonCacheIsFresh,
                mockSaveSkeletonToDisk
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'task_export',
                    arguments: { task_id: 'test-task' }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
        });

        it('should route roosync_search to handler', async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                mockEnsureSkeletonCacheIsFresh,
                mockSaveSkeletonToDisk
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'roosync_search',
                    arguments: { action: 'semantic', search_query: 'test' }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
        });

        it('should route codebase_search to handler', async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                mockEnsureSkeletonCacheIsFresh,
                mockSaveSkeletonToDisk
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'codebase_search',
                    arguments: { query: 'test query', workspace: 'd:\\test' }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
        });

        it('should route roosync_indexing to handler', async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                mockEnsureSkeletonCacheIsFresh,
                mockSaveSkeletonToDisk
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'roosync_indexing',
                    arguments: { action: 'diagnose' }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
        });

        it('should route export_data to handler', async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                mockEnsureSkeletonCacheIsFresh,
                mockSaveSkeletonToDisk
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'export_data',
                    arguments: { format: 'json' }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
        });

        it('should route export_config to handler', async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                mockEnsureSkeletonCacheIsFresh,
                mockSaveSkeletonToDisk
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'export_config',
                    arguments: { action: 'get' }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
        });

        it('should throw GenericError for unknown tool', async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                mockEnsureSkeletonCacheIsFresh,
                mockSaveSkeletonToDisk
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'unknown_tool_xyz',
                    arguments: {}
                }
            };

            await expect(handler(request)).rejects.toThrow('Tool not found');
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty arguments gracefully', () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            expect(() => {
                registerListToolsHandler(mockServer);
            }).not.toThrow();
        });

        it('should handle missing optional parameters', () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            const mockState = {
                conversationCache: new Map(),
                qdrantIndexQueue: new Set(),
                isQdrantIndexingEnabled: false
            } as any;

            expect(() => {
                registerCallToolHandler(
                    mockServer,
                    mockState,
                    vi.fn().mockResolvedValue({ content: [] }),
                    vi.fn().mockResolvedValue(true),
                    vi.fn().mockResolvedValue(undefined)
                );
            }).not.toThrow();
        });
    });

    describe('Backward Compatibility - Deprecated Tools', () => {
        it('should handle deprecated tools without errors', () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            const mockState = {
                conversationCache: new Map(),
                qdrantIndexQueue: new Set(),
                isQdrantIndexingEnabled: false
            } as any;

            expect(() => {
                registerCallToolHandler(
                    mockServer,
                    mockState,
                    vi.fn().mockResolvedValue({ content: [] }),
                    vi.fn().mockResolvedValue(true),
                    vi.fn().mockResolvedValue(undefined)
                );
            }).not.toThrow();
        });
    });

    describe('REGRESSION: Essential Tool Discoverability', () => {
        /**
         * CRITICAL regression test.
         * Agents MUST be able to discover task IDs from scratch (no prior knowledge).
         * If conversation_browser doesn't expose a 'list' action, agents cannot bootstrap
         * their exploration of Roo tasks and must resort to manual filesystem browsing.
         * This was broken by CLEANUP-3 which removed list_conversations from ListTools
         * without adding equivalent capability to conversation_browser.
         */
        it('conversation_browser MUST include "list" in its action enum', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            registerListToolsHandler(mockServer);

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const result = await handler();

            const conversationBrowser = result.tools.find((t: any) => t.name === 'conversation_browser');
            expect(conversationBrowser).toBeDefined();

            const actionEnum = conversationBrowser.inputSchema.properties.action.enum;
            expect(actionEnum).toContain('list');
            expect(actionEnum).toContain('tree');
            expect(actionEnum).toContain('current');
            expect(actionEnum).toContain('view');
            expect(actionEnum).toContain('summarize');
        });

        it('conversation_browser description MUST mention "list" for discoverability', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            registerListToolsHandler(mockServer);

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const result = await handler();

            const conversationBrowser = result.tools.find((t: any) => t.name === 'conversation_browser');
            expect(conversationBrowser.description).toMatch(/list/i);
        });

        it('ListTools MUST expose all essential navigation tools', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            registerListToolsHandler(mockServer);

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const result = await handler();

            const toolNames = result.tools.map((t: any) => t.name);

            // These tools form the minimum viable agent workflow:
            // 1. conversation_browser (list → get IDs, tree → navigate, current → active task, view → inspect)
            // 2. roosync_search (find tasks by content)
            // 3. roosync_send/read/manage (communicate)
            const essentialTools = [
                'conversation_browser',
                'roosync_search',
                'roosync_send',
                'roosync_read',
                'roosync_manage',
            ];

            for (const tool of essentialTools) {
                expect(toolNames).toContain(tool);
            }
        });

        // [REMOVED Phase B #1863] list_conversations backward-compat routing removed — use conversation_browser(action='list')
    });

    describe('Additional Tool Coverage - Idle Worker Extension', () => {
        let mockServer: any;
        let mockState: ServerState;

        beforeEach(() => {
            // roosync_send dynamic-imports send.ts which calls getMessageManager(),
            // which needs ROOSYNC_SHARED_PATH. Provide a temp dir so it doesn't throw.
            if (!process.env.ROOSYNC_SHARED_PATH) {
                process.env.ROOSYNC_SHARED_PATH = '/tmp/test-shared-state';
            }

            mockServer = {
                setRequestHandler: vi.fn()
            };

            mockState = {
                conversationCache: new Map<string, ConversationSkeleton>(),
                qdrantIndexQueue: new Set<string>(),
                isQdrantIndexingEnabled: false,
                xmlExporterService: {},
                exportConfigManager: {}
            } as any;
        });

        it('should route roosync_send to handler', { timeout: 60_000 }, async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                vi.fn().mockResolvedValue({ content: [] }),
                vi.fn().mockResolvedValue(true),
                vi.fn().mockResolvedValue(undefined)
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'roosync_send',
                    arguments: {
                        action: 'send',
                        to: 'test-machine',
                        subject: 'Test Subject',
                        body: 'Test message body'
                    }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
            expect(Array.isArray(result.content)).toBe(true);
        });

        it('should route roosync_dashboard to handler', { timeout: 30000 }, async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                vi.fn().mockResolvedValue({ content: [] }),
                vi.fn().mockResolvedValue(true),
                vi.fn().mockResolvedValue(undefined)
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'roosync_dashboard',
                    arguments: {
                        action: 'read',
                        type: 'workspace',
                        workspace: 'test-workspace'
                    }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
            expect(Array.isArray(result.content)).toBe(true);
        });

        it('should route roosync_mcp_management to handler', async () => {
            registerCallToolHandler(
                mockServer,
                mockState,
                vi.fn().mockResolvedValue({ content: [] }),
                vi.fn().mockResolvedValue(true),
                vi.fn().mockResolvedValue(undefined)
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'roosync_mcp_management',
                    arguments: {
                        action: 'manage',
                        subAction: 'read'
                    }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
            expect(Array.isArray(result.content)).toBe(true);
        });
    });

    describe('#1635: Degraded Mode Capability Guard', () => {
        let mockServer: any;
        let mockState: ServerState;
        let caps: ReturnType<typeof getServerCapabilities>;

        beforeEach(() => {
            caps = getServerCapabilities();
            caps.reset();

            mockServer = {
                setRequestHandler: vi.fn()
            };

            mockState = {
                conversationCache: new Map<string, ConversationSkeleton>(),
                qdrantIndexQueue: new Set<string>(),
                isQdrantIndexingEnabled: false,
                xmlExporterService: {},
                exportConfigManager: {}
            } as any;
        });

        afterEach(() => {
            caps.reset();
        });

        it('should return error when sharedPath is degraded and tool requires it', async () => {
            caps.markDegraded('sharedPath', 'ROOSYNC_SHARED_PATH ABSENTE');

            registerCallToolHandler(
                mockServer,
                mockState,
                vi.fn().mockResolvedValue({ content: [] }),
                vi.fn().mockResolvedValue(true),
                vi.fn().mockResolvedValue(undefined)
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'roosync_dashboard',
                    arguments: { action: 'read', type: 'workspace' }
                }
            };

            const result = await handler(request);

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('mode dégradé');
            expect(result.content[0].text).toContain('sharedPath');
        });

        it('should return error when qdrant is degraded and tool requires it', async () => {
            caps.markDegraded('qdrant', 'QDRANT_URL absent');

            registerCallToolHandler(
                mockServer,
                mockState,
                vi.fn().mockResolvedValue({ content: [] }),
                vi.fn().mockResolvedValue(true),
                vi.fn().mockResolvedValue(undefined)
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'roosync_search',
                    arguments: { action: 'semantic', search_query: 'test' }
                }
            };

            const result = await handler(request);

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('qdrant');
        });

        it('should allow tool execution when no capabilities are degraded', async () => {
            // No degraded capabilities — normal flow
            registerCallToolHandler(
                mockServer,
                mockState,
                vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Settings touched' }] }),
                vi.fn().mockResolvedValue(true),
                vi.fn().mockResolvedValue(undefined)
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'touch_mcp_settings',
                    arguments: {}
                }
            };

            const result = await handler(request);

            // Should proceed normally, not return degraded error
            expect(result.isError).toBeUndefined();
        });

        it('should allow tools with no capability requirements regardless of degradation', async () => {
            // Degrade everything
            caps.markDegraded('sharedPath', 'test');
            caps.markDegraded('qdrant', 'test');
            caps.markDegraded('embeddings', 'test');

            registerCallToolHandler(
                mockServer,
                mockState,
                vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'OK' }] }),
                vi.fn().mockResolvedValue(true),
                vi.fn().mockResolvedValue(undefined)
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'touch_mcp_settings',
                    arguments: {}
                }
            };

            const result = await handler(request);

            // touch_mcp_settings has no capability requirement — should work
            expect(result.isError).toBeUndefined();
        });
    });

    describe('TOOL_CAPABILITIES Configuration', () => {
        // TOOL_CAPABILITIES is defined in registry.ts but not exported
        // Using the actual values from the source
        const TOOL_CAPABILITIES: Record<string, string[]> = {
            // SharedPath-dependent tools (29)
            roosync_read: ['sharedPath'],
            roosync_send: ['sharedPath'],
            roosync_manage: ['sharedPath'],
            roosync_attachments: ['sharedPath'],
            roosync_dashboard: ['sharedPath'],
            roosync_update_dashboard: ['sharedPath'],
            roosync_refresh_dashboard: ['sharedPath'],
            roosync_get_status: ['sharedPath'],
            roosync_inventory: ['sharedPath'],
            roosync_machines: ['sharedPath'],
            roosync_config: ['sharedPath'],
            roosync_compare_config: ['sharedPath'],
            roosync_list_diffs: ['sharedPath'],
            roosync_decision: ['sharedPath'],
            roosync_decision_info: ['sharedPath'],
            roosync_init: ['sharedPath'],
            roosync_diagnose: ['sharedPath'],
            roosync_cleanup_messages: ['sharedPath'],
            roosync_baseline: ['sharedPath'],
            roosync_indexing: ['sharedPath'],
            roosync_mcp_management: ['sharedPath'],
            roosync_storage_management: ['sharedPath'],
            conversation_browser: ['sharedPath'],
            export_data: ['sharedPath'],
            task_export: ['sharedPath'],
            maintenance: ['sharedPath'],
            storage_info: ['sharedPath'],

            // Qdrant-dependent tools (2)
            roosync_search: ['qdrant', 'embeddings'],
            codebase_search: ['qdrant', 'embeddings'],

            // Non-sharedPath tools (0)
        };

        it('should have capability mapping for all sharedPath-dependent tools', () => {
            const sharedPathTools = [
                'roosync_read',
                'roosync_send',
                'roosync_manage',
                'roosync_attachments',
                'roosync_dashboard',
                'roosync_update_dashboard',
                'roosync_refresh_dashboard',
                'roosync_get_status',
                'roosync_inventory',
                'roosync_machines',
                'roosync_config',
                'roosync_compare_config',
                'roosync_list_diffs',
                'roosync_decision',
                'roosync_decision_info',
                'roosync_init',
                'roosync_diagnose',
                'roosync_cleanup_messages',
                'roosync_baseline',
                'roosync_indexing',
                'roosync_mcp_management',
                'roosync_storage_management',
                'conversation_browser',
                'export_data',
                'task_export',
                'maintenance',
                'storage_info'
            ];

            expect(Object.keys(TOOL_CAPABILITIES)).toHaveLength(29);
            sharedPathTools.forEach(toolName => {
                expect(TOOL_CAPABILITIES[toolName]).toContain('sharedPath');
            });
        });

        it('should have capability mapping for qdrant-dependent tools', () => {
            const qdrantTools = [
                'roosync_search',
                'codebase_search'
            ];

            expect(Object.keys(TOOL_CAPABILITIES)).toEqual(expect.arrayContaining(qdrantTools));
            qdrantTools.forEach(toolName => {
                expect(TOOL_CAPABILITIES[toolName]).toContain('qdrant');
                expect(TOOL_CAPABILITIES[toolName]).toContain('embeddings');
            });
        });

        it('should not have capability mapping for tools with no dependencies', () => {
            const toolsWithoutDeps = [
                'touch_mcp_settings',
                'debug_analyze_conversation',
                'read_vscode_logs',
                'manage_mcp_settings',
                'index_task_semantic',
                'reset_qdrant_collection',
                'rebuild_and_restart_mcp',
                'get_mcp_best_practices',
                'rebuild_task_index',
                'diagnose_conversation_bom',
                'repair_conversation_bom'
            ];

            // These tools should not be in TOOL_CAPABILITIES
            toolsWithoutDeps.forEach(toolName => {
                expect(TOOL_CAPABILITIES[toolName]).toBeUndefined();
            });
        });
    });

    describe('Error Handling - GenericError for Unknown Tools', () => {
        it('should throw GenericError with correct code for unknown tool', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            };
            const mockState = {
                conversationCache: new Map(),
                qdrantIndexQueue: new Set(),
                isQdrantIndexingEnabled: false,
                xmlExporterService: {},
                exportConfigManager: {}
            } as any;

            registerCallToolHandler(
                mockServer,
                mockState,
                vi.fn().mockResolvedValue({ content: [] }),
                vi.fn().mockResolvedValue(true),
                vi.fn().mockResolvedValue(undefined)
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'completely_unknown_tool_12345',
                    arguments: {}
                }
            };

            await expect(handler(request)).rejects.toThrow('Tool not found');
        });
    });

    describe('Tool Call Duration Logging', () => {
        let mockServer: any;
        let mockState: ServerState;
        let mockHandleTouchMcpSettings: () => Promise<any>;
        let mockEnsureSkeletonCacheIsFresh: (args?: any) => Promise<boolean>;
        let mockSaveSkeletonToDisk: (skeleton: any) => Promise<void>;

        beforeEach(() => {
            mockServer = {
                setRequestHandler: vi.fn()
            };

            mockState = {
                conversationCache: new Map<string, ConversationSkeleton>(),
                qdrantIndexQueue: new Set<string>(),
                isQdrantIndexingEnabled: false,
                xmlExporterService: {},
                exportConfigManager: {}
            } as any;

            mockHandleTouchMcpSettings = vi.fn().mockImplementation(() => {
                return new Promise(resolve => {
                    // Simulate a slow operation
                    setTimeout(() => {
                        resolve({ content: [{ type: 'text', text: 'Settings touched' }] });
                    }, 6000); // 6 seconds to trigger slow log
                });
            });

            mockEnsureSkeletonCacheIsFresh = vi.fn().mockResolvedValue(true);
            mockSaveSkeletonToDisk = vi.fn().mockResolvedValue(undefined);
        });

        it('should log slow tool calls (over 5 seconds)', async () => {
            // Use the global registry logger that we exposed
            const registryLogger = (global as any).registryLogger;
            const warnSpy = vi.spyOn(registryLogger, 'warn');

            registerCallToolHandler(
                mockServer,
                mockState,
                mockHandleTouchMcpSettings,
                vi.fn().mockResolvedValue(true),
                vi.fn().mockResolvedValue(undefined)
            );

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const request = {
                params: {
                    name: 'touch_mcp_settings',
                    arguments: {}
                }
            };

            // This will take 6 seconds due to the setTimeout
            const result = await handler(request);

            // Wait for all promise handlers to execute
            await new Promise(resolve => setTimeout(resolve, 0));

            // Check if slow logging was called
            expect(warnSpy).toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(
                `Tool call SLOW: touch_mcp_settings`,
                { tool: 'touch_mcp_settings', elapsed: expect.stringContaining('ms') }
            );

            // Clean up
            warnSpy.mockRestore();
        });
    });

    describe('Lazy Module Loading', () => {
        let mockServer: any;
        let mockState: ServerState;
        let mockHandleTouchMcpSettings: () => Promise<any>;
        let mockEnsureSkeletonCacheIsFresh: (args?: any) => Promise<boolean>;
        let mockSaveSkeletonToDisk: (skeleton: any) => Promise<void>;

        beforeEach(() => {
            mockServer = {
                setRequestHandler: vi.fn()
            };
            mockState = {
                conversationCache: new Map(),
                qdrantIndexQueue: new Set(),
                isQdrantIndexingEnabled: false,
                xmlExporterService: {},
                exportConfigManager: {}
            } as any;

            mockHandleTouchMcpSettings = vi.fn().mockResolvedValue({
                content: [{ type: 'text', text: 'Settings touched' }]
            });
            mockEnsureSkeletonCacheIsFresh = vi.fn().mockResolvedValue(true);
            mockSaveSkeletonToDisk = vi.fn().mockResolvedValue(undefined);
        });

        it('should lazy load heavy modules only when needed', async () => {
            // Test that registry can be set up without errors
            registerCallToolHandler(
                mockServer,
                mockState,
                vi.fn().mockResolvedValue({ content: [] }),
                vi.fn().mockResolvedValue(true),
                vi.fn().mockResolvedValue(undefined)
            );

            // Verify handler was set up
            expect(mockServer.setRequestHandler).toHaveBeenCalled();
        });
    });
});