export * from './read-vscode-logs.js';
export * from './storage/index.js';
export * from './rebuild-and-restart.js';
export { getMcpBestPractices } from './get_mcp_best_practices.js';
export * from './manage-mcp-settings.js';
export { rebuildTaskIndexFixed } from './manage-mcp-settings.js';
// export * from './vscode-global-state.js'; // Problème runtime - désactivé temporairement
// export { examineRooGlobalStateTool } from './examine-roo-global-state.js'; // Depends on vscode-global-state
// export { repairTaskHistoryTool } from './repair-task-history.js'; // Depends on vscode-global-state
// export * from './normalize-workspace-paths.js'; // Depends on vscode-global-state
export { viewConversationTree } from './view-conversation-tree.js';

// Conversation tools - Batch 2 refactoring
export * from './conversation/index.js';

// Task tools - Batch 3 refactoring
export * from './task/index.js';

// Search & Indexing tools - Batch 4 refactoring
export * from './search/index.js';
// XML Export tools - Batch 5 refactoring
export * from './export/index.js';
export * from './indexing/index.js';

// Summary & Synthesis tools - Batch 6 refactoring
export * from './summary/index.js';
// RooSync tools - Batch 6 synchronization
export * from './roosync/index.js';

// Cache & Repair tools - Batch 8 refactoring
export * from './cache/index.js';
export * from './repair/index.js';

// CONS-13: Maintenance tools consolidés (5→2)
export * from './maintenance/index.js';

// Diagnostic Tools - WP4 (Cycle 7)
export * from './diagnostic/index.js';
