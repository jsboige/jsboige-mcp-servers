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
 */

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
            workspace: { type: 'string', description: 'Chemin absolu du workspace (défaut: répertoire courant)' },
            directory_prefix: { type: 'string', description: 'Préfixe de répertoire pour filtrer. Ex: "src/services", "mcps/internal"' },
            limit: { type: 'number', description: 'Nombre max de résultats (défaut: 10, max: 30)' },
            min_score: { type: 'number', description: 'Score minimum de similarité 0-1 (défaut: 0.5)' }
        },
        required: ['query']
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
    description: `Outil consolidé pour exporter des données au format XML, JSON ou CSV.\n\nCibles supportées:\n- task: Export d'une tâche individuelle (XML uniquement)\n- conversation: Export d'une conversation complète (tous formats)\n- project: Export d'un projet entier (XML uniquement)\n\nFormats supportés:\n- xml: Format XML structuré\n- json: Format JSON avec variantes light/full\n- csv: Format CSV avec variantes conversations/messages/tools\n\nCONS-10: Remplace export_tasks_xml, export_conversation_xml, export_project_xml, export_conversation_json, export_conversation_csv`,
    inputSchema: {
        type: 'object',
        properties: {
            target: { type: 'string', enum: ['task', 'conversation', 'project'], description: "Cible de l'export: task, conversation, ou project" },
            format: { type: 'string', enum: ['xml', 'json', 'csv'], description: 'Format de sortie: xml, json, ou csv' },
            taskId: { type: 'string', description: 'ID de la tâche (requis pour target=task, ou conversation avec json/csv)' },
            conversationId: { type: 'string', description: 'ID de la conversation racine (requis pour target=conversation avec xml)' },
            projectPath: { type: 'string', description: 'Chemin du projet (requis pour target=project)' },
            filePath: { type: 'string', description: 'Chemin de sortie pour le fichier. Si non fourni, retourne le contenu.' },
            includeContent: { type: 'boolean', description: 'Inclure le contenu complet des messages (XML, défaut: false)' },
            prettyPrint: { type: 'boolean', description: 'Indenter pour lisibilité (XML, défaut: true)' },
            maxDepth: { type: 'integer', description: "Profondeur max de l'arbre de tâches (XML conversation)" },
            startDate: { type: 'string', description: 'Date de début ISO 8601 pour filtrer (XML project)' },
            endDate: { type: 'string', description: 'Date de fin ISO 8601 pour filtrer (XML project)' },
            jsonVariant: { type: 'string', enum: ['light', 'full'], description: 'Variante JSON: light (squelette) ou full (détail complet)' },
            csvVariant: { type: 'string', enum: ['conversations', 'messages', 'tools'], description: 'Variante CSV: conversations, messages, ou tools' },
            truncationChars: { type: 'number', description: 'Max caractères avant troncature (0 = pas de troncature)' },
            startIndex: { type: 'number', description: 'Index de début (1-based) pour plage de messages' },
            endIndex: { type: 'number', description: 'Index de fin (1-based) pour plage de messages' }
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

export const roosyncGetStatusDefinition = {
    name: 'roosync_get_status',
    description: 'Obtenir l\'état de synchronisation actuel du système RooSync (fusionné avec read-dashboard)',
    inputSchema: {
        type: 'object',
        properties: {
            machineFilter: { type: 'string', description: 'ID de machine pour filtrer les résultats (optionnel)' },
            resetCache: { type: 'boolean', description: 'Forcer la réinitialisation du cache du service (défaut: false)' },
            includeDetails: { type: 'boolean', description: 'Inclure les détails complets des différences (défaut: false)' }
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
    description: 'Gère le workflow de décision RooSync (approve/reject/apply/rollback)',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['approve', 'reject', 'apply', 'rollback'], description: 'Action à effectuer sur la décision' },
            decisionId: { type: 'string', description: 'ID de la décision à traiter' },
            comment: { type: 'string', description: 'Commentaire optionnel (action: approve)' },
            reason: { type: 'string', description: 'Raison requise (action: reject, rollback)' },
            dryRun: { type: 'boolean', description: 'Mode simulation sans modification réelle (action: apply)' },
            force: { type: 'boolean', description: 'Forcer application même si conflits (action: apply)' }
        },
        required: ['action', 'decisionId']
    }
};

// roosync_decision_info — inlined from zodToJsonSchema(RooSyncDecisionInfoArgsSchema)
export const roosyncDecisionInfoDefinition = {
    name: 'roosync_decision_info',
    description: "Consulte les détails d'une décision RooSync (read-only)",
    inputSchema: {
        type: 'object',
        properties: {
            decisionId: { type: 'string', description: 'ID de la décision à consulter' },
            includeHistory: { type: 'boolean', description: "Inclure l'historique complet des actions (défaut: true)", default: true },
            includeLogs: { type: 'boolean', description: "Inclure les logs d'exécution (défaut: true)", default: true }
        },
        required: ['decisionId']
    }
};

export const roosyncBaselineDefinition = {
    name: 'roosync_baseline',
    description: 'Outil consolidé pour gérer les baselines RooSync (update, version, restore, export)',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['update', 'version', 'restore', 'export'], description: 'Action à effectuer sur la baseline' },
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
    description: 'Gestion de configuration RooSync. Actions : collect (collecte locale), publish (publication GDrive), apply (application depuis GDrive), apply_profile (appliquer un profil de modèle). Cibles : modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, mcp:<nomServeur>. Stocke par machineId.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['collect', 'publish', 'apply', 'apply_profile'], description: 'Action à effectuer: collect (collecte config locale), publish (publication vers GDrive), apply (application depuis GDrive), apply_profile (appliquer un profil de modèle)' },
            machineId: { type: 'string', description: 'ID de la machine (optionnel, utilise ROOSYNC_MACHINE_ID par défaut)' },
            dryRun: { type: 'boolean', description: "Si true, simule l'opération sans modifier les fichiers. Défaut: false" },
            scope: { type: 'string', enum: ['user', 'project', 'settings'], description: 'Scope Claude Code pour les configs MCP: user (~/.claude.json global), project (.mcp.json projet), settings (~/.claude/settings.json env/hooks). Défaut: user.' },
            targets: { type: 'array', items: { type: 'string' }, description: 'Liste des cibles à collecter/appliquer (modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, ou mcp:<nomServeur>). Défaut: ["modes", "mcp"]' },
            packagePath: { type: 'string', description: "Chemin du package créé par collect. Pour action=publish uniquement. Si omis avec targets fourni, fait collect+publish atomique" },
            version: { type: 'string', description: 'Version de la configuration (ex: "2.3.0"). Requis pour action=publish. Pour action=apply, défaut: "latest"' },
            description: { type: 'string', description: 'Description des changements. Requis pour action=publish' },
            backup: { type: 'boolean', description: 'Créer un backup local avant application (défaut: true). Pour action=apply et apply_profile' },
            profileName: { type: 'string', description: 'Nom du profil à appliquer (requis pour action=apply_profile). Ex: "Production (Qwen 3.5 local + GLM-5 cloud)"' },
            sourceMachineId: { type: 'string', description: 'ID de la machine source pour charger model-configs.json depuis sa config publiée (optionnel, défaut: fichier local)' }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const roosyncInventoryDefinition = {
    name: 'roosync_inventory',
    description: "Récupération de l'inventaire machine et/ou de l'état heartbeat.",
    inputSchema: {
        type: 'object',
        properties: {
            type: { type: 'string', enum: ['machine', 'heartbeat', 'all'], description: "Type d'inventaire à récupérer" },
            machineId: { type: 'string', description: 'Identifiant optionnel de la machine (défaut: hostname)' },
            includeHeartbeats: { type: 'boolean', description: 'Inclure les données de heartbeat de chaque machine (défaut: true)' }
        },
        required: ['type'],
        additionalProperties: false
    }
};

export const roosyncMachinesDefinition = {
    name: 'roosync_machines',
    description: 'Récupération des machines offline et/ou en avertissement.',
    inputSchema: {
        type: 'object',
        properties: {
            status: { type: 'string', enum: ['offline', 'warning', 'all'], description: 'Statut des machines à récupérer' },
            includeDetails: { type: 'boolean', description: 'Inclure les détails complets de chaque machine (défaut: false)' }
        },
        required: ['status'],
        additionalProperties: false
    }
};

export const roosyncHeartbeatDefinition = {
    name: 'roosync_heartbeat',
    description: "Gestion complète du heartbeat des agents Roo. Actions : status (consulter état), register (enregistrer nouveau heartbeat), start (démarrer surveillance), stop (arrêter surveillance).",
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['status', 'register', 'start', 'stop'], description: "Type d'opération: status (état), register (enregistrer), start (démarrer), stop (arrêter)" },
            filter: { type: 'string', enum: ['all', 'online', 'offline', 'warning'], description: 'Filtrer par statut de machine (action: status)' },
            includeHeartbeats: { type: 'boolean', description: 'Inclure les données de heartbeat de chaque machine (action: status)' },
            forceCheck: { type: 'boolean', description: 'Forcer une vérification immédiate des heartbeats (action: status)' },
            includeChanges: { type: 'boolean', description: 'Inclure les changements de statut récents (action: status)' },
            machineId: { type: 'string', description: 'Identifiant de la machine (requis pour register, start)' },
            metadata: { type: 'object', description: 'Métadonnées optionnelles à associer au heartbeat (action: register)' },
            enableAutoSync: { type: 'boolean', description: 'Activer la synchronisation automatique (action: start)' },
            heartbeatInterval: { type: 'number', description: 'Intervalle de heartbeat en millisecondes (action: start)' },
            offlineTimeout: { type: 'number', description: 'Timeout avant de considérer une machine offline en ms (action: start)' },
            saveState: { type: 'boolean', description: "Sauvegarder l'état avant l'arrêt (action: stop)" }
        },
        required: ['action'],
        additionalProperties: false
    }
};

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

export const roosyncCleanupMessagesDefinition = {
    name: 'roosync_cleanup_messages',
    description: "Effectue des opérations de cleanup en masse sur les messages RooSync. Cas d'usage : marquer automatiquement les messages LOW comme lus, ignorer les messages de test (test-machine), nettoyer les anciens messages non lus.",
    inputSchema: {
        type: 'object',
        properties: {
            operation: { type: 'string', enum: ['mark_read', 'archive'], description: "Opération à effectuer : mark_read (marquer comme lu) ou archive (archiver)" },
            from: { type: 'string', description: 'Filtre par expéditeur (substring match). Ex: "test-machine" pour ignorer les messages de test' },
            priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], description: 'Filtre par priorité. Ex: "LOW" pour marquer automatiquement les messages LOW' },
            before_date: { type: 'string', description: 'Filtre par date (messages antérieurs à cette date). Format ISO-8601: "2026-02-01T00:00:00Z"' },
            subject_contains: { type: 'string', description: 'Filtre par sujet (substring, case-insensitive)' },
            tag: { type: 'string', description: 'Filtre par tag' },
            status: { type: 'string', enum: ['unread', 'read'], description: 'Ne traiter que les messages avec ce statut' },
            verbose: { type: 'boolean', description: 'Afficher les IDs des messages traités (défaut: true)' }
        },
        required: ['operation']
    }
};

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

export const roosyncDashboardDefinition = {
    name: 'roosync_dashboard',
    description: 'Dashboards markdown partagés cross-machine. 3 types : global, machine, workspace. Actions : read, write (status diff), append (message intercom), condense, list (tous dashboards), delete, read_archive, read_overview (vue concaténée des 3 niveaux en 1 appel).',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['read', 'write', 'append', 'condense', 'list', 'delete', 'read_archive', 'read_overview'], description: 'Action : read, write, append, condense, list (tous dashboards), delete (supprimer), read_archive (lire archives intercom), read_overview (vue concaténée des 3 niveaux en 1 appel)' },
            type: { type: 'string', enum: ['global', 'machine', 'workspace'], description: 'Type de dashboard. Requis sauf pour action=list et action=read_overview.' },
            machineId: { type: 'string', description: 'ID machine (défaut: machine locale). Pour type machine.' },
            workspace: { type: 'string', description: 'Workspace ID (défaut: workspace courant). Pour type workspace.' },
            section: { type: 'string', enum: ['status', 'intercom', 'all'], description: '(read) Section à lire (défaut: all)' },
            intercomLimit: { type: 'number', description: '(read) Nombre max de messages intercom retournés (défaut: tous). Auto-condensation à 50KB garantit un dashboard lisible.' },
            content: { type: 'string', description: '(write/append) Contenu markdown : pour write = nouveau status (remplace), pour append = nouveau message' },
            author: { type: 'object', properties: { machineId: { type: 'string' }, workspace: { type: 'string' }, worktree: { type: 'string' } }, required: ['machineId', 'workspace'], description: '(write/append) Auteur de la modification. Défaut: machine+workspace locaux.' },
            createIfNotExists: { type: 'boolean', description: "(write/append) Créer le dashboard s'il n'existe pas (défaut: true)" },
            tags: { type: 'array', items: { type: 'string' }, description: '(append) Tags pour le message intercom (ex: ["INFO", "WARN", "ERROR"])' },
            keepMessages: { type: 'number', description: '(condense) Nombre de messages à conserver (défaut: 100)' },
            archiveFile: { type: 'string', description: '(read_archive) Nom du fichier archive à lire. Si absent, liste les archives disponibles.' },
            mentions: {
                type: 'array',
                description: '(append) Mentions structurées v3 (#1363). Chaque entrée = userId XOR messageId (exactement un des deux). Notifie les destinataires via RooSync (fire-and-forget, dedup par machineId).',
                items: {
                    type: 'object',
                    properties: {
                        userId: {
                            type: 'object',
                            description: 'userId explicite à mentionner (exclusif avec messageId).',
                            properties: {
                                machineId: { type: 'string', description: 'ID de la machine' },
                                workspace: { type: 'string', description: 'Workspace ID' }
                            },
                            required: ['machineId', 'workspace'],
                            additionalProperties: false
                        },
                        messageId: {
                            type: 'string',
                            description: 'ID de message à référencer (format: machineId:workspace:ic-...). Résout en userId = auteur du message référencé.'
                        },
                        note: {
                            type: 'string',
                            description: 'Note optionnelle expliquant la raison de la mention.'
                        }
                    },
                    additionalProperties: false
                }
            },
            crossPost: {
                type: 'array',
                description: '(append) Cross-post le même message vers d\'autres dashboards v3 (#1363), SANS notification RooSync. Self-skip : une cible pointant vers le dashboard source ne duplique pas. Target manquant + createIfNotExists=false = entrée { key, ok: false, error } dans result.crossPost.',
                items: {
                    type: 'object',
                    properties: {
                        type: {
                            type: 'string',
                            enum: ['global', 'machine', 'workspace'],
                            description: 'Type de dashboard cible.'
                        },
                        machineId: {
                            type: 'string',
                            description: 'machineId cible (pour type=machine).'
                        },
                        workspace: {
                            type: 'string',
                            description: 'workspace cible (pour type=workspace).'
                        }
                    },
                    required: ['type'],
                    additionalProperties: false
                }
            }
        },
        required: ['action'],
        additionalProperties: false
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
    // RooSync tools (22) — same order as roosyncTools array in roosync/index.ts
    roosyncInitDefinition,
    roosyncGetStatusDefinition,
    roosyncCompareConfigDefinition,
    roosyncListDiffsDefinition,
    roosyncDecisionDefinition,
    roosyncDecisionInfoDefinition,
    roosyncBaselineDefinition,
    roosyncConfigDefinition,
    roosyncInventoryDefinition,
    roosyncMachinesDefinition,
    roosyncHeartbeatDefinition,
    roosyncMcpManagementDefinition,
    roosyncStorageManagementDefinition,
    roosyncDiagnoseDefinition,
    roosyncRefreshDashboardDefinition,
    roosyncUpdateDashboardDefinition,
    roosyncSendDefinition,
    roosyncReadDefinition,
    roosyncManageDefinition,
    roosyncCleanupMessagesDefinition,
    roosyncAttachmentsDefinition,
    roosyncDashboardDefinition
];
