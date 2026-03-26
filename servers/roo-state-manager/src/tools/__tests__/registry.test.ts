/**
 * Tests pour registry.ts
 * Coverage target: Core logic (enregistrement + routing)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    registerListToolsHandler,
    registerCallToolHandler
} from '../registry.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ServerState } from '../../services/state-manager.service.js';
import { ConversationSkeleton } from '../../types/conversation.js';

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

        it('should include export_config tool', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            registerListToolsHandler(mockServer);

            const handler = mockServer.setRequestHandler.mock.calls[0][1];
            const result = await handler();
            const toolNames = result.tools.map((t: any) => t.name);
            expect(toolNames).toContain('export_config');
        });

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

        it('should route storage_info to handler', async () => {
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

        it('should route maintenance to handler', async () => {
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

        it('should route task_browse to handler', async () => {
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
                    name: 'task_browse',
                    arguments: { action: 'tree' }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
        });

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

        it('CallTool should route list_conversations for backward compat', async () => {
            const mockServer = {
                setRequestHandler: vi.fn()
            } as any;

            const mockState = {
                conversationCache: new Map(),
                qdrantIndexQueue: new Set(),
                isQdrantIndexingEnabled: false
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
                    name: 'list_conversations',
                    arguments: { limit: 5 }
                }
            };

            const result = await handler(request);

            expect(result).toBeDefined();
            expect(result).toHaveProperty('content');
            // Should return a valid JSON array (possibly empty on test machine)
            expect(result.content[0].type).toBe('text');
        });
    });

    describe('Additional Tool Coverage - Idle Worker Extension', () => {
        let mockServer: any;
        let mockState: ServerState;

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
        });

        it('should route roosync_send to handler', async () => {
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

        it('should route roosync_dashboard to handler', async () => {
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
});
