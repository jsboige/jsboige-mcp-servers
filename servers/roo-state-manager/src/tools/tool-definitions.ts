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
    description: 'Navigate, visualize and summarize conversations. Actions: list, tree, current, view, summarize (trace/cluster), rebuild. Gotchas: (1) ALWAYS start with "list" to discover IDs — other actions need task_id. (2) synthesis is disabled (#788), use trace or cluster. (3) For view, use smart_truncation:true for conversations >10K chars.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['list', 'tree', 'current', 'view', 'summarize', 'rebuild'], description: 'Start with "list" to discover task IDs.' },
            // --- list ---
            limit: { type: 'number', description: '[list] Max conversations to return.' },
            page: { type: 'number', description: '[list] Page number (1-based). Default: 1.' },
            per_page: { type: 'number', description: '[list] Results per page (10-100). Default: 10.' },
            sortBy: { type: 'string', enum: ['lastActivity', 'messageCount', 'totalSize'], default: 'lastActivity' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            pendingSubtaskOnly: { type: 'boolean' },
            contentPattern: { type: 'string' },
            workspacePathMatch: { type: 'string', enum: ['exact', 'normalized', 'substring'], default: 'normalized', description: '[list] Workspace matching strategy.' },
            startDate: { type: 'string', description: '[list] Start date filter (ISO 8601 or YYYY-MM-DD).' },
            endDate: { type: 'string', description: '[list] End date filter (ISO 8601 or YYYY-MM-DD).' },
            machineId: { type: 'string', description: '[list] Filter by machine ID.' },
            includeArchives: { type: 'boolean', default: true, description: '[list] Include cross-machine GDrive archives (Tier 3).' },
            // --- tree ---
            conversation_id: { type: 'string', description: '[tree] Conversation ID.' },
            max_depth: { type: 'number', description: '[tree] Max tree depth.' },
            include_siblings: { type: 'boolean', default: true },
            output_format: { type: 'string', enum: ['json', 'markdown', 'ascii-tree', 'hierarchical'], default: 'json' },
            current_task_id: { type: 'string' },
            truncate_instruction: { type: 'number', default: 80 },
            show_metadata: { type: 'boolean', default: false },
            // --- current/view ---
            workspace: { type: 'string' },
            task_id: { type: 'string' },
            view_mode: { type: 'string', enum: ['single', 'chain', 'cluster'], default: 'chain' },
            detail_level: { type: 'string', enum: ['skeleton', 'summary', 'full'], default: 'skeleton' },
            truncate: { type: 'number', description: '0 = smart truncation.', default: 0 },
            max_output_length: { type: 'number', default: 300000 },
            smart_truncation: { type: 'boolean', default: false },
            smart_truncation_config: { type: 'object', properties: { gradientStrength: { type: 'number' }, minPreservationRate: { type: 'number' }, maxTruncationRate: { type: 'number' } } },
            messageStart: { type: 'number', description: '[view] 0-based start index (inclusive).' },
            messageEnd: { type: 'number', description: '[view] 0-based end index (exclusive).' },
            output_file: { type: 'string' },
            // --- summarize ---
            summarize_type: { type: 'string', enum: ['trace', 'cluster'], description: 'trace=stats/timeline, cluster=parent-child. Note: synthesis disabled (#788).' },
            taskId: { type: 'string' },
            source: { type: 'string', enum: ['roo', 'claude', 'all'], default: 'roo' },
            filePath: { type: 'string' },
            summarize_output_format: { type: 'string', enum: ['markdown', 'html', 'json'], default: 'markdown' },
            detailLevel: { type: 'string', enum: ['Full', 'NoTools', 'NoResults', 'Messages', 'Summary', 'UserOnly'], default: 'Full' },
            truncationChars: { type: 'number', description: '0 = no truncation.', default: 0 },
            compactStats: { type: 'boolean', default: false },
            includeCss: { type: 'boolean', default: true },
            generateToc: { type: 'boolean', default: true },
            startIndex: { type: 'number', description: '1-based.' },
            endIndex: { type: 'number' },
            childTaskIds: { type: 'array', items: { type: 'string' } },
            clusterMode: { type: 'string', enum: ['aggregated', 'detailed', 'comparative'], default: 'aggregated' },
            includeClusterStats: { type: 'boolean', default: true },
            crossTaskAnalysis: { type: 'boolean', default: false },
            maxClusterDepth: { type: 'number', default: 10 },
            clusterSortBy: { type: 'string', enum: ['chronological', 'size', 'activity', 'alphabetical'], default: 'chronological' },
            includeClusterTimeline: { type: 'boolean', default: false },
            clusterTruncationChars: { type: 'number', default: 0 },
            showTaskRelationships: { type: 'boolean', default: true },
            // --- rebuild ---
            force_rebuild: { type: 'boolean', description: 'Rebuild all (slow). Default: missing/stale only.', default: false },
            task_ids: { type: 'array', items: { type: 'string' } },
            sources: { type: 'array', items: { type: 'string', enum: ['roo', 'claude', 'archive'] }, description: '[rebuild] Skeleton sources. Default: ["roo"].' },
            reindex: { type: 'boolean', default: false, description: '[rebuild] Force Qdrant reindex for all built skeletons.' }
        },
        required: ['action']
    }
};

// ============================================================
// task_export
// ============================================================
export const taskExportDefinition = {
    name: 'task_export',
    description: 'Export/diagnose tasks. Actions: markdown (file export), debug (parsing diagnostics).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['markdown', 'debug'] },
            conversation_id: { type: 'string' },
            filePath: { type: 'string', description: 'If omitted, returns content.' },
            max_depth: { type: 'number' },
            include_siblings: { type: 'boolean', default: true },
            output_format: { type: 'string', enum: ['ascii-tree', 'markdown', 'hierarchical', 'json'], default: 'ascii-tree' },
            current_task_id: { type: 'string' },
            truncate_instruction: { type: 'number', default: 80 },
            show_metadata: { type: 'boolean', default: false },
            task_id: { type: 'string', description: '[debug] ID de la tâche à analyser en détail.' }
        },
        required: ['action']
    }
};

// ============================================================
// roosync_search
// ============================================================
export const roosyncSearchDefinition = {
    name: 'roosync_search',
    description: "Recherche unifiée dans les tâches Roo (semantic, text, index diagnostics). Gotcha: workspace defaults to MCP server workspace — pass '*' or 'all' for cross-workspace search.",
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['semantic', 'text', 'diagnose'], description: 'semantic=Qdrant vector+auto-fallback, text=cache search, diagnose=index health' },
            search_query: { type: 'string', description: 'Required for semantic/text' },
            conversation_id: { type: 'string' },
            max_results: { type: 'number' },
            workspace: { type: 'string', description: 'Workspace name. Defaults to MCP server workspace — use "*" or "all" for cross-workspace search.' },
            source: { type: 'string', enum: ['roo', 'claude-code'] },
            chunk_type: { type: 'string', enum: ['message_exchange', 'tool_interaction'] },
            role: { type: 'string', enum: ['user', 'assistant'] },
            tool_name: { type: 'string' },
            has_errors: { type: 'boolean' },
            model: { type: 'string' },
            start_date: { type: 'string', description: 'ISO 8601 or YYYY-MM-DD' },
            end_date: { type: 'string', description: 'ISO 8601 or YYYY-MM-DD' },
            exclude_tool_results: { type: 'boolean' }
        },
        required: ['action']
    }
};

// ============================================================
// roosync_indexing
// ============================================================
export const roosyncIndexingDefinition = {
    name: 'roosync_indexing',
    description: "Manage semantic index, cache, and archiving (index, reset, rebuild, diagnose, archive, status, repair_gaps, cleanup, garbage_scan, cleanup_orphans)",
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status', 'repair_gaps', 'cleanup', 'garbage_scan', 'cleanup_orphans'], description: 'index=Qdrant, reset=clear, rebuild=SQLite, diagnose=health, archive=GDrive, status=metrics, repair_gaps=fix, cleanup=orphan tasks, garbage_scan=detect, cleanup_orphans=purge' },
            task_id: { type: 'string', description: 'Required for action=index' },
            confirm: { type: 'boolean', description: 'Required for action=reset', default: false },
            workspace_filter: { type: 'string' },
            max_tasks: { type: 'number', description: '0 = all', default: 0 },
            dry_run: { type: 'boolean', default: false },
            machine_id: { type: 'string' },
            claude_code_sessions: { type: 'boolean', default: false },
            max_sessions: { type: 'number', description: '0 = all', default: 0 },
            source: { type: 'string', enum: ['roo', 'claude-code'], description: "For action=index. Default: 'roo'" }
        },
        required: ['action']
    }
};

// ============================================================
// codebase_search
// ============================================================
export const codebaseSearchDefinition = {
    name: 'codebase_search',
    description: 'Recherche sémantique dans le code par concept. ALWAYS pass workspace explicitly — auto-detection hard-fails if MCP roots/WORKSPACE_PATH unavailable (#1861). Use English keywords matching code vocabulary, not natural language.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Semantic query in English (concept, not exact text). Ex: "rate limiting for embeddings", "authentication middleware"' },
            workspace: { type: 'string', description: 'REQUIRED: Absolute workspace path. Auto-detection may fail — always pass explicitly. Ex: "C:/dev/roo-extensions".' },
            directory_prefix: { type: 'string', description: 'Directory filter. Ex: "src/services"' },
            limit: { type: 'number', description: 'Max results (default: 15, max: 50)' },
            min_score: { type: 'number', description: 'Min similarity 0-1 (default: 0.5)' }
        },
        required: ['query']
    }
};

// ============================================================
// read_vscode_logs
// ============================================================
export const readVscodeLogsDefinition = {
    name: 'read_vscode_logs',
    description: 'Read latest VS Code Extension Host, Renderer, and Roo-Code logs.',
    inputSchema: {
        type: 'object',
        properties: {
            lines: { type: 'number', default: 100 },
            filter: { type: 'string', description: 'Keyword or regex' },
            maxSessions: { type: 'number', description: 'Use 3-5 for MCP startup errors.', default: 1 }
        }
    }
};

// ============================================================
// get_mcp_best_practices
// ============================================================
// [REMOVED #1935 Cluster D] getMcpBestPracticesDefinition — fused into roosync_diagnose(action: "best-practices")
// CallTool redirect in registry.ts preserved for backward compat.

// ============================================================
// export_data
// ============================================================
export const exportDataDefinition = {
    name: 'export_data',
    description: 'Export data as XML, JSON, CSV, Markdown, or debug parsing. Targets: task, conversation, project.',
    inputSchema: {
        type: 'object',
        properties: {
            target: { type: 'string', enum: ['task', 'conversation', 'project'] },
            format: { type: 'string', enum: ['xml', 'json', 'csv', 'markdown', 'debug'] },
            taskId: { type: 'string', description: 'Required for task target, or conversation with json/csv/debug' },
            conversationId: { type: 'string', description: 'Required for conversation with xml/markdown' },
            projectPath: { type: 'string', description: 'Required for project' },
            filePath: { type: 'string', description: 'Output path. If omitted, returns content.' },
            includeContent: { type: 'boolean', description: 'XML only' },
            prettyPrint: { type: 'boolean', default: true },
            maxDepth: { type: 'integer', description: 'XML/markdown' },
            startDate: { type: 'string', description: 'ISO 8601' },
            endDate: { type: 'string', description: 'ISO 8601' },
            jsonVariant: { type: 'string', enum: ['light', 'full'], description: 'light=skeleton, full' },
            csvVariant: { type: 'string', enum: ['conversations', 'messages', 'tools'] },
            truncationChars: { type: 'number', description: '0 = no truncation' },
            startIndex: { type: 'number', description: '1-based' },
            endIndex: { type: 'number' },
            outputFormat: { type: 'string', enum: ['ascii-tree', 'markdown', 'hierarchical', 'json'], description: 'Markdown sub-format' },
            includeSiblings: { type: 'boolean', default: true },
            currentTaskId: { type: 'string' },
            truncateInstruction: { type: 'number', default: 80 },
            showMetadata: { type: 'boolean', default: false }
        },
        required: ['target', 'format']
    }
};

// ============================================================
// export_config
// ============================================================
export const exportConfigDefinition = {
    name: 'export_config',
    description: 'Manage export configuration. Actions: get, set, reset.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['get', 'set', 'reset'] },
            config: { type: 'object', description: 'Required for action=set' }
        },
        required: ['action']
    }
};

// ============================================================
// view_task_details
// ============================================================
export const viewTaskDetailsDefinition = {
    name: 'view_task_details',
    description: 'View full technical details (action metadata) for a task',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: { type: 'string' },
            action_index: { type: 'number', description: '0-based' },
            truncate: { type: 'number', description: '0 = complete.', default: 0 }
        },
        required: ['task_id']
    }
};

// ============================================================
// get_raw_conversation
// ============================================================
export const getRawConversationDefinition = {
    name: 'get_raw_conversation',
    description: 'Get raw conversation JSON content (no condensation).',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: { type: 'string' }
        },
        required: ['taskId']
    }
};

// ============================================================
// analyze_roosync_problems
// ============================================================
// [REMOVED #1935 Cluster D] analyzeRooSyncProblemsDefinition — fused into roosync_diagnose(action: "analyze")
// CallTool redirect in registry.ts preserved for backward compat.

// ============================================================
// RooSync tools — static metadata objects (22 tools in roosyncTools array)
// ============================================================

export const roosyncInitDefinition = {
    name: 'roosync_init',
    description: 'Initialize RooSync infrastructure (dashboard, roadmap, directories)',
    inputSchema: {
        type: 'object',
        properties: {
            force: { type: 'boolean' },
            createRoadmap: { type: 'boolean' }
        },
        additionalProperties: false
    }
};

// [REMOVED #1935 Cluster E] roosyncGetStatusDefinition — fused into roosync_inventory(type: "status")
// CallTool redirect in registry.ts preserved for backward compat.

export const roosyncCompareConfigDefinition = {
    name: 'roosync_compare_config',
    description: 'Compare configs between machines. Levels: Config (CRITICAL), Environment (CRITICAL/WARNING), Hardware (IMPORTANT), Software (WARNING), System (INFO).',
    inputSchema: {
        type: 'object',
        properties: {
            source: { type: 'string', description: 'Default: local' },
            target: { type: 'string', description: 'Default: remote' },
            force_refresh: { type: 'boolean' },
            granularity: { type: 'string', enum: ['mcp', 'mode', 'settings', 'claude', 'modes-yaml', 'full'] },
            filter: { type: 'string', description: 'Path filter e.g. "jupyter"' }
        },
        additionalProperties: false
    }
};

export const roosyncListDiffsDefinition = {
    name: 'roosync_list_diffs',
    description: 'List detected config differences between machines',
    inputSchema: {
        type: 'object',
        properties: {
            filterType: { type: 'string', enum: ['all', 'config', 'files', 'settings'], default: 'all' },
            forceRefresh: { type: 'boolean', default: false }
        },
        additionalProperties: false
    }
};

// roosync_decision — inlined from zodToJsonSchema(RooSyncDecisionArgsSchema)
export const roosyncDecisionDefinition = {
    name: 'roosync_decision',
    description: 'Manage RooSync decisions: approve/reject/apply/rollback/info.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['approve', 'reject', 'apply', 'rollback', 'info'] },
            decisionId: { type: 'string' },
            comment: { type: 'string' },
            reason: { type: 'string', description: 'Required for reject/rollback' },
            dryRun: { type: 'boolean' },
            force: { type: 'boolean' },
            includeHistory: { type: 'boolean', default: true },
            includeLogs: { type: 'boolean', default: true }
        },
        required: ['action', 'decisionId']
    }
};

// #1863 FUSION A1: roosync_decision_info removed — use roosync_decision(action: "info")
export const roosyncBaselineDefinition = {
    name: 'roosync_baseline',
    description: 'Baseline management: update, version, restore, export, list_versions, current_version.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['update', 'version', 'restore', 'export', 'list_versions', 'current_version'] },
            machineId: { type: 'string', description: 'Machine ID or profile name' },
            mode: { type: 'string', enum: ['standard', 'profile'], description: 'Update mode' },
            aggregationConfig: { type: 'object', description: 'Aggregation config (profile mode only)' },
            version: { type: 'string', description: 'Baseline version (semver)' },
            createBackup: { type: 'boolean', default: true },
            updateReason: { type: 'string', description: 'Reason for change' },
            updatedBy: { type: 'string', description: 'Author' },
            message: { type: 'string', description: 'Git tag message' },
            pushTags: { type: 'boolean', default: true },
            createChangelog: { type: 'boolean', default: true },
            source: { type: 'string', description: 'Restore source (git tag or backup path)' },
            targetVersion: { type: 'string', description: 'Target version for restore' },
            restoredBy: { type: 'string', description: 'Author of restore operation' },
            format: { type: 'string', enum: ['json', 'yaml', 'csv'], description: 'Export format (required for export)' },
            outputPath: { type: 'string', description: 'Output path for exported file' },
            includeHistory: { type: 'boolean', default: false, description: 'Include modification history in export' },
            includeMetadata: { type: 'boolean', default: true, description: 'Include full metadata in export' },
            prettyPrint: { type: 'boolean', default: true, description: 'Pretty-print output for readability' }
        },
        additionalProperties: false
    }
};

export const roosyncConfigDefinition = {
    name: 'roosync_config',
    description: 'Config management. Actions: collect (local), publish (GDrive), apply (from GDrive), apply_profile. Targets: modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, mcp:<name>.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['collect', 'publish', 'apply', 'apply_profile'] },
            machineId: { type: 'string' },
            dryRun: { type: 'boolean' },
            scope: { type: 'string', enum: ['user', 'project', 'settings'], description: 'user=~/.claude.json, project=.mcp.json, settings=~/.claude/settings.json' },
            targets: { type: 'array', items: { type: 'string' }, description: 'Default: ["modes", "mcp"]' },
            packagePath: { type: 'string', description: 'Publish only. Omit with targets for collect+publish atomically' },
            version: { type: 'string', description: 'Required for publish. Default for apply: "latest"' },
            description: { type: 'string', description: 'Required for publish' },
            backup: { type: 'boolean', default: true },
            profileName: { type: 'string', description: 'Required for apply_profile' },
            sourceMachineId: { type: 'string', description: 'For model-configs.json' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncInventoryDefinition = {
    name: 'roosync_inventory',
    description: 'Machine inventory, heartbeat status, system snapshot. type="status" for compact RooSync status.',
    inputSchema: {
        type: 'object',
        properties: {
            type: { type: 'string', enum: ['machine', 'heartbeat', 'all', 'machines', 'status'], description: 'Inventory type to query' },
            machineId: { type: 'string', description: 'Machine ID filter (default: hostname)' },
            includeHeartbeats: { type: 'boolean', description: 'Include heartbeat data' },
            status: { type: 'string', enum: ['unknown', 'idle', 'all'], description: 'Filter by status (type=machines)' },
            includeDetails: { type: 'boolean', description: 'Full details or tool usage stats' },
            detail: { type: 'string', enum: ['compact', 'full'], description: 'compact or full (adds claims + pipeline stages)' },
            resetCache: { type: 'boolean', description: 'Force cache reset (status only)' },
            summary: { type: 'boolean', description: 'Return compact markdown summary instead of full JSON' }
        },
        required: ['type'],
        additionalProperties: false
    }
};

// #1863 FUSION A2: roosync_machines removed — use roosync_inventory(type: "machines")
// #1609: roosync_heartbeat retiré — auto-heartbeat now triggered on any tool call
export const roosyncMcpManagementDefinition = {
    name: 'roosync_mcp_management',
    description: 'MCP server management: manage (read/write/backup/update/toggle), rebuild (build+restart), touch (force reload).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['manage', 'rebuild', 'touch'] },
            subAction: { type: 'string', enum: ['read', 'write', 'backup', 'update_server', 'update_server_field', 'toggle_server', 'sync_always_allow'], description: 'update_server=REPLACE, update_server_field=MERGE' },
            server_name: { type: 'string' },
            server_config: { type: 'object' },
            settings: { type: 'object' },
            backup: { type: 'boolean', default: true },
            tools: { type: 'array', items: { type: 'string' } },
            mcp_name: { type: 'string', description: 'Required for rebuild' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncStorageManagementDefinition = {
    name: 'roosync_storage_management',
    description: 'Storage inspection and maintenance. Actions: storage (detect/stats), maintenance (cache_rebuild/diagnose_bom/repair_bom).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['storage', 'maintenance'] },
            storageAction: { type: 'string', enum: ['detect', 'stats'] },
            maintenanceAction: { type: 'string', enum: ['cache_rebuild', 'diagnose_bom', 'repair_bom'] },
            force_rebuild: { type: 'boolean' },
            workspace_filter: { type: 'string' },
            task_ids: { type: 'array', items: { type: 'string' } },
            fix_found: { type: 'boolean' },
            dry_run: { type: 'boolean' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncDiagnoseDefinition = {
    name: 'roosync_diagnose',
    description: 'RooSync diagnostics and debug. Actions: env, debug, reset, test, health (skeleton cache), analyze (roadmap), best-practices (MCP guide).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['env', 'debug', 'reset', 'test', 'health', 'analyze', 'best-practices'] },
            checkDiskSpace: { type: 'boolean' },
            verbose: { type: 'boolean' },
            clearCache: { type: 'boolean' },
            confirm: { type: 'boolean' },
            message: { type: 'string' },
            roadmapPath: { type: 'string', description: 'Auto-detected if omitted' },
            generateReport: { type: 'boolean' },
            mcp_name: { type: 'string', description: 'MCP name for best-practices action' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

// #1836 Phase 1: Pre-claim enforcement tool
export const roosyncClaimDefinition = {
    name: 'roosync_claim',
    description: 'Pre-claim enforcement — prevents concurrent agent collisions. Actions: claim, release, extend, list, check. Claims auto-expire after eta*1.5.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['claim', 'release', 'extend', 'list', 'check'] },
            issue_number: { type: 'string', description: 'Required for claim/check/release/extend' },
            agent: { type: 'string' },
            eta_minutes: { type: 'number', description: 'Required for claim' },
            branch: { type: 'string' },
            claim_id: { type: 'string', description: 'Required for release/extend' },
            additional_minutes: { type: 'number' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

// [#1935 Cluster B] DEPRECATED: roosync_refresh_dashboard + roosync_update_dashboard
// Removed from tools/list. Callers should use roosync_dashboard(action: "refresh"|"update").
// Backward-compat CallTool handlers remain in registry.ts (redirect to roosyncDashboard).

export const roosyncSendDefinition = {
    name: 'roosync_send',
    description: 'Send, reply, or amend RooSync messages (legacy — prefer roosync_messages)',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['send', 'reply', 'amend'], description: 'send, reply, or amend' },
            to: { type: 'string', description: 'machine or machine:workspace' },
            subject: { type: 'string' },
            body: { type: 'string' },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
            tags: { type: 'array', items: { type: 'string' } },
            thread_id: { type: 'string' },
            reply_to: { type: 'string' },
            message_id: { type: 'string' },
            new_content: { type: 'string' },
            reason: { type: 'string' },
            auto_destruct: { type: 'boolean' },
            destruct_after_read_by: { type: 'array', items: { type: 'string' } },
            destruct_after: { type: 'string', description: 'TTL: 30m, 2h, 1d' },
            attachments: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, filename: { type: 'string' } } } }
        }
    }
};

export const roosyncReadDefinition = {
    name: 'roosync_read',
    description: "Read RooSync inbox, message details, or attachments (legacy — prefer roosync_messages)",
    inputSchema: {
        type: 'object',
        properties: {
            mode: { type: 'string', enum: ['inbox', 'message', 'attachments'] },
            status: { type: 'string', enum: ['unread', 'read', 'all'] },
            limit: { type: 'number' },
            page: { type: 'number', description: '1-based' },
            per_page: { type: 'number' },
            message_id: { type: 'string', description: 'Required for mode=message/attachments' },
            mark_as_read: { type: 'boolean' },
            workspace: { type: 'string', description: 'Override workspace filter' },
            to_machine: { type: 'string', description: 'Override machine filter' }
        },
        required: ['mode']
    }
};

export const roosyncManageDefinition = {
    name: 'roosync_manage',
    description: 'Manage RooSync messages lifecycle: mark_read, archive, bulk ops, cleanup, stats (legacy — prefer roosync_messages)',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['mark_read', 'archive', 'bulk_mark_read', 'bulk_archive', 'cleanup', 'stats'] },
            message_id: { type: 'string', description: 'Required for mark_read/archive' },
            from: { type: 'string' },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
            before_date: { type: 'string', description: 'ISO-8601 filter' },
            subject_contains: { type: 'string' },
            tag: { type: 'string' }
        },
        required: ['action']
    }
};

// #1863 FUSION A3: roosync_cleanup_messages removed — use roosync_manage(action: "bulk_mark_read"/"bulk_archive")
export const roosyncAttachmentsDefinition = {
    name: 'roosync_attachments',
    description: "Manage RooSync attachments: list, get, delete (legacy — prefer roosync_messages)",
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['list', 'get', 'delete'] },
            message_id: { type: 'string' },
            uuid: { type: 'string', description: 'Required for get/delete' },
            targetPath: { type: 'string', description: 'Required for get' }
        },
        required: ['action']
    }
};

// #1841 Cluster G: Outil consolide messagerie (4→1: send+read+manage+attachments)
export const roosyncMessagesDefinition = {
    name: 'roosync_messages',
    description: 'Messagerie inter-machines. Actions: send/reply/amend, inbox/message, mark_read/archive, bulk_*, cleanup/stats, attachments_list/get/delete.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            action: {
                type: 'string',
                enum: [
                    'send', 'reply', 'amend',
                    'inbox', 'message',
                    'mark_read', 'archive', 'bulk_mark_read', 'bulk_archive', 'cleanup', 'stats',
                    'attachments_list', 'attachments_get', 'attachments_delete'
                ],
                description: 'Action to perform'
            },
            to: { type: 'string', description: 'machine or machine:workspace' },
            subject: { type: 'string' },
            body: { type: 'string' },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
            tags: { type: 'array', items: { type: 'string' } },
            thread_id: { type: 'string' },
            reply_to: { type: 'string', description: 'Reference message ID' },
            message_id: { type: 'string' },
            new_content: { type: 'string' },
            reason: { type: 'string' },
            auto_destruct: { type: 'boolean' },
            destruct_after_read_by: { type: 'array', items: { type: 'string' } },
            destruct_after: { type: 'string', description: 'TTL: 30m, 2h, 1d' },
            attachments: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { path: { type: 'string' }, filename: { type: 'string' } },
                    required: ['path']
                }
            },
            status: { type: 'string', enum: ['unread', 'read', 'all'] },
            limit: { type: 'number' },
            page: { type: 'number', description: '1-based' },
            per_page: { type: 'number' },
            mark_as_read: { type: 'boolean' },
            workspace: { type: 'string' },
            to_machine: { type: 'string' },
            from: { type: 'string' },
            before_date: { type: 'string', description: 'ISO date filter' },
            subject_contains: { type: 'string' },
            tag: { type: 'string' },
            uuid: { type: 'string' },
            targetPath: { type: 'string' },
            format: { type: 'string', enum: ['json', 'markdown'], description: 'Output format for inbox/message actions (default: markdown)' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

// #1470: Derived from Zod schema in dashboard-schemas.ts (single source of truth)
export const roosyncDashboardDefinition = dashboardToolMetadata;

// ============================================================
// allToolDefinitions — the complete ordered list for ListTools
// This mirrors the order in the current registerListToolsHandler.
// ============================================================
export const allToolDefinitions = [
    // CONS-X (#457): conversation_browser
    conversationBrowserDefinition,
    // [REMOVED #1841 Cluster H] taskExportDefinition — fused into export_data(format: "markdown"/"debug"), redirect in registry.ts
    // CONS-11: Search/Indexing
    roosyncSearchDefinition,
    roosyncIndexingDefinition,
    // #452 Phase 2: codebase_search
    codebaseSearchDefinition,
    readVscodeLogsDefinition,
    // [REMOVED #1841] getMcpBestPracticesDefinition — converted to static doc: docs/mcp-best-practices.md, redirect in registry.ts
    // CONS-10: Export
    exportDataDefinition,
    // [REMOVED #1841] exportConfigDefinition — rarely used, config accessible via export_data settings, redirect in registry.ts
    // [REMOVED #1841] viewTaskDetailsDefinition — conversation_browser(action: "view", detail_level: "Full") provides equivalent, redirect in registry.ts
    // [REMOVED #1841] getRawConversationDefinition — export_data(format: "json", target: "task") provides equivalent, redirect in registry.ts
    // WP4: Diagnostic
    // [REMOVED #1935 Cluster D] analyzeRooSyncProblemsDefinition — fused into roosync_diagnose(action: "analyze")
    // [REMOVED CONS-8 #603] roosyncInitDefinition — dead code (all machines initialized), redirect in registry.ts
    // [REMOVED #1935 Cluster E] roosyncGetStatusDefinition — fused into roosync_inventory(type: "status")
    roosyncCompareConfigDefinition,
    // [REMOVED CONS-8 #603] roosyncListDiffsDefinition — thin wrapper, use roosync_compare_config instead, redirect in registry.ts
    // [REMOVED CONS-8 #603] roosyncDecisionDefinition — pipeline mort (never operationalized), redirect in registry.ts
    roosyncBaselineDefinition,
    roosyncConfigDefinition,
    roosyncInventoryDefinition,
    // #1609: roosyncHeartbeatDefinition retiré — auto-heartbeat on any tool call
    roosyncMcpManagementDefinition,
    roosyncStorageManagementDefinition,
    roosyncDiagnoseDefinition,
    // [REMOVED CONS-8 #603] roosyncClaimDefinition — never adopted (#1836), redirect in registry.ts
    // [REMOVED #1935 Cluster B] roosyncRefreshDashboardDefinition — fused into roosync_dashboard(action: "refresh"), redirect in registry.ts
    // [REMOVED #1935 Cluster B] roosyncUpdateDashboardDefinition — fused into roosync_dashboard(action: "update"), redirect in registry.ts
    // [REMOVED #1841 Cluster G] roosyncSendDefinition — fused into roosync_messages(action: "send"/"reply"/"amend"), redirect in registry.ts
    // [REMOVED #1841 Cluster G] roosyncReadDefinition — fused into roosync_messages(action: "inbox"/"message"), redirect in registry.ts
    // [REMOVED #1841 Cluster G] roosyncManageDefinition — fused into roosync_messages(action: "mark_read"/"archive"/"bulk_*"/"cleanup"/"stats"), redirect in registry.ts
    // [REMOVED #1841 Cluster G] roosyncAttachmentsDefinition — fused into roosync_messages(action: "attachments_*"), redirect in registry.ts
    roosyncMessagesDefinition,
    roosyncDashboardDefinition
];
