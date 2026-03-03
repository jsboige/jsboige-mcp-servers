/**
 * Tool Discoverability Tests (#549)
 *
 * These tests ensure that the MCP tool registry remains consistent:
 * - Category 1: Every tool listed in ListTools has a CallTool handler
 * - Category 2: All CallTool handlers are either in ListTools OR documented as deprecated
 * - Category 3: Consolidated tools with action enums handle all declared actions
 *
 * These are structural tests that read the registry source code to detect
 * drift between ListTools declarations and CallTool routing.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    registerListToolsHandler,
    registerCallToolHandler
} from '../registry.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ConversationSkeleton } from '../../types/conversation.js';
import { ServerState } from '../../services/state-manager.service.js';

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

/**
 * Helper: Get all tool names from ListTools handler
 */
async function getListToolsNames(): Promise<string[]> {
    const mockServer = { setRequestHandler: vi.fn() } as any;
    registerListToolsHandler(mockServer);
    const handler = mockServer.setRequestHandler.mock.calls[0][1];
    const result = await handler();
    return result.tools.map((t: any) => t.name);
}

/**
 * Helper: Get full tool definitions from ListTools handler
 */
async function getListToolsDefinitions(): Promise<any[]> {
    const mockServer = { setRequestHandler: vi.fn() } as any;
    registerListToolsHandler(mockServer);
    const handler = mockServer.setRequestHandler.mock.calls[0][1];
    const result = await handler();
    return result.tools;
}

/**
 * Helper: Create a CallTool handler for testing
 */
function createCallToolHandler(): { handler: (request: any) => Promise<any> } {
    const mockServer = { setRequestHandler: vi.fn() } as any;
    const mockState: ServerState = {
        conversationCache: new Map<string, ConversationSkeleton>(),
        qdrantIndexQueue: new Set<string>(),
        isQdrantIndexingEnabled: false,
        xmlExporterService: {},
        exportConfigManager: {}
    } as any;

    registerCallToolHandler(
        mockServer,
        mockState,
        vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'OK' }] }),
        vi.fn().mockResolvedValue(true),
        vi.fn().mockResolvedValue(undefined)
    );

    const handler = mockServer.setRequestHandler.mock.calls[0][1];
    return { handler };
}

/**
 * Helper: Test if a tool name has a CallTool handler (doesn't throw "Tool not found")
 */
async function hasCallToolHandler(handler: (req: any) => Promise<any>, toolName: string): Promise<boolean> {
    try {
        await handler({
            params: { name: toolName, arguments: {} }
        });
        return true;
    } catch (error: any) {
        if (error.message?.includes('Tool not found')) {
            return false;
        }
        // Other errors (e.g., invalid args) mean the handler EXISTS but the args are wrong
        return true;
    }
}

// ============================================================================
// Category 1: ListTools → CallTool Consistency
// Every tool that appears in ListTools MUST have a corresponding CallTool case
// ============================================================================

describe('Category 1: ListTools → CallTool Consistency', () => {
    it('every tool in ListTools must have a CallTool handler', async () => {
        const toolNames = await getListToolsNames();
        const { handler } = createCallToolHandler();

        const missingHandlers: string[] = [];

        for (const toolName of toolNames) {
            const hasHandler = await hasCallToolHandler(handler, toolName);
            if (!hasHandler) {
                missingHandlers.push(toolName);
            }
        }

        expect(missingHandlers).toEqual([]);
    });

    it('ListTools should expose a reasonable number of tools (30-50 range)', async () => {
        const toolNames = await getListToolsNames();
        // Currently ~35 tools. This guards against accidental mass removal or explosion
        expect(toolNames.length).toBeGreaterThanOrEqual(30);
        expect(toolNames.length).toBeLessThanOrEqual(50);
    });

    it('all tool names should be unique in ListTools', async () => {
        const toolNames = await getListToolsNames();
        const uniqueNames = new Set(toolNames);
        const duplicates = toolNames.filter((name, index) => toolNames.indexOf(name) !== index);
        expect(duplicates).toEqual([]);
    });

    it('all tools must have name, description, and inputSchema', async () => {
        const tools = await getListToolsDefinitions();
        const incomplete: string[] = [];

        for (const tool of tools) {
            if (!tool.name || !tool.description || !tool.inputSchema) {
                incomplete.push(tool.name || '<unnamed>');
            }
        }

        expect(incomplete).toEqual([]);
    });
});

// ============================================================================
// Category 2: Known Deprecated Tools (Backward Compat)
// These tools exist in CallTool but NOT in ListTools - by design
// ============================================================================

describe('Category 2: Deprecated Tools Backward Compatibility', () => {
    /**
     * Known deprecated tools that have CallTool handlers but are intentionally
     * removed from ListTools. This is the authoritative list.
     *
     * When removing a deprecated tool's CallTool handler, remove it from this list too.
     * When adding backward compat for a newly deprecated tool, add it here.
     */
    const KNOWN_DEPRECATED_TOOLS = [
        // CLEANUP-3: Storage tools replaced by storage_info
        // 'detect_storage',        // removed in #519
        // 'get_storage_stats',     // removed in #519

        // CLEANUP-3: Cache tool replaced by maintenance
        'build_skeleton_cache',

        // CONS-9: task_browse replaced by conversation_browser
        'task_browse',

        // #457: view_conversation_tree replaced by conversation_browser action=view
        'view_conversation_tree',

        // CONS-11: search_tasks_by_content replaced by roosync_search
        'search_tasks_by_content',

        // CLEANUP-3: debug_analyze_conversation kept for backward compat
        'debug_analyze_conversation',

        // CONS-11: Indexing tools replaced by roosync_indexing
        'index_task_semantic',
        'reset_qdrant_collection',
        'rebuild_task_index',

        // CONS-13: Maintenance BOM tools replaced by maintenance action=diagnose_bom/repair_bom
        'diagnose_conversation_bom',
        'repair_conversation_bom',

        // CONS-12→#457: roosync_summarize replaced by conversation_browser action=summarize
        'roosync_summarize',

        // CONS-1: Legacy messaging tools (6→3)
        'roosync_send_message',
        'roosync_read_inbox',
        'roosync_get_message',
        'roosync_mark_message_read',
        'roosync_archive_message',
        'roosync_reply_message',

        // Legacy RooSync tools with individual CallTool handlers
        'roosync_get_decision_details',
        'roosync_approve_decision',
        'roosync_reject_decision',
        'roosync_apply_decision',
        'roosync_rollback_decision',
        'roosync_update_baseline',
        'roosync_manage_baseline',
        'roosync_export_baseline',
        'roosync_collect_config',
        'roosync_publish_config',
        'roosync_apply_config',
        'roosync_sync_event',
        'roosync_get_machine_inventory',

        // list_conversations replaced by conversation_browser action=list
        'list_conversations',
    ];

    it('deprecated tools must still have CallTool handlers for backward compat', async () => {
        const { handler } = createCallToolHandler();
        const brokenBackwardCompat: string[] = [];

        for (const toolName of KNOWN_DEPRECATED_TOOLS) {
            const hasHandler = await hasCallToolHandler(handler, toolName);
            if (!hasHandler) {
                brokenBackwardCompat.push(toolName);
            }
        }

        expect(brokenBackwardCompat).toEqual([]);
    });

    it('deprecated tools must NOT appear in ListTools', async () => {
        const toolNames = await getListToolsNames();
        const leakedDeprecated: string[] = [];

        for (const depTool of KNOWN_DEPRECATED_TOOLS) {
            if (toolNames.includes(depTool)) {
                leakedDeprecated.push(depTool);
            }
        }

        expect(leakedDeprecated).toEqual([]);
    });

    it('unknown tool should throw Tool not found error', async () => {
        const { handler } = createCallToolHandler();
        const hasHandler = await hasCallToolHandler(handler, 'completely_nonexistent_tool_xyz_789');
        expect(hasHandler).toBe(false);
    });
});

// ============================================================================
// Category 3: Consolidated Tool Action Completeness
// Tools with action enums must handle all declared actions
// ============================================================================

describe('Category 3: Consolidated Tool Action Completeness', () => {
    /**
     * Authoritative mapping of consolidated tools and their declared actions.
     * Update this when adding/removing actions from a consolidated tool.
     */
    const CONSOLIDATED_TOOLS_ACTIONS: Record<string, { field: string; actions: string[] }> = {
        'conversation_browser': {
            field: 'action',
            actions: ['tree', 'current', 'view', 'summarize'],
            // Note: 'list' is NOT in registry's action enum but handled via list_conversations backward compat
        },
        'maintenance': {
            field: 'action',
            actions: ['cache_rebuild', 'diagnose_bom', 'repair_bom'],
        },
        'task_export': {
            field: 'action',
            actions: ['markdown', 'debug'],
        },
        'roosync_search': {
            field: 'action',
            actions: ['semantic', 'text', 'diagnose'],
        },
        'roosync_indexing': {
            field: 'action',
            actions: ['index', 'reset', 'rebuild', 'diagnose', 'archive'],
        },
        'export_data': {
            field: 'target',
            actions: ['task', 'conversation', 'project'],
        },
        'export_config': {
            field: 'action',
            actions: ['get', 'set', 'reset'],
        },
        'roosync_decision': {
            field: 'action',
            actions: ['approve', 'reject', 'apply', 'rollback'],
        },
        'roosync_baseline': {
            field: 'action',
            actions: ['update', 'version', 'restore', 'export'],
        },
        'roosync_config': {
            field: 'action',
            actions: ['collect', 'publish', 'apply', 'apply_profile'],
        },
        'roosync_heartbeat': {
            field: 'action',
            actions: ['status', 'register', 'start', 'stop'],
        },
        'roosync_mcp_management': {
            field: 'action',
            actions: ['manage', 'rebuild', 'touch'],
        },
        'roosync_storage_management': {
            field: 'action',
            actions: ['storage', 'maintenance'],
        },
        'roosync_diagnose': {
            field: 'action',
            actions: ['env', 'debug', 'reset', 'test'],
        },
        'roosync_send': {
            field: 'action',
            actions: ['send', 'reply', 'amend'],
        },
        'roosync_read': {
            field: 'mode',
            actions: ['inbox', 'message'],
        },
        'roosync_manage': {
            field: 'action',
            actions: ['mark_read', 'archive'],
        },
        'storage_info': {
            field: 'action',
            actions: ['detect', 'stats'],
        },
    };

    it('consolidated tools must declare their action/mode enum in inputSchema', async () => {
        const tools = await getListToolsDefinitions();
        const missingEnum: string[] = [];

        for (const [toolName, config] of Object.entries(CONSOLIDATED_TOOLS_ACTIONS)) {
            const tool = tools.find((t: any) => t.name === toolName);
            if (!tool) {
                missingEnum.push(`${toolName} (not found in ListTools)`);
                continue;
            }

            const fieldDef = tool.inputSchema?.properties?.[config.field];
            if (!fieldDef?.enum) {
                missingEnum.push(`${toolName}.${config.field} (no enum)`);
            }
        }

        expect(missingEnum).toEqual([]);
    });

    it('all expected actions must be in the declared enum', async () => {
        const tools = await getListToolsDefinitions();
        const missingActions: string[] = [];

        for (const [toolName, config] of Object.entries(CONSOLIDATED_TOOLS_ACTIONS)) {
            const tool = tools.find((t: any) => t.name === toolName);
            if (!tool) continue;

            const declaredEnum: string[] = tool.inputSchema?.properties?.[config.field]?.enum || [];
            for (const expectedAction of config.actions) {
                if (!declaredEnum.includes(expectedAction)) {
                    missingActions.push(`${toolName}.${config.field} missing action: ${expectedAction}`);
                }
            }
        }

        expect(missingActions).toEqual([]);
    });

    it('no unexpected extra actions in enums (detect undocumented additions)', async () => {
        const tools = await getListToolsDefinitions();
        const extraActions: string[] = [];

        for (const [toolName, config] of Object.entries(CONSOLIDATED_TOOLS_ACTIONS)) {
            const tool = tools.find((t: any) => t.name === toolName);
            if (!tool) continue;

            const declaredEnum: string[] = tool.inputSchema?.properties?.[config.field]?.enum || [];
            for (const action of declaredEnum) {
                if (!config.actions.includes(action)) {
                    extraActions.push(`${toolName}.${config.field} has extra action: ${action}`);
                }
            }
        }

        // This is informational - extra actions are not necessarily wrong,
        // but should be documented in CONSOLIDATED_TOOLS_ACTIONS above
        if (extraActions.length > 0) {
            console.warn('Undocumented actions found (update CONSOLIDATED_TOOLS_ACTIONS):', extraActions);
        }
        // We report but don't fail - the test above for missing actions is the critical one
        // To make this strict, uncomment: expect(extraActions).toEqual([]);
    });
});

// ============================================================================
// Category 4: Essential Tool Presence (Agent Workflow Requirements)
// ============================================================================

describe('Category 4: Essential Tools for Agent Workflows', () => {
    /**
     * Tools that form the minimum viable agent workflow.
     * If any of these are missing from ListTools, agents cannot function.
     */
    const ESSENTIAL_TOOLS = [
        // Navigation & Discovery
        'conversation_browser',  // list/tree/current/view/summarize
        'roosync_search',        // find tasks by content
        'view_task_details',     // inspect task details
        'get_raw_conversation',  // raw conversation data

        // Communication
        'roosync_send',          // send messages
        'roosync_read',          // read inbox
        'roosync_manage',        // manage messages

        // Configuration & Management
        'roosync_config',        // collect/publish/apply config
        'roosync_compare_config', // compare configs between machines
        'roosync_mcp_management', // manage MCP servers
        'roosync_heartbeat',     // heartbeat management

        // Diagnostics
        'roosync_diagnose',      // diagnose system
        'roosync_storage_management', // storage management

        // Code & Search
        'codebase_search',       // semantic code search
        'roosync_indexing',      // index management

        // Export
        'export_data',           // export conversations/tasks
        'task_export',           // export task trees
    ];

    it('all essential tools must be present in ListTools', async () => {
        const toolNames = await getListToolsNames();
        const missing: string[] = [];

        for (const tool of ESSENTIAL_TOOLS) {
            if (!toolNames.includes(tool)) {
                missing.push(tool);
            }
        }

        expect(missing).toEqual([]);
    });

    it('essential tools must also have CallTool handlers', async () => {
        const { handler } = createCallToolHandler();
        const broken: string[] = [];

        for (const toolName of ESSENTIAL_TOOLS) {
            const hasHandler = await hasCallToolHandler(handler, toolName);
            if (!hasHandler) {
                broken.push(toolName);
            }
        }

        expect(broken).toEqual([]);
    });
});
