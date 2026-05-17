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
    description: 'Navigate, visualize and summarize conversations. Actions: list, tree, current, view, summarize (trace/cluster/synthesis), rebuild. Start with "list" to discover task IDs.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['list', 'tree', 'current', 'view', 'summarize', 'rebuild'], description: 'Action. Use "list" first to discover conversation IDs.' },
            limit: { type: 'number', description: 'Max conversations to return.' },
            sortBy: { type: 'string', enum: ['lastActivity', 'messageCount', 'totalSize'], default: 'lastActivity' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            pendingSubtaskOnly: { type: 'boolean', description: 'Only tasks with pending subtasks.' },
            contentPattern: { type: 'string', description: 'Filter tasks containing this text.' },
            conversation_id: { type: 'string', description: 'Conversation ID for tree.' },
            max_depth: { type: 'number', description: 'Max tree depth.' },
            include_siblings: { type: 'boolean', default: true },
            output_format: { type: 'string', enum: ['json', 'markdown', 'ascii-tree', 'hierarchical'], default: 'json' },
            current_task_id: { type: 'string', description: 'Active task ID for marking.' },
            truncate_instruction: { type: 'number', default: 80 },
            show_metadata: { type: 'boolean', default: false },
            workspace: { type: 'string', description: 'Workspace path (auto-detected if omitted).' },
            task_id: { type: 'string', description: 'Starting task ID.' },
            view_mode: { type: 'string', enum: ['single', 'chain', 'cluster'], default: 'chain' },
            detail_level: { type: 'string', enum: ['skeleton', 'summary', 'full'], default: 'skeleton' },
            truncate: { type: 'number', description: 'Lines to keep at start/end (0 = smart).', default: 0 },
            max_output_length: { type: 'number', default: 300000 },
            smart_truncation: { type: 'boolean', description: 'Gradient-based smart truncation.', default: false },
            smart_truncation_config: { type: 'object', description: 'Smart truncation config.', properties: { gradientStrength: { type: 'number' }, minPreservationRate: { type: 'number' }, maxTruncationRate: { type: 'number' } } },
            output_file: { type: 'string', description: 'Save tree to file.' },
            summarize_type: { type: 'string', enum: ['trace', 'cluster', 'synthesis'], description: 'Summary type (required for summarize). trace=stats/timeline, cluster=parent-child groups, synthesis=LLM analysis.' },
            taskId: { type: 'string', description: 'Task ID (root task for cluster).' },
            source: { type: 'string', enum: ['roo', 'claude', 'all'], default: 'roo' },
            filePath: { type: 'string', description: 'Save output to file.' },
            summarize_output_format: { type: 'string', enum: ['markdown', 'html', 'json'], default: 'markdown' },
            detailLevel: { type: 'string', enum: ['Full', 'NoTools', 'NoResults', 'Messages', 'Summary', 'UserOnly'], default: 'Full' },
            truncationChars: { type: 'number', description: 'Max chars before truncation (0 = no truncation).', default: 0 },
            compactStats: { type: 'boolean', default: false },
            includeCss: { type: 'boolean', default: true },
            generateToc: { type: 'boolean', default: true },
            startIndex: { type: 'number', description: 'Start index (1-based).' },
            endIndex: { type: 'number', description: 'End index (1-based).' },
            childTaskIds: { type: 'array', items: { type: 'string' }, description: 'Child task IDs.' },
            clusterMode: { type: 'string', enum: ['aggregated', 'detailed', 'comparative'], default: 'aggregated' },
            includeClusterStats: { type: 'boolean', default: true },
            crossTaskAnalysis: { type: 'boolean', default: false },
            maxClusterDepth: { type: 'number', default: 10 },
            clusterSortBy: { type: 'string', enum: ['chronological', 'size', 'activity', 'alphabetical'], default: 'chronological' },
            includeClusterTimeline: { type: 'boolean', default: false },
            clusterTruncationChars: { type: 'number', default: 0 },
            showTaskRelationships: { type: 'boolean', default: true },
            synthesis_output_format: { type: 'string', enum: ['json', 'markdown'], description: 'Synthesis format. json=full analysis, markdown=narrative.', default: 'json' },
            force_rebuild: { type: 'boolean', description: 'Rebuild ALL skeletons (slow). Default: only missing/stale.', default: false },
            task_ids: { type: 'array', items: { type: 'string' }, description: 'Specific task IDs to rebuild.' }
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
            action: { type: 'string', enum: ['markdown', 'debug'], description: 'Action à effectuer: "markdown" pour exporter l\'arbre, "debug" pour diagnostiquer le parsing.' },
            conversation_id: { type: 'string', description: "[markdown] ID de la conversation pour laquelle exporter l'arbre des tâches." },
            filePath: { type: 'string', description: '[markdown] Chemin optionnel pour sauvegarder le fichier. Si omis, le contenu est retourné.' },
            max_depth: { type: 'number', description: "[markdown] Profondeur maximale de l'arbre à inclure dans l'export." },
            include_siblings: { type: 'boolean', description: '[markdown] Inclure les tâches sœurs (même parent) dans l\'arbre.', default: true },
            output_format: { type: 'string', enum: ['ascii-tree', 'markdown', 'hierarchical', 'json'], description: '[markdown] Format de sortie: ascii-tree (défaut), markdown, hierarchical, ou json.', default: 'ascii-tree' },
            current_task_id: { type: 'string', description: "[markdown] ID de la tâche en cours d'exécution pour marquage explicite." },
            truncate_instruction: { type: 'number', description: "[markdown] Longueur maximale de l'instruction affichée (défaut: 80).", default: 80 },
            show_metadata: { type: 'boolean', description: '[markdown] Afficher les métadonnées détaillées (défaut: false).', default: false },
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
    description: "Outil unifié de recherche dans les tâches Roo (sémantique, textuelle, diagnostic de l'index)",
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['semantic', 'text', 'diagnose'], description: "Action: 'semantic' (recherche vectorielle Qdrant avec fallback automatique), 'text' (recherche textuelle directe dans le cache), 'diagnose' (diagnostic de l'index sémantique)" },
            search_query: { type: 'string', description: 'La requête de recherche (requis pour semantic et text)' },
            conversation_id: { type: 'string', description: 'ID de la conversation à fouiller (filtre optionnel pour semantic)' },
            max_results: { type: 'number', description: 'Nombre maximum de résultats à retourner' },
            workspace: { type: 'string', description: 'Filtre par nom de workspace (ex: "roo-extensions"). Auto-défaut: workspace courant du MCP. Pour une recherche globale cross-workspace, passer workspace: "*" ou workspace: "all".' },
            source: { type: 'string', enum: ['roo', 'claude-code'], description: '#604: Filtre par source de conversation (tâches Roo ou sessions Claude Code)' },
            chunk_type: { type: 'string', enum: ['message_exchange', 'tool_interaction'], description: '#636: Filter by chunk type (messages vs tool calls)' },
            role: { type: 'string', enum: ['user', 'assistant'], description: '#636: Filter by message role' },
            tool_name: { type: 'string', description: '#636: Filter by tool name (e.g., "write_to_file", "roosync_send")' },
            has_errors: { type: 'boolean', description: '#636: Filter chunks that contain error patterns' },
            model: { type: 'string', description: '#636: Filter by LLM model (e.g., "opus", "sonnet", "glm-5")' },
            start_date: { type: 'string', description: '#636 P2: Filter results after this date (ISO 8601 or YYYY-MM-DD, e.g., "2026-03-01")' },
            end_date: { type: 'string', description: '#636 P2: Filter results before this date (ISO 8601 or YYYY-MM-DD, e.g., "2026-03-11")' },
            exclude_tool_results: { type: 'boolean', description: '#636 P3: Exclude tool_interaction chunks, returning only message_exchange chunks (conversation messages)' }
        },
        required: ['action']
    }
};

// ============================================================
// roosync_indexing
// ============================================================
export const roosyncIndexingDefinition = {
    name: 'roosync_indexing',
    description: "Outil unifié de gestion de l'index sémantique, du cache et de l'archivage (indexation, reset, rebuild, diagnostic, archive Roo/Claude Code)",
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['index', 'reset', 'rebuild', 'diagnose', 'archive', 'status'], description: "Action: 'index' (indexer une tâche dans Qdrant), 'reset' (réinitialiser la collection Qdrant), 'rebuild' (reconstruire l'index SQLite VS Code), 'diagnose' (diagnostic complet de l'index), 'archive' (archiver une tâche Roo ou les sessions Claude Code sur GDrive), 'status' (état du background indexer et métriques)" },
            task_id: { type: 'string', description: 'ID de la tâche à indexer (requis pour action=index)' },
            confirm: { type: 'boolean', description: 'Confirmation obligatoire pour action=reset', default: false },
            workspace_filter: { type: 'string', description: 'Filtre optionnel par workspace (pour action=rebuild)' },
            max_tasks: { type: 'number', description: 'Nombre maximum de tâches à traiter (pour action=rebuild, 0 = toutes)', default: 0 },
            dry_run: { type: 'boolean', description: 'Mode simulation sans modification (pour action=rebuild)', default: false },
            machine_id: { type: 'string', description: 'Filtre par machine (pour action=archive, liste les archives de cette machine uniquement)' },
            claude_code_sessions: { type: 'boolean', description: 'Archiver les sessions Claude Code (pour action=archive)', default: false },
            max_sessions: { type: 'number', description: 'Nombre max de sessions Claude Code à archiver (pour action=archive avec claude_code_sessions=true, 0 = toutes)', default: 0 },
            source: { type: 'string', enum: ['roo', 'claude-code'], description: "#604: Source de la conversation (pour action=index). 'roo' = tâche Roo standard, 'claude-code' = session Claude Code JSONL. Par défaut: 'roo'" }
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
            query: { type: 'string', description: 'Requête de recherche sémantique (concept, pas texte exact). Ex: "rate limiting for embeddings", "authentication middleware"' },
            workspace: { type: 'string', description: 'Chemin absolu du workspace (REQUIS). Toujours passer explicitement.' },
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
    description: 'Scans the VS Code log directory to automatically find and read the latest logs from the Extension Host, Renderer, and Roo-Code Output Channels.',
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
// [REMOVED #1935 Cluster D] getMcpBestPracticesDefinition — fused into roosync_diagnose(action: "best-practices")
// CallTool redirect in registry.ts preserved for backward compat.

// ============================================================
// export_data
// ============================================================
export const exportDataDefinition = {
    name: 'export_data',
    description: 'Export data as XML, JSON, CSV, Markdown, or debug parsing. Targets: task, conversation, project. CONS-10+CONS-14.',
    inputSchema: {
        type: 'object',
        properties: {
            target: { type: 'string', enum: ['task', 'conversation', 'project'], description: 'Export target: task, conversation, or project' },
            format: { type: 'string', enum: ['xml', 'json', 'csv', 'markdown', 'debug'], description: 'Output format' },
            taskId: { type: 'string', description: 'Task ID (required for task target, or conversation with json/csv/debug)' },
            conversationId: { type: 'string', description: 'Root conversation ID (required for conversation with xml/markdown)' },
            projectPath: { type: 'string', description: 'Project path (required for project)' },
            filePath: { type: 'string', description: 'Output file path. If omitted, returns content.' },
            includeContent: { type: 'boolean', description: 'Include full message content (XML)' },
            prettyPrint: { type: 'boolean', description: 'Indent for readability (XML)', default: true },
            maxDepth: { type: 'integer', description: 'Max tree depth (XML/markdown)' },
            startDate: { type: 'string', description: 'Start date ISO 8601 filter (XML project)' },
            endDate: { type: 'string', description: 'End date ISO 8601 filter (XML project)' },
            jsonVariant: { type: 'string', enum: ['light', 'full'], description: 'JSON variant: light (skeleton) or full' },
            csvVariant: { type: 'string', enum: ['conversations', 'messages', 'tools'], description: 'CSV variant' },
            truncationChars: { type: 'number', description: 'Max chars before truncation (0 = no truncation)' },
            startIndex: { type: 'number', description: 'Start index (1-based)' },
            endIndex: { type: 'number', description: 'End index (1-based)' },
            outputFormat: { type: 'string', enum: ['ascii-tree', 'markdown', 'hierarchical', 'json'], description: '[markdown] Sub-format' },
            includeSiblings: { type: 'boolean', default: true },
            currentTaskId: { type: 'string', description: '[markdown] Mark this task as active' },
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
    description: `Gère les paramètres de configuration des exports.\n\nActions supportées:\n- get: Récupère la configuration actuelle\n- set: Met à jour la configuration (nécessite le paramètre config)\n- reset: Remet la configuration aux valeurs par défaut\n\nCONS-10: Remplace configure_xml_export`,
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['get', 'set', 'reset'], description: "L'opération à effectuer: get, set, ou reset" },
            config: { type: 'object', description: "L'objet de configuration à appliquer pour l'action set" }
        },
        required: ['action']
    }
};

// ============================================================
// view_task_details
// ============================================================
export const viewTaskDetailsDefinition = {
    name: 'view_task_details',
    description: 'Affiche les détails techniques complets (métadonnées des actions) pour une tâche spécifique',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: { type: 'string', description: "L'ID de la tâche pour laquelle afficher les détails techniques." },
            action_index: { type: 'number', description: "Index optionnel d'une action spécifique à examiner (commence à 0)." },
            truncate: { type: 'number', description: 'Nombre de lignes à conserver au début et à la fin des contenus longs (0 = complet).', default: 0 }
        },
        required: ['task_id']
    }
};

// ============================================================
// get_raw_conversation
// ============================================================
export const getRawConversationDefinition = {
    name: 'get_raw_conversation',
    description: "Récupère le contenu brut d'une conversation (fichiers JSON) sans condensation.",
    inputSchema: {
        type: 'object',
        properties: {
            taskId: { type: 'string', description: "L'identifiant de la tâche à récupérer." }
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
    description: 'Initialiser l\'infrastructure RooSync (dashboard, roadmap, répertoires)',
    inputSchema: {
        type: 'object',
        properties: {
            force: { type: 'boolean', description: 'Forcer la réinitialisation même si les fichiers existent (défaut: false)' },
            createRoadmap: { type: 'boolean', description: 'Créer un fichier sync-roadmap.md initial (défaut: true)' }
        },
        additionalProperties: false
    }
};

// [REMOVED #1935 Cluster E] roosyncGetStatusDefinition — fused into roosync_inventory(type: "status")
// CallTool redirect in registry.ts preserved for backward compat.

export const roosyncCompareConfigDefinition = {
    name: 'roosync_compare_config',
    description: 'Compare Roo configs between two machines. Levels: Config (CRITICAL), Environment (CRITICAL/WARNING), Hardware (IMPORTANT), Software (WARNING), System (INFO).',
    inputSchema: {
        type: 'object',
        properties: {
            source: { type: 'string', description: 'Source machine ID (default: local)' },
            target: { type: 'string', description: 'Target machine or profile (default: remote)' },
            force_refresh: { type: 'boolean', description: 'Force inventory collection even if cache valid' },
            granularity: { type: 'string', enum: ['mcp', 'mode', 'settings', 'claude', 'modes-yaml', 'full'], description: 'Granularity: mcp, mode, settings, claude, modes-yaml, or full' },
            filter: { type: 'string', description: 'Path filter (e.g. "jupyter" for a specific MCP)' }
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
            filterType: { type: 'string', enum: ['all', 'config', 'files', 'settings'], description: 'Filtrer par type de différence', default: 'all' },
            forceRefresh: { type: 'boolean', description: "Force le rafraîchissement du cache d'inventaire (évite les données périmées)", default: false }
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
            action: { type: 'string', enum: ['approve', 'reject', 'apply', 'rollback', 'info'], description: 'Action à effectuer sur la décision. "info" = consultation read-only.' },
            decisionId: { type: 'string', description: 'ID de la décision à traiter' },
            comment: { type: 'string', description: 'Commentaire optionnel (action: approve)' },
            reason: { type: 'string', description: 'Raison requise (action: reject, rollback)' },
            dryRun: { type: 'boolean', description: 'Mode simulation sans modification réelle (action: apply)' },
            force: { type: 'boolean', description: 'Forcer application même si conflits (action: apply)' },
            includeHistory: { type: 'boolean', description: "Inclure l'historique complet des actions (action: info, défaut: true)", default: true },
            includeLogs: { type: 'boolean', description: "Inclure les logs d'exécution (action: info, défaut: true)", default: true }
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
            version: { type: 'string', description: 'Baseline version' },
            createBackup: { type: 'boolean', description: 'Create backup', default: true },
            updateReason: { type: 'string', description: 'Reason for change' },
            updatedBy: { type: 'string', description: 'Author' },
            message: { type: 'string', description: 'Git tag message' },
            pushTags: { type: 'boolean', default: true },
            createChangelog: { type: 'boolean', default: true },
            source: { type: 'string', description: 'Restore source (git tag or backup path)' },
            targetVersion: { type: 'string', description: 'Target version for restore' }
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
            action: { type: 'string', enum: ['collect', 'publish', 'apply', 'apply_profile'], description: 'collect (local), publish (GDrive), apply (from GDrive), apply_profile' },
            machineId: { type: 'string', description: 'Machine ID (defaults to ROOSYNC_MACHINE_ID)' },
            dryRun: { type: 'boolean', description: 'Simulate without modifying files' },
            scope: { type: 'string', enum: ['user', 'project', 'settings'], description: 'Claude Code scope: user (~/.claude.json), project (.mcp.json), settings (~/.claude/settings.json)' },
            targets: { type: 'array', items: { type: 'string' }, description: 'Targets to collect/apply. Default: ["modes", "mcp"]' },
            packagePath: { type: 'string', description: 'Package path from collect. For publish only. If omitted with targets, does collect+publish atomically' },
            version: { type: 'string', description: 'Config version. Required for publish. Default for apply: "latest"' },
            description: { type: 'string', description: 'Change description. Required for publish' },
            backup: { type: 'boolean', description: 'Create local backup before apply', default: true },
            profileName: { type: 'string', description: 'Profile name (required for apply_profile)' },
            sourceMachineId: { type: 'string', description: 'Source machine for model-configs.json' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncInventoryDefinition = {
    name: 'roosync_inventory',
    description: 'Machine inventory, heartbeat status, system snapshot. type="status" for compact RooSync status with flags (fused from roosync_get_status).',
    inputSchema: {
        type: 'object',
        properties: {
            type: { type: 'string', enum: ['machine', 'heartbeat', 'all', 'machines', 'status'], description: '"machines"=unknown/idle, "status"=compact snapshot with flags' },
            machineId: { type: 'string', description: 'Machine ID (default: hostname). For status, acts as filter.' },
            includeHeartbeats: { type: 'boolean', description: 'Include heartbeat data (type=heartbeat|all)' },
            status: { type: 'string', enum: ['unknown', 'idle', 'all'], description: 'Filter by status (type=machines)' },
            includeDetails: { type: 'boolean', description: 'Full details (machines) or tool usage stats (status)' },
            detail: { type: 'string', enum: ['compact', 'full'], description: '"full" adds claims + pipeline stages (#1855 HUD)' },
            resetCache: { type: 'boolean', description: 'Force cache reset (status only)' }
        },
        required: ['type'],
        additionalProperties: false
    }
};

// #1863 FUSION A2: roosync_machines removed — use roosync_inventory(type: "machines")
// #1609: roosync_heartbeat retiré — auto-heartbeat now triggered on any tool call
export const roosyncMcpManagementDefinition = {
    name: 'roosync_mcp_management',
    description: 'MCP server management. Actions: manage (read/write/backup/update/toggle/sync_always_allow), rebuild (npm build+restart), touch (force reload all).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['manage', 'rebuild', 'touch'], description: 'manage (config), rebuild (build+restart), touch (force reload)' },
            subAction: { type: 'string', enum: ['read', 'write', 'backup', 'update_server', 'update_server_field', 'toggle_server', 'sync_always_allow'], description: 'Sub-action for manage. update_server=REPLACE, update_server_field=MERGE' },
            server_name: { type: 'string', description: 'MCP server name' },
            server_config: { type: 'object', description: 'Server config (update_server: REPLACE all, update_server_field: MERGE fields)' },
            settings: { type: 'object', description: 'Full settings (write)' },
            backup: { type: 'boolean', description: 'Create backup before modify', default: true },
            tools: { type: 'array', items: { type: 'string' }, description: 'Tool names to auto-approve (sync_always_allow)' },
            mcp_name: { type: 'string', description: 'MCP name to rebuild (required for rebuild)' }
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
            action: { type: 'string', enum: ['storage', 'maintenance'], description: 'storage (inspect) or maintenance (repair/rebuild)' },
            storageAction: { type: 'string', enum: ['detect', 'stats'], description: 'detect (locate storage) or stats (per-workspace)' },
            maintenanceAction: { type: 'string', enum: ['cache_rebuild', 'diagnose_bom', 'repair_bom'], description: 'cache_rebuild, diagnose_bom, or repair_bom' },
            force_rebuild: { type: 'boolean', description: 'Force full cache rebuild' },
            workspace_filter: { type: 'string', description: 'Filter by workspace (cache_rebuild)' },
            task_ids: { type: 'array', items: { type: 'string' }, description: 'Specific task IDs to rebuild' },
            fix_found: { type: 'boolean', description: 'Auto-repair corrupted files (diagnose_bom)' },
            dry_run: { type: 'boolean', description: 'Simulate repair without modifying (repair_bom)' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncDiagnoseDefinition = {
    name: 'roosync_diagnose',
    description: 'Diagnostic et debug RooSync. Actions: env, debug, reset, test, analyze (fused from analyze_roosync_problems), best-practices (fused from get_mcp_best_practices).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['env', 'debug', 'reset', 'test', 'analyze', 'best-practices'], description: 'Operation: env, debug, reset, test, analyze (roadmap), best-practices (MCP guide)' },
            checkDiskSpace: { type: 'boolean', description: 'Check disk space (env)' },
            verbose: { type: 'boolean', description: 'Verbose mode (debug)' },
            clearCache: { type: 'boolean', description: 'Clear cache on reset' },
            confirm: { type: 'boolean', description: 'Confirmation for reset' },
            message: { type: 'string', description: 'Custom test message (test)' },
            roadmapPath: { type: 'string', description: 'Path to sync-roadmap.md (action: analyze, auto-detected if omitted)' },
            generateReport: { type: 'boolean', description: 'Generate report in roo-config/reports (action: analyze)' },
            mcp_name: { type: 'string', description: 'MCP name to analyze (action: best-practices)' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

// #1836 Phase 1: Pre-claim enforcement tool
export const roosyncClaimDefinition = {
    name: 'roosync_claim',
    description: 'Pre-claim enforcement — prevents concurrent agent collisions on the same issue. Actions: claim (reserve issue), release (free claim), extend (prolong), list (active claims), check (verify issue status). Claims auto-expire after eta_minutes * 1.5. Always check before starting work on an issue.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['claim', 'release', 'extend', 'list', 'check'], description: 'Action: "claim" (reserve issue), "release" (free claim), "extend" (prolong), "list" (active claims), "check" (verify issue status)' },
            issue_number: { type: 'string', description: 'Issue number (e.g., "1836"). Required for claim/check/release/extend.' },
            agent: { type: 'string', description: 'Agent identifier (machine ID). Defaults to local machine.' },
            eta_minutes: { type: 'number', description: 'Estimated time in minutes. Required for claim, optional for extend.' },
            branch: { type: 'string', description: 'Git branch name for the claim (optional).' },
            claim_id: { type: 'string', description: 'Claim ID. Required for release/extend.' },
            additional_minutes: { type: 'number', description: 'Additional minutes for extend action.' }
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
    description: 'Envoyer un message structuré, répondre à un message existant, ou amender un message envoyé via RooSync',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['send', 'reply', 'amend'], description: 'Action à effectuer : send (nouveau message), reply (répondre), amend (modifier)' },
            to: { type: 'string', description: 'Destinataire : machine (ex: myia-ai-01) ou machine:workspace (ex: myia-ai-01:roo-extensions). Requis pour action=send' },
            subject: { type: 'string', description: 'Sujet du message. Requis pour action=send' },
            body: { type: 'string', description: 'Corps du message (markdown supporté). Requis pour action=send et reply' },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], description: 'Priorité du message (défaut: MEDIUM)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Tags optionnels pour catégoriser le message' },
            thread_id: { type: 'string', description: 'ID du thread pour regrouper les messages' },
            reply_to: { type: 'string', description: "ID du message auquel on répond (pour action=send)" },
            message_id: { type: 'string', description: 'ID du message (requis pour action=reply et amend)' },
            new_content: { type: 'string', description: 'Nouveau contenu du message (requis pour action=amend)' },
            reason: { type: 'string', description: "Raison de l'amendement (optionnel, pour action=amend)" },
            auto_destruct: { type: 'boolean', description: "Activer l'auto-destruction du message après lecture (#629). Défaut: false" },
            destruct_after_read_by: { type: 'array', items: { type: 'string' }, description: 'Liste des machines qui doivent lire avant destruction (optionnel).' },
            destruct_after: { type: 'string', description: 'Durée TTL avant destruction (ex: "30m", "2h", "1d").' },
            attachments: { type: 'array', description: 'Pièces jointes à envoyer avec le message (#674)', items: { type: 'object', properties: { path: { type: 'string', description: 'Chemin local du fichier à attacher' }, filename: { type: 'string', description: 'Nom du fichier (optionnel, défaut: basename du path)' } } } }
        }
    }
};

export const roosyncReadDefinition = {
    name: 'roosync_read',
    description: "Lire la boîte de réception des messages RooSync, obtenir les détails complets d'un message spécifique, ou lister les pièces jointes d'un message",
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
            workspace: { type: 'string', description: "(mode inbox, #1498) Override workspace filter. Défaut: workspace du process MCP. Permet à un scheduler tournant dans workspace X de lire l'inbox adressée à workspace Y sur la même machine (dashboard-watcher multi-workspace)." },
            to_machine: { type: 'string', description: '(mode inbox, #1498, avancé) Override machine filter. Défaut: machine locale. Normalement tu veux ta propre machine.' }
        },
        required: ['mode']
    }
};

export const roosyncManageDefinition = {
    name: 'roosync_manage',
    description: 'Gérer le cycle de vie des messages RooSync : marquer lu, archiver, opérations bulk, cleanup automatique, statistiques inbox',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['mark_read', 'archive', 'bulk_mark_read', 'bulk_archive', 'cleanup', 'stats'], description: 'Action: mark_read/archive (un message), bulk_mark_read/bulk_archive (avec filtres), cleanup (auto-nettoyage), stats (statistiques inbox)' },
            message_id: { type: 'string', description: 'ID du message (requis pour mark_read/archive)' },
            from: { type: 'string', description: 'Filtre par expéditeur (substring, pour bulk/cleanup)' },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], description: 'Filtre par priorité (pour bulk)' },
            before_date: { type: 'string', description: 'Filtre messages avant cette date ISO-8601 (pour bulk)' },
            subject_contains: { type: 'string', description: 'Filtre par sujet contenant ce texte (pour bulk)' },
            tag: { type: 'string', description: 'Filtre par tag (pour bulk)' }
        },
        required: ['action']
    }
};

// #1863 FUSION A3: roosync_cleanup_messages removed — use roosync_manage(action: "bulk_mark_read"/"bulk_archive")
export const roosyncAttachmentsDefinition = {
    name: 'roosync_attachments',
    description: "Gestion consolidée des pièces jointes RooSync (CONS-7). Actions : list (lister), get (récupérer vers chemin local), delete (supprimer). Remplace roosync_list_attachments, roosync_get_attachment, roosync_delete_attachment.",
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['list', 'get', 'delete'], description: "Action : list (lister), get (récupérer), delete (supprimer)" },
            message_id: { type: 'string', description: 'ID du message (pour action=list : filtre optionnel ; pour get/delete : optionnel si uuid fourni)' },
            uuid: { type: 'string', description: "UUID de la pièce jointe (requis pour action=get et action=delete)" },
            targetPath: { type: 'string', description: 'Chemin local de destination (requis pour action=get)' }
        },
        required: ['action']
    }
};

// #1841 Cluster G: Outil consolide messagerie (4→1: send+read+manage+attachments)
export const roosyncMessagesDefinition = {
    name: 'roosync_messages',
    description: 'Messagerie inter-machines (CONS-8). Actions: send/reply/amend, inbox/message, mark_read/archive, bulk_*, cleanup/stats, attachments_list/get/delete. Replaces roosync_send+read+manage+attachments (#1841 Cluster G).',
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
            to: { type: 'string', description: 'Recipient (send): machine or machine:workspace' },
            subject: { type: 'string', description: 'Subject (send)' },
            body: { type: 'string', description: 'Message body (send/reply)' },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
            tags: { type: 'array', items: { type: 'string' } },
            thread_id: { type: 'string', description: 'Thread ID' },
            reply_to: { type: 'string', description: 'Reference message ID (send)' },
            message_id: { type: 'string', description: 'Message ID (reply/amend/mark_read/archive/message/attachments_list)' },
            new_content: { type: 'string', description: 'New content (amend)' },
            reason: { type: 'string', description: 'Reason (amend)' },
            auto_destruct: { type: 'boolean', description: 'Self-destruct after read' },
            destruct_after_read_by: { type: 'array', items: { type: 'string' }, description: 'Machines that must read before destruction' },
            destruct_after: { type: 'string', description: 'TTL before destruction (30m, 2h, 1d)' },
            attachments: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { path: { type: 'string' }, filename: { type: 'string' } },
                    required: ['path']
                },
                description: 'Attachments (send)'
            },
            status: { type: 'string', enum: ['unread', 'read', 'all'] },
            limit: { type: 'number', description: 'Max messages (inbox)' },
            page: { type: 'number', description: 'Page (1-based)' },
            per_page: { type: 'number', description: 'Messages per page' },
            mark_as_read: { type: 'boolean' },
            workspace: { type: 'string', description: 'Override workspace (#1498)' },
            to_machine: { type: 'string', description: 'Override machine (#1498)' },
            from: { type: 'string', description: 'Filter by sender (bulk)' },
            before_date: { type: 'string', description: 'Filter before ISO date (bulk)' },
            subject_contains: { type: 'string', description: 'Filter by subject (bulk)' },
            tag: { type: 'string', description: 'Filter by tag (bulk)' },
            uuid: { type: 'string', description: 'Attachment UUID (attachments_get/delete)' },
            targetPath: { type: 'string', description: 'Local destination path (attachments_get)' }
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
