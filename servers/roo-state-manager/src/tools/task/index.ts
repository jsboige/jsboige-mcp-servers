/**
 * Exports pour les outils de gestion des tâches
 *
 * CONS-9: Consolidation 4→2 outils
 * - task_browse (actions: tree, current) remplace get_task_tree + get_current_task
 * - task_export (actions: markdown, debug) remplace export_task_tree_markdown + debug_task_parsing
 */

// === NOUVEAUX OUTILS CONSOLIDÉS (CONS-9) ===
export {
    taskBrowseTool,
    handleTaskBrowse,
    type TaskBrowseArgs,
    type TaskBrowseAction
} from './browse.js';

export {
    taskExportTool,
    handleTaskExport,
    type TaskExportArgs,
    type TaskExportAction
} from './export.js';

// === OUTILS LEGACY (conservés pour les handlers internes) ===
// Note: Ces outils ne sont plus exposés dans registry.ts

export {
    getTaskTreeTool,
    handleGetTaskTree,
    type GetTaskTreeArgs
} from './get-tree.tool.js';

export {
    debugTaskParsingTool,
    handleDebugTaskParsing,
    type DebugTaskParsingArgs
} from './debug-parsing.tool.js';

export {
    exportTaskTreeMarkdownTool,
    handleExportTaskTreeMarkdown,
    type ExportTaskTreeMarkdownArgs
} from './export-tree-md.tool.js';

export {
    getCurrentTaskTool
} from './get-current-task.tool.js';
