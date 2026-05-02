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
    description: 'Outil consolidé pour naviguer, visualiser et résumer les conversations. Actions: "list" (lister les conversations récentes), "tree" (arbre des tâches), "current" (tâche active), "view" (vue conversation), "summarize" (résumé/synthèse — types: "trace", "cluster", "synthesis" pour analyse LLM complète), "rebuild" (reconstruire le cache de squelettes sur disque). Commencez par "list" pour découvrir les IDs de tâches.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['list', 'tree', 'current', 'view', 'summarize', 'rebuild'], description: 'Action à effectuer. Utilisez "list" pour découvrir les conversations disponibles et leurs IDs. "rebuild" force la reconstruction du cache de squelettes.' },
            limit: { type: 'number', description: '[list] Nombre maximum de conversations à retourner (défaut: toutes).' },
            sortBy: { type: 'string', enum: ['lastActivity', 'messageCount', 'totalSize'], description: '[list] Critère de tri.', default: 'lastActivity' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], description: '[list] Ordre de tri.', default: 'desc' },
            pendingSubtaskOnly: { type: 'boolean', description: '[list] Ne retourner que les tâches avec sous-tâche en attente.' },
            contentPattern: { type: 'string', description: '[list] Filtre les tâches contenant ce texte dans leurs messages.' },
            conversation_id: { type: 'string', description: "[tree] ID de la conversation pour l'arbre des tâches." },
            max_depth: { type: 'number', description: "[tree] Profondeur maximale de l'arbre." },
            include_siblings: { type: 'boolean', description: '[tree] Inclure les tâches sœurs.', default: true },
            output_format: { type: 'string', enum: ['json', 'markdown', 'ascii-tree', 'hierarchical'], description: '[tree] Format de sortie.', default: 'json' },
            current_task_id: { type: 'string', description: '[tree/view] ID de la tâche en cours pour marquage.' },
            truncate_instruction: { type: 'number', description: "[tree] Longueur max de l'instruction (défaut: 80).", default: 80 },
            show_metadata: { type: 'boolean', description: '[tree] Afficher les métadonnées détaillées.', default: false },
            workspace: { type: 'string', description: '[current/view] Chemin du workspace (détection auto si omis).' },
            task_id: { type: 'string', description: '[view] ID de la tâche de départ.' },
            view_mode: { type: 'string', enum: ['single', 'chain', 'cluster'], description: "[view] Mode d'affichage.", default: 'chain' },
            detail_level: { type: 'string', enum: ['skeleton', 'summary', 'full'], description: '[view] Niveau de détail.', default: 'skeleton' },
            truncate: { type: 'number', description: '[view] Lignes à conserver au début/fin (0 = défaut intelligent).', default: 0 },
            max_output_length: { type: 'number', description: '[view] Limite max de caractères en sortie.', default: 300000 },
            smart_truncation: { type: 'boolean', description: '[view] Activer la troncature intelligente avec gradient.', default: false },
            smart_truncation_config: { type: 'object', description: '[view] Configuration avancée pour la troncature intelligente.', properties: { gradientStrength: { type: 'number' }, minPreservationRate: { type: 'number' }, maxTruncationRate: { type: 'number' } } },
            output_file: { type: 'string', description: "[view] Chemin pour sauvegarder l'arbre dans un fichier." },
            summarize_type: { type: 'string', enum: ['trace', 'cluster', 'synthesis'], description: '[summarize] Type de résumé (requis si action=summarize). "trace" = statistiques et timeline. "cluster" = grappes parent-enfant. "synthesis" = pipeline LLM avec analyse sémantique et profils d\'acteurs.' },
            taskId: { type: 'string', description: '[summarize] ID de la tâche (ou tâche racine pour cluster).' },
            source: { type: 'string', enum: ['roo', 'claude', 'all'], description: '[list/summarize] Source des conversations: "roo" (défaut, Roo Code), "claude" (Claude Code sessions), "all" (les deux).', default: 'roo' },
            filePath: { type: 'string', description: '[summarize] Chemin pour sauvegarder le fichier.' },
            summarize_output_format: { type: 'string', enum: ['markdown', 'html', 'json'], description: '[summarize] Format de sortie.', default: 'markdown' },
            detailLevel: { type: 'string', enum: ['Full', 'NoTools', 'NoResults', 'Messages', 'Summary', 'UserOnly'], description: '[summarize] Niveau de détail du résumé.', default: 'Full' },
            truncationChars: { type: 'number', description: '[summarize] Chars max avant troncature (0 = pas de troncature).', default: 0 },
            compactStats: { type: 'boolean', description: '[summarize] Format compact pour les statistiques.', default: false },
            includeCss: { type: 'boolean', description: '[summarize] Inclure le CSS embarqué.', default: true },
            generateToc: { type: 'boolean', description: '[summarize] Générer la table des matières.', default: true },
            startIndex: { type: 'number', description: '[summarize] Index de début (1-based).' },
            endIndex: { type: 'number', description: '[summarize] Index de fin (1-based).' },
            childTaskIds: { type: 'array', items: { type: 'string' }, description: '[summarize/cluster] IDs des tâches enfantes.' },
            clusterMode: { type: 'string', enum: ['aggregated', 'detailed', 'comparative'], description: '[summarize/cluster] Mode de clustering.', default: 'aggregated' },
            includeClusterStats: { type: 'boolean', description: '[summarize/cluster] Inclure les statistiques de grappe.', default: true },
            crossTaskAnalysis: { type: 'boolean', description: "[summarize/cluster] Activer l'analyse cross-task.", default: false },
            maxClusterDepth: { type: 'number', description: '[summarize/cluster] Profondeur max de grappe.', default: 10 },
            clusterSortBy: { type: 'string', enum: ['chronological', 'size', 'activity', 'alphabetical'], description: '[summarize/cluster] Critère de tri.', default: 'chronological' },
            includeClusterTimeline: { type: 'boolean', description: '[summarize/cluster] Inclure la timeline.', default: false },
            clusterTruncationChars: { type: 'number', description: '[summarize/cluster] Troncature spécifique aux grappes.', default: 0 },
            showTaskRelationships: { type: 'boolean', description: '[summarize/cluster] Montrer les relations entre tâches.', default: true },
            synthesis_output_format: { type: 'string', enum: ['json', 'markdown'], description: '[summarize/synthesis] Format de sortie pour la synthèse LLM. "json" retourne l\'analyse complète, "markdown" retourne la section narrative.', default: 'json' },
            force_rebuild: { type: 'boolean', description: '[rebuild] Si true, reconstruit TOUS les squelettes (lent). Si false/omis, ne reconstruit que les manquants/obsolètes.', default: false },
            task_ids: { type: 'array', items: { type: 'string' }, description: '[rebuild] Liste optionnelle d\'IDs de tâches spécifiques à reconstruire.' }
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
export const getMcpBestPracticesDefinition = {
    name: 'get_mcp_best_practices',
    description: '📚 **BONNES PRATIQUES MCP** - Guide de référence sur les patterns de configuration et de débogage pour les MCPs, basé sur l\'expérience de stabilisation. Inclut des recommandations essentielles pour la maintenabilité et la performance.',
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
    description: 'Export data as XML, JSON or CSV. Targets: task (XML), conversation (all formats), project (XML). JSON variants: light/full. CSV variants: conversations/messages/tools.',
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
export const analyzeRooSyncProblemsDefinition = {
    name: 'analyze_roosync_problems',
    description: 'Analyse le fichier sync-roadmap.md pour détecter les problèmes structurels et incohérences (doublons, statuts invalides, corruption).',
    inputSchema: {
        type: 'object',
        properties: {
            roadmapPath: { type: 'string', description: 'Chemin vers le fichier sync-roadmap.md (optionnel, défaut: autodetecté)' },
            generateReport: { type: 'boolean', description: 'Générer un rapport Markdown dans roo-config/reports (défaut: false)' }
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
            force: { type: 'boolean', description: 'Forcer la réinitialisation même si les fichiers existent (défaut: false)' },
            createRoadmap: { type: 'boolean', description: 'Créer un fichier sync-roadmap.md initial (défaut: true)' }
        },
        additionalProperties: false
    }
};

export const roosyncGetStatusDefinition = {
    name: 'roosync_get_status',
    description: 'Obtenir un snapshot compact de l\'état RooSync avec flags actionnables. Remplace 4-5 appels séparés. #1855: detail="full" ajoute claims actifs et pipeline stages pour HUD statusline.',
    inputSchema: {
        type: 'object',
        properties: {
            machineFilter: { type: 'string', description: 'ID de machine pour filtrer les résultats (optionnel)' },
            resetCache: { type: 'boolean', description: 'Forcer la réinitialisation du cache du service (défaut: false)' },
            detail: { type: 'string', enum: ['compact', 'full'], description: 'Niveau de détail: "compact" (défaut) = status minimal, "full" = ajoute claims actifs et stages pipeline (#1855 HUD)' }
        },
        additionalProperties: false
    }
};

export const roosyncCompareConfigDefinition = {
    name: 'roosync_compare_config',
    description: 'Compare les configurations Roo entre deux machines et détecte les différences réelles. Détection multi-niveaux : Configuration Roo (modes, MCPs, settings) - CRITICAL, Environment (EMBEDDING_*, QDRANT_*) - CRITICAL/WARNING, Hardware (CPU, RAM, disques, GPU) - IMPORTANT, Software (PowerShell, Node, Python) - WARNING, System (OS, architecture) - INFO. Modes de granularité : mcp, mode, settings, claude, modes-yaml, full.',
    inputSchema: {
        type: 'object',
        properties: {
            source: { type: 'string', description: 'ID de la machine source (optionnel, défaut: local_machine)' },
            target: { type: 'string', description: 'ID de la machine cible ou du profil (optionnel, défaut: remote_machine)' },
            force_refresh: { type: 'boolean', description: "Forcer la collecte d'inventaire même si cache valide (défaut: false)" },
            granularity: { type: 'string', enum: ['mcp', 'mode', 'settings', 'claude', 'modes-yaml', 'full'], description: 'Niveau de granularité: mcp (MCPs uniquement), mode (modes Roo), settings (Roo settings state.vscdb), claude (config Claude Code ~/.claude.json), modes-yaml (custom_modes.yaml global), full (comparaison complète)' },
            filter: { type: 'string', description: 'Filtre optionnel sur les paths (ex: "jupyter" pour filtrer un MCP spécifique)' }
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

// [REMOVED #1863] roosyncDecisionInfoDefinition — fused into roosync_decision(action: "info")
// CallTool redirect in registry.ts preserved for backward compat.

export const roosyncBaselineDefinition = {
    name: 'roosync_baseline',
    description: 'Outil consolidé pour gérer les baselines RooSync (update, version, restore, export, list_versions, current_version)',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['update', 'version', 'restore', 'export', 'list_versions', 'current_version'], description: 'Action à effectuer sur la baseline' },
            machineId: { type: 'string', description: '[update] ID de la machine ou nom du profil' },
            mode: { type: 'string', enum: ['standard', 'profile'], description: '[update] Mode de mise à jour' },
            aggregationConfig: { type: 'object', description: "[update] Configuration d'agrégation (mode profile uniquement)" },
            version: { type: 'string', description: '[update/version] Version de la baseline' },
            createBackup: { type: 'boolean', description: '[update/restore] Créer une sauvegarde (défaut: true)' },
            updateReason: { type: 'string', description: '[update/restore] Raison de la modification' },
            updatedBy: { type: 'string', description: '[update] Auteur de la mise à jour' },
            message: { type: 'string', description: '[version] Message du tag Git' },
            pushTags: { type: 'boolean', description: '[version] Pousser les tags (défaut: true)' },
            createChangelog: { type: 'boolean', description: '[version] Mettre à jour CHANGELOG (défaut: true)' },
            source: { type: 'string', description: '[restore] Source de restauration (tag Git ou chemin sauvegarde)' },
            targetVersion: { type: 'string', description: '[restore] Version cible' }
        },
        additionalProperties: false
    }
};

export const roosyncConfigDefinition = {
    name: 'roosync_config',
    description: 'RooSync config management. Actions: collect (local), publish (to GDrive), apply (from GDrive), apply_profile (model profile). Targets: modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, mcp:<server>.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['collect', 'publish', 'apply', 'apply_profile'], description: 'Action: collect, publish, apply, or apply_profile' },
            machineId: { type: 'string', description: 'Machine ID (default: ROOSYNC_MACHINE_ID)' },
            dryRun: { type: 'boolean', description: 'Simulate without modifying files (default: false)' },
            scope: { type: 'string', enum: ['user', 'project', 'settings'], description: 'Claude Code config scope: user (~/.claude.json), project (.mcp.json), settings (~/.claude/settings.json). Default: user.' },
            targets: { type: 'array', items: { type: 'string' }, description: 'Targets: modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, mcp:<server>. Default: ["modes", "mcp"]' },
            packagePath: { type: 'string', description: 'Package path from collect. For publish. If omitted with targets, does collect+publish atomically.' },
            version: { type: 'string', description: 'Config version. Required for publish. For apply, default: "latest".' },
            description: { type: 'string', description: 'Change description. Required for publish.' },
            backup: { type: 'boolean', description: 'Create local backup before apply (default: true). For apply and apply_profile.' },
            profileName: { type: 'string', description: 'Profile name (required for apply_profile). E.g. "Production (Qwen 3.5 + GLM-5)"' },
            sourceMachineId: { type: 'string', description: 'Source machine ID for model-configs.json (default: local file)' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncInventoryDefinition = {
    name: 'roosync_inventory',
    description: "Récupération de l'inventaire machine et/ou de l'état heartbeat. type=\"machines\" = offline/warning machines (fused from roosync_machines).",
    inputSchema: {
        type: 'object',
        properties: {
            type: { type: 'string', enum: ['machine', 'heartbeat', 'all', 'machines'], description: "Type d'inventaire à récupérer. \"machines\" = offline/warning machines" },
            machineId: { type: 'string', description: 'Identifiant optionnel de la machine (défaut: hostname)' },
            includeHeartbeats: { type: 'boolean', description: 'Inclure les données de heartbeat de chaque machine (défaut: true)' },
            status: { type: 'string', enum: ['offline', 'warning', 'all'], description: 'Filtrer par statut machines (type="machines": offline, warning, all)' },
            includeDetails: { type: 'boolean', description: 'Inclure les détails complets des machines (type="machines", défaut: false)' }
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
    description: 'Gestion complète des serveurs MCP. Actions : manage (read/write/backup/update/toggle/update_server_field/sync_always_allow configuration), rebuild (build npm + restart MCP avec watchPaths), touch (force reload de tous les serveurs MCP).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['manage', 'rebuild', 'touch'], description: "Type d'opération MCP: manage (configuration), rebuild (build+restart), touch (force reload)" },
            subAction: { type: 'string', enum: ['read', 'write', 'backup', 'update_server', 'update_server_field', 'toggle_server', 'sync_always_allow'], description: 'Sous-action pour manage: read, write, backup, update_server (REMPLACE tout le bloc), update_server_field (FUSIONNE champs sans écraser), toggle_server, sync_always_allow' },
            server_name: { type: 'string', description: 'Nom du serveur MCP (pour update_server, update_server_field, toggle_server, sync_always_allow)' },
            server_config: { type: 'object', description: 'Configuration du serveur (pour update_server: REMPLACE tout) ou champs à modifier (pour update_server_field: FUSIONNE)' },
            settings: { type: 'object', description: 'Paramètres complets (pour write)' },
            backup: { type: 'boolean', description: 'Créer une sauvegarde avant modification (défaut: true pour manage)' },
            tools: { type: 'array', items: { type: 'string' }, description: "Liste des noms d'outils à auto-approuver (pour sync_always_allow)" },
            mcp_name: { type: 'string', description: 'Nom du MCP à rebuild (requis pour action rebuild)' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncStorageManagementDefinition = {
    name: 'roosync_storage_management',
    description: 'Gestion complète du stockage Roo : inspection et maintenance. Actions : storage (detect=localiser stockage, stats=statistiques par workspace), maintenance (cache_rebuild=reconstruire cache conversations, diagnose_bom=diagnostiquer problèmes BOM UTF-8, repair_bom=réparer fichiers corrompus).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['storage', 'maintenance'], description: "Type d'opération: storage (inspection) ou maintenance (réparation/rebuild)" },
            storageAction: { type: 'string', enum: ['detect', 'stats'], description: 'Sous-action pour storage: detect (localiser le stockage Roo) ou stats (statistiques de stockage)' },
            maintenanceAction: { type: 'string', enum: ['cache_rebuild', 'diagnose_bom', 'repair_bom'], description: 'Sous-action pour maintenance: cache_rebuild (reconstruire le cache), diagnose_bom (diagnostiquer BOM), repair_bom (réparer BOM)' },
            force_rebuild: { type: 'boolean', description: 'Force la reconstruction complète du cache (maintenance: cache_rebuild)' },
            workspace_filter: { type: 'string', description: 'Filtre par workspace (maintenance: cache_rebuild)' },
            task_ids: { type: 'array', items: { type: 'string' }, description: "Liste d'IDs de tâches spécifiques à construire (maintenance: cache_rebuild)" },
            fix_found: { type: 'boolean', description: 'Réparer automatiquement les fichiers corrompus trouvés (maintenance: diagnose_bom)' },
            dry_run: { type: 'boolean', description: 'Simuler la réparation sans modifier les fichiers (maintenance: repair_bom)' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncDiagnoseDefinition = {
    name: 'roosync_diagnose',
    description: 'Outil de diagnostic et debug complet pour RooSync. Actions disponibles : env (diagnostic environnement système), debug (debug dashboard avec reset instance), reset (réinitialisation service avec confirmation), test (test minimal MCP).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['env', 'debug', 'reset', 'test'], description: "Type d'opération: env (environnement), debug (dashboard), reset (service), test (minimal)" },
            checkDiskSpace: { type: 'boolean', description: 'Vérifier l\'espace disque (action: env)' },
            verbose: { type: 'boolean', description: 'Mode verbeux pour debug (action: debug)' },
            clearCache: { type: 'boolean', description: 'Vider le cache lors du reset (action: reset)' },
            confirm: { type: 'boolean', description: 'Confirmation requise pour reset (action: reset)' },
            message: { type: 'string', description: 'Message de test personnalisé (action: test)' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncRefreshDashboardDefinition = {
    name: 'roosync_refresh_dashboard',
    description: 'Rafraîchit le dashboard MCP en exécutant le script generate-mcp-dashboard.ps1',
    inputSchema: {
        type: 'object',
        properties: {
            baseline: { type: 'string', description: 'Machine à utiliser comme baseline (défaut: myia-ai-01)' },
            outputDir: { type: 'string', description: 'Répertoire de sortie pour le dashboard (défaut: $ROOSYNC_SHARED_PATH/dashboards)' }
        },
        additionalProperties: false
    }
};

export const roosyncUpdateDashboardDefinition = {
    name: 'roosync_update_dashboard',
    description: 'Met à jour une section du dashboard hiérarchique RooSync sur GDrive (#546)',
    inputSchema: {
        type: 'object',
        properties: {
            section: { type: 'string', enum: ['machine', 'global', 'intercom', 'decisions', 'metrics'], description: 'Section du dashboard à mettre à jour' },
            content: { type: 'string', description: 'Contenu markdown à insérer dans la section' },
            machine: { type: 'string', description: 'ID de la machine (requis si section=machine, défaut: ROOSYNC_MACHINE_ID)' },
            workspace: { type: 'string', description: 'Workspace (défaut: roo-extensions)' },
            mode: { type: 'string', enum: ['replace', 'append', 'prepend'], description: 'Mode de mise à jour: replace (remplacer), append (ajouter à la fin), prepend (ajouter au début)' }
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

// [REMOVED #1863] roosyncCleanupMessagesDefinition — fused into roosync_manage(action: "bulk_mark_read"/"bulk_archive")
// CallTool redirect in registry.ts preserved for backward compat.

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

// #1470: Derived from Zod schema in dashboard-schemas.ts (single source of truth)
export const roosyncDashboardDefinition = dashboardToolMetadata;

// ============================================================
// roosync_claim (#1836)
// ============================================================
export const roosyncClaimDefinition = {
    name: 'roosync_claim',
    description: 'Pre-claim enforcement — prevents concurrent agent collisions. Actions: "claim" (reserve an issue — fails if already claimed), "release" (free a claim), "extend" (prolong ETA), "list" (show active claims), "check" (verify if issue is available). Claims auto-expire after eta * 1.5 minutes.',
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
