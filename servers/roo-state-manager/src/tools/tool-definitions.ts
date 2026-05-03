/**
 * Tool definitions — static JSON Schema objects with ZERO handler imports.
 *
 * #1145 perf: Breaking the barrel import chain.
 * registry.ts registerListToolsHandler imports THIS file only (no handlers).
 * registerCallToolHandler uses per-case dynamic imports for each tool.
 *
 * DO NOT import any tool handler modules here.
 * Schemas for roosync_decision and roosync_decision_info are inlined
 * (those two tools use zodToJsonSchema at module scope in their source files).
 * #1470: dashboard schema derived from dashboard-schemas.ts (no handler imports).
 */

import { dashboardToolMetadata } from './roosync/dashboard-schemas.js';

// ============================================================
// conversation_browser
// ============================================================
export const conversationBrowserDefinition = {
    name: 'conversation_browser',
    description: 'Navigate, view, and summarize conversations. Actions: list, tree, current, view, summarize (trace/cluster/synthesis), rebuild. Start with "list".',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['list', 'tree', 'current', 'view', 'summarize', 'rebuild'], description: 'Action. Use "list" first to discover task IDs.' },
            limit: { type: 'number', description: '[list] Max conversations to return.' },
            sortBy: { type: 'string', enum: ['lastActivity', 'messageCount', 'totalSize'], description: '[list] Sort criterion.', default: 'lastActivity' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], description: '[list] Sort order.', default: 'desc' },
            pendingSubtaskOnly: { type: 'boolean', description: '[list] Only tasks with pending subtasks.' },
            contentPattern: { type: 'string', description: '[list] Filter tasks containing this text.' },
            conversation_id: { type: 'string', description: '[tree] Conversation ID.' },
            max_depth: { type: 'number', description: '[tree] Max tree depth.' },
            include_siblings: { type: 'boolean', description: '[tree] Include sibling tasks.', default: true },
            output_format: { type: 'string', enum: ['json', 'markdown', 'ascii-tree', 'hierarchical'], description: '[tree] Output format.', default: 'json' },
            current_task_id: { type: 'string', description: '[tree/view] Current task ID for highlighting.' },
            truncate_instruction: { type: 'number', description: '[tree] Max instruction length.', default: 80 },
            show_metadata: { type: 'boolean', description: '[tree] Show detailed metadata.', default: false },
            workspace: { type: 'string', description: '[current/view] Workspace path (auto-detected if omitted).' },
            task_id: { type: 'string', description: '[view] Starting task ID.' },
            view_mode: { type: 'string', enum: ['single', 'chain', 'cluster'], description: '[view] Display mode.', default: 'chain' },
            detail_level: { type: 'string', enum: ['skeleton', 'summary', 'full'], description: '[view] Detail level.', default: 'skeleton' },
            truncate: { type: 'number', description: '[view] Lines to keep at start/end.', default: 0 },
            max_output_length: { type: 'number', description: '[view] Max output chars.', default: 300000 },
            smart_truncation: { type: 'boolean', description: '[view] Smart gradient truncation.', default: false },
            smart_truncation_config: { type: 'object', description: '[view] Smart truncation config.', properties: { gradientStrength: { type: 'number' }, minPreservationRate: { type: 'number' }, maxTruncationRate: { type: 'number' } } },
            output_file: { type: 'string', description: '[view] Save tree to file.' },
            summarize_type: { type: 'string', enum: ['trace', 'cluster', 'synthesis'], description: '[summarize] Summary type: trace (stats), cluster (parent-child), synthesis (LLM analysis).' },
            taskId: { type: 'string', description: '[summarize] Task ID (or root for cluster).' },
            source: { type: 'string', enum: ['roo', 'claude', 'all'], description: '[list/summarize] Source: roo, claude, or all.', default: 'roo' },
            filePath: { type: 'string', description: '[summarize] Save to file path.' },
            summarize_output_format: { type: 'string', enum: ['markdown', 'html', 'json'], description: '[summarize] Output format.', default: 'markdown' },
            detailLevel: { type: 'string', enum: ['Full', 'NoTools', 'NoResults', 'Messages', 'Summary', 'UserOnly'], description: '[summarize] Detail level.', default: 'Full' },
            truncationChars: { type: 'number', description: '[summarize] Max chars before truncation (0 = none).', default: 0 },
            compactStats: { type: 'boolean', description: '[summarize] Compact stats format.', default: false },
            includeCss: { type: 'boolean', description: '[summarize] Include embedded CSS.', default: true },
            generateToc: { type: 'boolean', description: '[summarize] Generate table of contents.', default: true },
            startIndex: { type: 'number', description: '[summarize] Start index (1-based).' },
            endIndex: { type: 'number', description: '[summarize] End index (1-based).' },
            childTaskIds: { type: 'array', items: { type: 'string' }, description: '[summarize/cluster] Child task IDs.' },
            clusterMode: { type: 'string', enum: ['aggregated', 'detailed', 'comparative'], description: '[summarize/cluster] Clustering mode.', default: 'aggregated' },
            includeClusterStats: { type: 'boolean', description: '[summarize/cluster] Include cluster stats.', default: true },
            crossTaskAnalysis: { type: 'boolean', description: '[summarize/cluster] Cross-task analysis.', default: false },
            maxClusterDepth: { type: 'number', description: '[summarize/cluster] Max cluster depth.', default: 10 },
            clusterSortBy: { type: 'string', enum: ['chronological', 'size', 'activity', 'alphabetical'], description: '[summarize/cluster] Sort criterion.', default: 'chronological' },
            includeClusterTimeline: { type: 'boolean', description: '[summarize/cluster] Include timeline.', default: false },
            clusterTruncationChars: { type: 'number', description: '[summarize/cluster] Truncation limit.', default: 0 },
            showTaskRelationships: { type: 'boolean', description: '[summarize/cluster] Show task relationships.', default: true },
            synthesis_output_format: { type: 'string', enum: ['json', 'markdown'], description: '[summarize/synthesis] Output format.', default: 'json' },
            force_rebuild: { type: 'boolean', description: '[rebuild] Rebuild all skeletons (slow).', default: false },
            task_ids: { type: 'array', items: { type: 'string' }, description: '[rebuild] Specific task IDs to rebuild.' }
        },
        required: ['action']
    }
};

// ============================================================
// task_export
// ============================================================
export const taskExportDefinition = {
    name: 'task_export',
    description: 'Outil consolidé pour exporter/diagnostiquer les tâches. Actions: "markdown" (export fichier), "debug" (diagnostic parsing).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['markdown', 'debug'], description: 'Action: "markdown" (export tree) or "debug" (parsing diagnostic).' },
            conversation_id: { type: 'string', description: '[markdown] Conversation ID to export.' },
            filePath: { type: 'string', description: '[markdown] Output file path. If omitted, returns inline.' },
            max_depth: { type: 'number', description: '[markdown] Max tree depth.' },
            include_siblings: { type: 'boolean', description: '[markdown] Include sibling tasks.', default: true },
            output_format: { type: 'string', enum: ['ascii-tree', 'markdown', 'hierarchical', 'json'], description: '[markdown] Output format.', default: 'ascii-tree' },
            current_task_id: { type: 'string', description: '[markdown] Current task ID for highlighting.' },
            truncate_instruction: { type: 'number', description: '[markdown] Max instruction length.', default: 80 },
            show_metadata: { type: 'boolean', description: '[markdown] Show detailed metadata.', default: false },
            task_id: { type: 'string', description: '[debug] Task ID to analyze.' }
        },
        required: ['action']
    }
};

// ============================================================
// roosync_search
// ============================================================
export const roosyncSearchDefinition = {
    name: 'roosync_search',
    description: 'Search Roo tasks (semantic vector search, text search, or index diagnostic)',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['semantic', 'text', 'diagnose'], description: 'Action: semantic (Qdrant vector search), text (cache search), diagnose (index health)' },
            search_query: { type: 'string', description: 'Search query (required for semantic/text)' },
            conversation_id: { type: 'string', description: 'Conversation ID filter (optional)' },
            max_results: { type: 'number', description: 'Max results to return' },
            workspace: { type: 'string', description: 'Workspace filter. Default: MCP workspace. "*" or "all" = global.' },
            source: { type: 'string', enum: ['roo', 'claude-code'], description: 'Filter by source (Roo or Claude Code)' },
            chunk_type: { type: 'string', enum: ['message_exchange', 'tool_interaction'], description: 'Filter by chunk type (messages vs tool calls)' },
            role: { type: 'string', enum: ['user', 'assistant'], description: 'Filter by message role' },
            tool_name: { type: 'string', description: 'Filter by tool name' },
            has_errors: { type: 'boolean', description: 'Filter chunks with error patterns' },
            model: { type: 'string', description: 'Filter by LLM model' },
            start_date: { type: 'string', description: 'Filter after date (ISO 8601)' },
            end_date: { type: 'string', description: 'Filter before date (ISO 8601)' },
            exclude_tool_results: { type: 'boolean', description: 'Exclude tool_interaction chunks' }
        },
        required: ['action']
    }
};

// ============================================================
// roosync_indexing
// ============================================================
export const roosyncIndexingDefinition = {
    name: 'roosync_indexing',
    description: 'Manage semantic index and archiving (index, reset, rebuild, diagnose, archive, status, cleanup, garbage_scan, cleanup_orphans)',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status', 'cleanup', 'garbage_scan', 'cleanup_orphans'], description: 'Action to perform' },
            task_id: { type: 'string', description: 'Task ID (required for index)' },
            confirm: { type: 'boolean', description: 'Confirmation for reset', default: false },
            workspace_filter: { type: 'string', description: 'Workspace filter (rebuild)' },
            max_tasks: { type: 'number', description: 'Max tasks (rebuild, 0=all)', default: 0 },
            dry_run: { type: 'boolean', description: 'Simulation mode', default: false },
            machine_id: { type: 'string', description: 'Machine filter (archive)' },
            claude_code_sessions: { type: 'boolean', description: 'BLOCKED - sessions are sanctuary.', default: false },
            max_sessions: { type: 'number', description: 'Max sessions (0=all)', default: 0 },
            source: { type: 'string', enum: ['roo', 'claude-code'], description: 'Source for index. Default: "roo".' }
        },
        required: ['action']
    }
};

// ============================================================
// codebase_search
// ============================================================
export const codebaseSearchDefinition = {
    name: 'codebase_search',
    description: 'Recherche sémantique dans le code du workspace indexé par Roo. Trouve du code par concept, pas par texte exact.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Semantic search query (concept, not exact text). English works best.' },
            workspace: { type: 'string', description: 'Absolute workspace path. REQUIRED, always pass explicitly.' },
            directory_prefix: { type: 'string', description: 'Préfixe de répertoire pour filtrer. Ex: "src/services", "mcps/internal"' },
            limit: { type: 'number', description: 'Nombre max de résultats (défaut: 10, max: 30)' },
            min_score: { type: 'number', description: 'Score minimum de similarité 0-1 (défaut: 0.5)' }
        },
        required: ['query', 'workspace']
    }
};

// ============================================================
// read_vscode_logs
// ============================================================
export const readVscodeLogsDefinition = {
    name: 'read_vscode_logs',
    description: 'Read latest VS Code logs (Extension Host, Renderer, Roo-Code Output Channels).',
    inputSchema: {
        type: 'object',
        properties: {
            lines: { type: 'number', description: 'Number of lines to read from the end of each log file.', default: 100 },
            filter: { type: 'string', description: 'A keyword or regex to filter log lines.' },
            maxSessions: { type: 'number', description: 'Maximum number of recent sessions to search. Default: 1, use 3-5 for MCP startup errors.', default: 1 }
        }
    }
};

// ============================================================
// get_mcp_best_practices
// ============================================================
export const getMcpBestPracticesDefinition = {
    name: 'get_mcp_best_practices',
    description: 'MCP configuration and debugging best practices guide.',
    inputSchema: {
        type: 'object',
        properties: {
            mcp_name: { type: 'string', description: 'Nom optionnel du MCP spécifique à analyser (ex: "roo-state-manager", "quickfiles", etc.). Si fourni, inclut l\'arborescence de développement et la configuration du MCP.' }
        }
    }
};

// ============================================================
// export_data
// ============================================================
export const exportDataDefinition = {
    name: 'export_data',
    description: 'Export data as XML, JSON or CSV. Targets: task, conversation, project.',
    inputSchema: {
        type: 'object',
        properties: {
            target: { type: 'string', enum: ['task', 'conversation', 'project'], description: 'Export target: task, conversation, or project' },
            format: { type: 'string', enum: ['xml', 'json', 'csv'], description: 'Output format: xml, json, or csv' },
            taskId: { type: 'string', description: 'Task ID (required for target=task, or conversation with json/csv)' },
            conversationId: { type: 'string', description: 'Root conversation ID (required for target=conversation with xml)' },
            projectPath: { type: 'string', description: 'Project path (required for target=project)' },
            filePath: { type: 'string', description: 'Output file path. If omitted, returns content inline.' },
            includeContent: { type: 'boolean', description: 'Include full message content (XML, default: false)' },
            prettyPrint: { type: 'boolean', description: 'Indent for readability (XML, default: true)' },
            maxDepth: { type: 'integer', description: 'Max tree depth (XML conversation)' },
            startDate: { type: 'string', description: 'ISO 8601 start date filter (XML project)' },
            endDate: { type: 'string', description: 'ISO 8601 end date filter (XML project)' },
            jsonVariant: { type: 'string', enum: ['light', 'full'], description: 'JSON variant: light (skeleton) or full (complete)' },
            csvVariant: { type: 'string', enum: ['conversations', 'messages', 'tools'], description: 'CSV variant: conversations, messages, or tools' },
            truncationChars: { type: 'number', description: 'Max chars before truncation (0 = no truncation)' },
            startIndex: { type: 'number', description: 'Start index (1-based) for message range' },
            endIndex: { type: 'number', description: 'End index (1-based) for message range' }
        },
        required: ['target', 'format']
    }
};

// ============================================================
// export_config
// ============================================================
export const exportConfigDefinition = {
    name: 'export_config',
    description: 'Gère la configuration des exports. Actions: get, set (requiert config), reset.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['get', 'set', 'reset'], description: 'Operation: get, set, or reset' },
            config: { type: 'object', description: 'Config object (required for set)' }
        },
        required: ['action']
    }
};

// ============================================================
// view_task_details
// ============================================================
export const viewTaskDetailsDefinition = {
    name: 'view_task_details',
    description: 'Full technical details (action metadata) for a specific task.',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: { type: 'string', description: 'Task ID.' },
            action_index: { type: 'number', description: 'Optional action index (0-based).' },
            truncate: { type: 'number', description: 'Lines to keep at start/end (0 = full).', default: 0 }
        },
        required: ['task_id']
    }
};

// ============================================================
// get_raw_conversation
// ============================================================
export const getRawConversationDefinition = {
    name: 'get_raw_conversation',
    description: 'Raw conversation content (JSON files) without condensation.',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: { type: 'string', description: 'Task ID to retrieve.' }
        },
        required: ['taskId']
    }
};

// ============================================================
// analyze_roosync_problems
// ============================================================
export const analyzeRooSyncProblemsDefinition = {
    name: 'analyze_roosync_problems',
    description: 'Analyse sync-roadmap.md pour détecter problèmes structurels et incohérences.',
    inputSchema: {
        type: 'object',
        properties: {
            roadmapPath: { type: 'string', description: 'Path to sync-roadmap.md (auto-detected if omitted)' },
            generateReport: { type: 'boolean', description: 'Generate report in roo-config/reports' }
        }
    }
};

// ============================================================
// RooSync tools — static metadata objects (22 tools → 19 after removing 3 deprecated definitions #1863)
// ============================================================

export const roosyncInitDefinition = {
    name: 'roosync_init',
    description: 'Initialiser l\'infrastructure RooSync (dashboard, roadmap, répertoires)',
    inputSchema: {
        type: 'object',
        properties: {
            force: { type: 'boolean', description: 'Force reinit even if files exist' },
            createRoadmap: { type: 'boolean', description: 'Create initial sync-roadmap.md' }
        },
        additionalProperties: false
    }
};

export const roosyncGetStatusDefinition = {
    name: 'roosync_get_status',
    description: 'Snapshot compact de l\'état RooSync. detail="full" ajoute claims et pipeline stages.',
    inputSchema: {
        type: 'object',
        properties: {
            machineFilter: { type: 'string', description: 'Machine ID filter' },
            resetCache: { type: 'boolean', description: 'Force service cache reset' },
            detail: { type: 'string', enum: ['compact', 'full'], description: '"compact" (minimal) or "full" (adds claims + pipeline stages)' }
        },
        additionalProperties: false
    }
};

export const roosyncCompareConfigDefinition = {
    name: 'roosync_compare_config',
    description: 'Compare les configurations Roo entre deux machines (modes, MCPs, settings, env). Granularité: mcp, mode, settings, claude, modes-yaml, full.',
    inputSchema: {
        type: 'object',
        properties: {
            source: { type: 'string', description: 'Source machine ID (default: local)' },
            target: { type: 'string', description: 'Target machine ID or profile (default: remote)' },
            force_refresh: { type: 'boolean', description: 'Force inventory collection even with valid cache' },
            granularity: { type: 'string', enum: ['mcp', 'mode', 'settings', 'claude', 'modes-yaml', 'full'], description: 'Granularity: mcp, mode, settings, claude, modes-yaml, full' },
            filter: { type: 'string', description: 'Path filter (e.g. "jupyter")' }
        },
        additionalProperties: false
    }
};

export const roosyncListDiffsDefinition = {
    name: 'roosync_list_diffs',
    description: 'Lister les différences détectées entre machines',
    inputSchema: {
        type: 'object',
        properties: {
            filterType: { type: 'string', enum: ['all', 'config', 'files', 'settings'], description: 'Filter by diff type', default: 'all' },
            forceRefresh: { type: 'boolean', description: 'Force cache refresh to avoid stale data', default: false }
        },
        additionalProperties: false
    }
};

// roosync_decision — inlined from zodToJsonSchema(RooSyncDecisionArgsSchema)
export const roosyncDecisionDefinition = {
    name: 'roosync_decision',
    description: 'Gère le workflow de décision RooSync (approve/reject/apply/rollback/info). Action "info" = consultation read-only (fused from roosync_decision_info).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['approve', 'reject', 'apply', 'rollback', 'info'], description: 'Decision action. "info" = read-only.' },
            decisionId: { type: 'string', description: 'Decision ID' },
            comment: { type: 'string', description: 'Comment (approve)' },
            reason: { type: 'string', description: 'Reason (reject/rollback)' },
            dryRun: { type: 'boolean', description: 'Simulation mode (apply)' },
            force: { type: 'boolean', description: 'Force apply despite conflicts' },
            includeHistory: { type: 'boolean', description: 'Include full history (info)', default: true },
            includeLogs: { type: 'boolean', description: 'Include execution logs (info)', default: true }
        },
        required: ['action', 'decisionId']
    }
};

// [REMOVED #1863] roosyncDecisionInfoDefinition — fused into roosync_decision(action: "info")
// CallTool redirect in registry.ts preserved for backward compat.

export const roosyncBaselineDefinition = {
    name: 'roosync_baseline',
    description: 'Outil consolidé pour gérer les baselines RooSync (update, version, restore, export, list_versions, current_version)',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['update', 'version', 'restore', 'export', 'list_versions', 'current_version'], description: 'Baseline action' },
            machineId: { type: 'string', description: '[update] Machine ID or profile name' },
            mode: { type: 'string', enum: ['standard', 'profile'], description: '[update] Update mode' },
            aggregationConfig: { type: 'object', description: '[update] Aggregation config (profile mode only)' },
            version: { type: 'string', description: '[update/version] Baseline version' },
            createBackup: { type: 'boolean', description: '[update/restore] Create backup (default: true)' },
            updateReason: { type: 'string', description: '[update/restore] Reason for change' },
            updatedBy: { type: 'string', description: '[update] Author' },
            message: { type: 'string', description: '[version] Git tag message' },
            pushTags: { type: 'boolean', description: '[version] Push tags (default: true)' },
            createChangelog: { type: 'boolean', description: '[version] Update CHANGELOG (default: true)' },
            source: { type: 'string', description: '[restore] Restore source (git tag or backup path)' },
            targetVersion: { type: 'string', description: '[restore] Target version' }
        },
        additionalProperties: false
    }
};

export const roosyncConfigDefinition = {
    name: 'roosync_config',
    description: 'RooSync config management. Actions: collect, publish, apply, apply_profile. Targets: modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, mcp:<server>.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['collect', 'publish', 'apply', 'apply_profile'], description: 'Action: collect, publish, apply, or apply_profile' },
            machineId: { type: 'string', description: 'Machine ID (default: ROOSYNC_MACHINE_ID)' },
            dryRun: { type: 'boolean', description: 'Simulate without modifying files (default: false)' },
            scope: { type: 'string', enum: ['user', 'project', 'settings'], description: 'Claude Code config scope: user, project, or settings' },
            targets: { type: 'array', items: { type: 'string' }, description: 'Targets: modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, mcp:<server>' },
            packagePath: { type: 'string', description: 'Package path (publish). If omitted with targets, collect+publish atomically.' },
            version: { type: 'string', description: 'Config version. Required for publish.' },
            description: { type: 'string', description: 'Change description (required for publish).' },
            backup: { type: 'boolean', description: 'Backup before apply (default: true).' },
            profileName: { type: 'string', description: 'Profile name (required for apply_profile).' },
            sourceMachineId: { type: 'string', description: 'Source machine for model-configs.json.' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncInventoryDefinition = {
    name: 'roosync_inventory',
    description: 'Machine inventory and heartbeat status. type="machines" for offline/warning machines.',
    inputSchema: {
        type: 'object',
        properties: {
            type: { type: 'string', enum: ['machine', 'heartbeat', 'all', 'machines'], description: 'Inventory type. "machines" = offline/warning only.' },
            machineId: { type: 'string', description: 'Machine ID (default: hostname)' },
            includeHeartbeats: { type: 'boolean', description: 'Include heartbeat data (default: true)' },
            status: { type: 'string', enum: ['offline', 'warning', 'all'], description: 'Filter by status (type="machines")' },
            includeDetails: { type: 'boolean', description: 'Full machine details (type="machines")' }
        },
        required: ['type'],
        additionalProperties: false
    }
};

// [REMOVED #1863] roosyncMachinesDefinition — fused into roosync_inventory(type: "machines")
// CallTool redirect in registry.ts preserved for backward compat.

// #1609: roosync_heartbeat retiré — auto-heartbeat now triggered on any tool call
export const roosyncMcpManagementDefinition = {
    name: 'roosync_mcp_management',
    description: 'Gestion des serveurs MCP. Actions: manage (read/write/backup/update/toggle/sync_always_allow), rebuild (build+restart), touch (force reload).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['manage', 'rebuild', 'touch'], description: 'Operation: manage (config), rebuild (build+restart), touch (force reload)' },
            subAction: { type: 'string', enum: ['read', 'write', 'backup', 'update_server', 'update_server_field', 'toggle_server', 'sync_always_allow'], description: 'manage sub-action: read, write, backup, update_server, update_server_field, toggle_server, sync_always_allow' },
            server_name: { type: 'string', description: 'MCP server name (for update/toggle/sync operations)' },
            server_config: { type: 'object', description: 'Server config. update_server: replaces all. update_server_field: merges.' },
            settings: { type: 'object', description: 'Paramètres complets (pour write)' },
            backup: { type: 'boolean', description: 'Backup before modify (default: true)' },
            tools: { type: 'array', items: { type: 'string' }, description: 'Tool names to auto-approve (sync_always_allow)' },
            mcp_name: { type: 'string', description: 'MCP name to rebuild (required for rebuild)' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncStorageManagementDefinition = {
    name: 'roosync_storage_management',
    description: 'Inspection et maintenance du stockage Roo. Actions: storage (detect/stats), maintenance (cache_rebuild/diagnose_bom/repair_bom).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['storage', 'maintenance'], description: 'Operation: storage (inspect) or maintenance (repair/rebuild)' },
            storageAction: { type: 'string', enum: ['detect', 'stats'], description: 'storage sub-action: detect or stats' },
            maintenanceAction: { type: 'string', enum: ['cache_rebuild', 'diagnose_bom', 'repair_bom'], description: 'maintenance sub-action: cache_rebuild, diagnose_bom, repair_bom' },
            force_rebuild: { type: 'boolean', description: 'Force full cache rebuild' },
            workspace_filter: { type: 'string', description: 'Workspace filter (cache_rebuild)' },
            task_ids: { type: 'array', items: { type: 'string' }, description: 'Specific task IDs to rebuild' },
            fix_found: { type: 'boolean', description: 'Auto-fix corrupted files (diagnose_bom)' },
            dry_run: { type: 'boolean', description: 'Simulate without modifying files (repair_bom)' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncDiagnoseDefinition = {
    name: 'roosync_diagnose',
    description: 'Diagnostic et debug RooSync. Actions: env, debug, reset, test.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['env', 'debug', 'reset', 'test'], description: 'Operation: env, debug, reset, test' },
            checkDiskSpace: { type: 'boolean', description: 'Check disk space (env)' },
            verbose: { type: 'boolean', description: 'Verbose mode (debug)' },
            clearCache: { type: 'boolean', description: 'Clear cache on reset' },
            confirm: { type: 'boolean', description: 'Confirmation for reset' },
            message: { type: 'string', description: 'Custom test message (test)' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncRefreshDashboardDefinition = {
    name: 'roosync_refresh_dashboard',
    description: '[DEPRECATED #1935] Use roosync_dashboard(action: "refresh") instead. Rafraîchit le dashboard MCP en exécutant le script generate-mcp-dashboard.ps1',
    inputSchema: {
        type: 'object',
        properties: {
            baseline: { type: 'string', description: 'Baseline machine (default: myia-ai-01)' },
            outputDir: { type: 'string', description: 'Output directory (default: $ROOSYNC_SHARED_PATH/dashboards)' }
        },
        additionalProperties: false
    }
};

export const roosyncUpdateDashboardDefinition = {
    name: 'roosync_update_dashboard',
    description: '[DEPRECATED #1935] Use roosync_dashboard(action: "update") instead. Met à jour une section du dashboard hiérarchique RooSync sur GDrive (#546)',
    inputSchema: {
        type: 'object',
        properties: {
            section: { type: 'string', enum: ['machine', 'global', 'intercom', 'decisions', 'metrics'], description: 'Dashboard section to update' },
            content: { type: 'string', description: 'Markdown content to insert' },
            machine: { type: 'string', description: 'Machine ID (required for section=machine)' },
            workspace: { type: 'string', description: 'Workspace (default: roo-extensions)' },
            mode: { type: 'string', enum: ['replace', 'append', 'prepend'], description: 'Update mode: replace, append, prepend' }
        },
        required: ['section', 'content'],
        additionalProperties: false
    }
};

export const roosyncSendDefinition = {
    name: 'roosync_send',
    description: 'Send, reply to, or amend a RooSync inter-machine message',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['send', 'reply', 'amend'], description: 'Action: send, reply, or amend' },
            to: { type: 'string', description: 'Recipient: machine or machine:workspace. Required for send.' },
            subject: { type: 'string', description: 'Message subject. Required for send.' },
            body: { type: 'string', description: 'Message body (markdown). Required for send/reply.' },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], description: 'Priority (default: MEDIUM)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
            thread_id: { type: 'string', description: 'Thread ID for grouping' },
            reply_to: { type: 'string', description: 'Message ID being replied to (for send)' },
            message_id: { type: 'string', description: 'Message ID (required for reply/amend)' },
            new_content: { type: 'string', description: 'New content (required for amend)' },
            reason: { type: 'string', description: 'Amend reason (optional)' },
            auto_destruct: { type: 'boolean', description: 'Auto-destruct after read (default: false)' },
            destruct_after_read_by: { type: 'array', items: { type: 'string' }, description: 'Machines that must read before destruction.' },
            destruct_after: { type: 'string', description: 'TTL before destruction (e.g., "30m", "2h", "1d").' },
            attachments: { type: 'array', description: 'File attachments', items: { type: 'object', properties: { path: { type: 'string', description: 'Local file path' }, filename: { type: 'string', description: 'Filename (default: basename)' } } } }
        }
    }
};

export const roosyncReadDefinition = {
    name: 'roosync_read',
    description: 'Read RooSync inbox, message details, or attachments.',
    inputSchema: {
        type: 'object',
        properties: {
            mode: { type: 'string', enum: ['inbox', 'message', 'attachments'], description: "Mode de lecture : inbox (liste des messages), message (détails d'un message), ou attachments (pièces jointes d'un message)" },
            status: { type: 'string', enum: ['unread', 'read', 'all'], description: 'Filtrer par status (mode inbox, défaut: all)' },
            limit: { type: 'number', description: 'Nombre maximum de messages à retourner (mode inbox). Use page/per_page for pagination instead.' },
            page: { type: 'number', description: 'Page number (1-based) for pagination. Requires per_page.' },
            per_page: { type: 'number', description: 'Messages per page. Requires page. Recommended: 20.' },
            message_id: { type: 'string', description: "ID du message à récupérer (requis pour mode=message ou mode=attachments)" },
            mark_as_read: { type: 'boolean', description: 'Marquer automatiquement comme lu (mode message, défaut: false)' },
            workspace: { type: 'string', description: '(mode inbox) Override workspace filter for multi-workspace schedulers.' },
            to_machine: { type: 'string', description: '(mode inbox) Override machine filter. Default: local machine.' }
        },
        required: ['mode']
    }
};

export const roosyncManageDefinition = {
    name: 'roosync_manage',
    description: 'Manage RooSync messages: mark_read, archive, bulk ops, cleanup, inbox stats.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['mark_read', 'archive', 'bulk_mark_read', 'bulk_archive', 'cleanup', 'stats'], description: 'Action: mark_read, archive, bulk_*, cleanup, stats' },
            message_id: { type: 'string', description: 'Message ID (mark_read/archive)' },
            from: { type: 'string', description: 'Filter by sender (bulk/cleanup)' },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], description: 'Filter by priority (bulk)' },
            before_date: { type: 'string', description: 'Filter before ISO-8601 date (bulk)' },
            subject_contains: { type: 'string', description: 'Filter by subject (bulk)' },
            tag: { type: 'string', description: 'Filter by tag (bulk)' }
        },
        required: ['action']
    }
};

// [REMOVED #1863] roosyncCleanupMessagesDefinition — fused into roosync_manage(action: "bulk_mark_read"/"bulk_archive")
// CallTool redirect in registry.ts preserved for backward compat.

export const roosyncAttachmentsDefinition = {
    name: 'roosync_attachments',
    description: 'Gestion des pièces jointes RooSync. Actions: list, get, delete.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['list', 'get', 'delete'], description: 'Action: list, get, delete' },
            message_id: { type: 'string', description: 'Message ID (list: optional filter; get/delete: optional if uuid given)' },
            uuid: { type: 'string', description: 'Attachment UUID (required for get/delete)' },
            targetPath: { type: 'string', description: 'Local destination path (required for get)' }
        },
        required: ['action']
    }
};

// #1470: Derived from Zod schema in dashboard-schemas.ts (single source of truth)
export const roosyncDashboardDefinition = dashboardToolMetadata;

// ============================================================
// roosync_claim (#1836)
// ============================================================
export const roosyncClaimDefinition = {
    name: 'roosync_claim',
    description: 'Pre-claim enforcement for concurrent agent collision prevention. Actions: claim, release, extend, list, check. Auto-expire after eta * 1.5 min.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['claim', 'release', 'extend', 'list', 'check'], description: 'Action: "claim" (reserve issue), "release" (free claim), "extend" (prolong), "list" (active claims), "check" (verify issue status)' },
            issue_number: { type: 'string', description: 'Issue number (e.g., "1836"). Required for claim/check. Optional for release/extend.' },
            agent: { type: 'string', description: 'Agent identifier (machine ID). Defaults to local machine.' },
            eta_minutes: { type: 'number', description: 'Estimated time in minutes. Required for claim action.' },
            branch: { type: 'string', description: 'Git branch name for the claim (optional).' },
            claim_id: { type: 'string', description: 'Claim ID. Required for release/extend (or use issue_number).' },
            additional_minutes: { type: 'number', description: 'Additional minutes for extend action.' }
        },
        required: ['action']
    }
};

// ============================================================
// allToolDefinitions — the complete ordered list for ListTools
// This mirrors the order in the current registerListToolsHandler.
// ============================================================
export const allToolDefinitions = [
    // CONS-X (#457): conversation_browser
    conversationBrowserDefinition,
    taskExportDefinition,
    // CONS-11: Search/Indexing
    roosyncSearchDefinition,
    roosyncIndexingDefinition,
    // #452 Phase 2: codebase_search
    codebaseSearchDefinition,
    readVscodeLogsDefinition,
    getMcpBestPracticesDefinition,
    // CONS-10: Export
    exportDataDefinition,
    exportConfigDefinition,
    viewTaskDetailsDefinition,
    getRawConversationDefinition,
    // WP4: Diagnostic
    analyzeRooSyncProblemsDefinition,
    // RooSync tools (23) — same order as roosyncTools array in roosync/index.ts
    roosyncInitDefinition,
    roosyncGetStatusDefinition,
    roosyncCompareConfigDefinition,
    roosyncListDiffsDefinition,
    roosyncDecisionDefinition,
    // [REMOVED #1863] roosyncDecisionInfoDefinition — not listed in tools/list, redirect in registry.ts
    roosyncBaselineDefinition,
    roosyncConfigDefinition,
    roosyncInventoryDefinition,
    // [REMOVED #1863] roosyncMachinesDefinition — not listed in tools/list, redirect in registry.ts
    // #1609: roosyncHeartbeatDefinition retiré — auto-heartbeat on any tool call
    roosyncMcpManagementDefinition,
    roosyncStorageManagementDefinition,
    roosyncDiagnoseDefinition,
    roosyncRefreshDashboardDefinition,
    roosyncUpdateDashboardDefinition,
    roosyncSendDefinition,
    roosyncReadDefinition,
    roosyncManageDefinition,
    // [REMOVED #1863] roosyncCleanupMessagesDefinition — not listed in tools/list, redirect in registry.ts
    roosyncAttachmentsDefinition,
    roosyncDashboardDefinition,
    // #1836: Pre-claim enforcement
    roosyncClaimDefinition
];
