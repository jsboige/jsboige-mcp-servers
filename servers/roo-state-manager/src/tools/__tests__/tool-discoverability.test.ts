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
 * Uses a 5-second timeout to avoid hanging on heavy I/O operations
 */
async function hasCallToolHandler(handler: (req: any) => Promise<any>, toolName: string): Promise<boolean> {
    const TIMEOUT_MS = 5000; // 5s timeout per tool

    const timeoutPromise = new Promise<boolean>((_, reject) => {
        setTimeout(() => reject(new Error('Tool check timeout')), TIMEOUT_MS);
    });

    try {
        await Promise.race([
            handler({
                params: { name: toolName, arguments: {} }
            }),
            timeoutPromise
        ]);
        return true;
    } catch (error: any) {
        if (error.message?.includes('Tool not found')) {
            return false;
        }
        // Other errors (including timeout) mean the handler EXISTS but the operation failed
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

        // B4 (#603): Pre-consolidation tools removed from ListTools
        // Covered by roosync_storage_management (CONS-#443 Groupe 4)
        'storage_info',
        'maintenance',
        // Covered by roosync_mcp_management (CONS-#443 Groupe 3)
        'touch_mcp_settings',
        'manage_mcp_settings',
        'rebuild_and_restart_mcp',
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
    }, 30000); // 30s timeout - build_skeleton_cache does heavy I/O

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
            actions: ['tree', 'current', 'view', 'summarize', 'rebuild'],
            // Note: 'list' is NOT in registry's action enum but handled via list_conversations backward compat
        },
        // B4: maintenance removed from ListTools — covered by roosync_storage_management(action: 'maintenance')
        // CallTool handler preserved for backward compat
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
        // B4: storage_info removed from ListTools — covered by roosync_storage_management(action: 'storage')
        // CallTool handler preserved for backward compat
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

// ============================================================================
// Category 5: Description Discoverability (#549)
// Tool descriptions must contain keywords for agent discovery
// ============================================================================

describe('Category 5: Description Discoverability', () => {
    /**
     * Mapping of tools to keywords that MUST appear in their description.
     * Agents rely on these keywords to discover the right tool.
     * At minimum, each tool description should mention its primary action verbs.
     */
    const DESCRIPTION_KEYWORDS: Record<string, string[]> = {
        // Keywords matched case-insensitively against description text
        // Descriptions are mostly in French, so use French keywords where applicable
        'conversation_browser': ['conversation'],
        'roosync_search': ['recherche', 'tâche'],       // "Outil unifié de recherche dans les tâches Roo"
        'roosync_send': ['message'],                     // "Envoyer un message structuré"
        'roosync_read': ['réception', 'message'],        // "Lire la boîte de réception des messages"
        'roosync_config': ['config'],                    // "Gestion de configuration RooSync"
        'roosync_compare_config': ['compare', 'config'], // "Compare les configurations Roo"
        'roosync_heartbeat': ['heartbeat'],              // "Gestion complète du heartbeat"
        'roosync_diagnose': ['diagnos'],                 // "diagnostic et debug"
        'roosync_mcp_management': ['MCP'],               // "Gestion complète des serveurs MCP"
        'roosync_decision': ['décision'],                // "workflow de décision RooSync"
        'roosync_baseline': ['baseline'],                // "baselines RooSync"
        'roosync_indexing': ['index'],                   // "index sémantique"
        'export_data': ['export'],                       // "exporter des données"
        'export_config': ['export', 'config'],           // "paramètres de configuration des exports"
        'task_export': ['export', 'tâche'],              // "exporter/diagnostiquer les tâches"
        // B4: maintenance removed from ListTools — covered by roosync_storage_management(action: 'maintenance')
        // B4: storage_info removed from ListTools — covered by roosync_storage_management(action: 'storage')
        'codebase_search': ['recherche', 'code'],        // "Recherche sémantique dans le code"
        'view_task_details': ['tâche', 'détail'],        // "détails techniques complets... tâche spécifique"
    };

    it('tool descriptions contain discoverable keywords', async () => {
        const tools = await getListToolsDefinitions();
        const missingKeywords: string[] = [];

        for (const [toolName, keywords] of Object.entries(DESCRIPTION_KEYWORDS)) {
            const tool = tools.find((t: any) => t.name === toolName);
            if (!tool) {
                missingKeywords.push(`${toolName} (not found in ListTools)`);
                continue;
            }

            const descLower = (tool.description || '').toLowerCase();
            for (const keyword of keywords) {
                if (!descLower.includes(keyword.toLowerCase())) {
                    missingKeywords.push(`${toolName} missing keyword "${keyword}" in description`);
                }
            }
        }

        expect(missingKeywords).toEqual([]);
    });

    it('all tools have non-empty descriptions (minimum 20 chars)', async () => {
        const tools = await getListToolsDefinitions();
        const tooShort: string[] = [];

        for (const tool of tools) {
            if (!tool.description || tool.description.length < 20) {
                tooShort.push(`${tool.name} (${tool.description?.length || 0} chars)`);
            }
        }

        expect(tooShort).toEqual([]);
    });
});

// ============================================================================
// Category 6: Backward Compatibility Routes (#549)
// Deprecated tools must route to their consolidated replacement
// ============================================================================

describe('Category 6: Backward Compatibility Routes', () => {
    /**
     * Deprecated tool names and the consolidated tool they should route to.
     * Each entry: [deprecated_name, expected_action_or_route]
     *
     * When a deprecated tool is called, it should NOT throw "Tool not found".
     * Instead, it should delegate to the consolidated handler.
     */
    const BACKWARD_COMPAT_ROUTES: Record<string, string> = {
        // CONS-9: task_browse → conversation_browser
        'task_browse': 'conversation_browser',
        // #457: view_conversation_tree → conversation_browser(view)
        'view_conversation_tree': 'conversation_browser',
        // CONS-12→#457: roosync_summarize → conversation_browser(summarize)
        'roosync_summarize': 'conversation_browser',
        // list_conversations → conversation_browser(list)
        'list_conversations': 'conversation_browser',
        // CONS-11: search_tasks_by_content → roosync_search
        'search_tasks_by_content': 'roosync_search',
        // CONS-11: Indexing tools → roosync_indexing
        'index_task_semantic': 'roosync_indexing',
        'reset_qdrant_collection': 'roosync_indexing',
        'rebuild_task_index': 'roosync_indexing',
        // CONS-13: BOM tools → roosync_storage_management (via maintenance, B4)
        'diagnose_conversation_bom': 'roosync_storage_management',
        'repair_conversation_bom': 'roosync_storage_management',
        // CLEANUP-3: cache → roosync_storage_management (via maintenance, B4)
        'build_skeleton_cache': 'roosync_storage_management',
        // CLEANUP-3: debug → task_export
        'debug_analyze_conversation': 'task_export',
        // CONS-1: Legacy messaging → roosync_send/read/manage
        'roosync_send_message': 'roosync_send',
        'roosync_read_inbox': 'roosync_read',
        'roosync_get_message': 'roosync_read',
        'roosync_mark_message_read': 'roosync_manage',
        'roosync_archive_message': 'roosync_manage',
        'roosync_reply_message': 'roosync_send',
        // Legacy decision tools → roosync_decision
        'roosync_get_decision_details': 'roosync_decision_info',
        'roosync_approve_decision': 'roosync_decision',
        'roosync_reject_decision': 'roosync_decision',
        'roosync_apply_decision': 'roosync_decision',
        'roosync_rollback_decision': 'roosync_decision',
        // Legacy baseline tools → roosync_baseline
        'roosync_update_baseline': 'roosync_baseline',
        'roosync_manage_baseline': 'roosync_baseline',
        'roosync_export_baseline': 'roosync_baseline',
        // Legacy config tools → roosync_config
        'roosync_collect_config': 'roosync_config',
        'roosync_publish_config': 'roosync_config',
        'roosync_apply_config': 'roosync_config',
        // Legacy inventory → roosync_inventory
        'roosync_get_machine_inventory': 'roosync_inventory',
    };

    it('all deprecated tools have working CallTool handlers', async () => {
        const { handler } = createCallToolHandler();
        const broken: string[] = [];

        for (const deprecatedName of Object.keys(BACKWARD_COMPAT_ROUTES)) {
            const hasHandler = await hasCallToolHandler(handler, deprecatedName);
            if (!hasHandler) {
                broken.push(deprecatedName);
            }
        }

        expect(broken).toEqual([]);
    }, 120000); // 120s timeout: ~18 tools * 5s timeout each + buffer

    it('deprecated tools are NOT in ListTools (hidden from agents)', async () => {
        const toolNames = await getListToolsNames();
        const leaked: string[] = [];

        for (const deprecatedName of Object.keys(BACKWARD_COMPAT_ROUTES)) {
            if (toolNames.includes(deprecatedName)) {
                leaked.push(deprecatedName);
            }
        }

        expect(leaked).toEqual([]);
    });

    it('consolidated replacements ARE in ListTools', async () => {
        const toolNames = await getListToolsNames();
        const replacements = new Set(Object.values(BACKWARD_COMPAT_ROUTES));
        const missing: string[] = [];

        for (const replacement of replacements) {
            if (!toolNames.includes(replacement)) {
                missing.push(replacement);
            }
        }

        expect(missing).toEqual([]);
    });
});
