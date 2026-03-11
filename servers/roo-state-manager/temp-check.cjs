const { existsSync } = require('fs');
const path = require('path');

const TOOLS_SRC_DIR = path.join(__dirname, 'src/tools');

const TOOL_MAPPINGS = {
  // Conversation tools
  'conversation_browser': 'conversation/conversation-browser.ts',
  'task_browse': 'conversation/conversation-browser.ts',
  'task_export': 'conversation/conversation-browser.ts',
  'view_conversation_tree': 'conversation/view-details.tool.ts',
  'view_task_details': 'conversation/view-details.tool.ts',
  'get_raw_conversation': 'conversation/get-raw.tool.ts',
  'debug_analyze_task_parsing': 'conversation/debug-analyze.tool.ts',
  'roosync_summarize': 'summary/roosync-summarize.tool.ts',

  // Search/Indexing tools
  'roosync_search': 'search/roosync-search.tool.ts',
  'codebase_search': 'search/search-codebase.tool.ts',
  'roosync_indexing': 'indexing/roosync-indexing.tool.ts',
  'search_tasks_by_content': 'indexing/roosync-indexing.tool.ts',
  'index_task_semantic': 'indexing/index-task.tool.ts',
  'reset_qdrant_collection': 'indexing/reset-collection.tool.ts',
  'rebuild_task_index_fixed': '../rebuild-and-restart.ts',

  // Export tools
  'export_data': 'export/export-data.ts',
  'export_config': 'export/export-config.ts',

  // Diagnostic tools
  'analyze_roosync_problems': 'diagnostic/analyze_problems.ts',
  'diagnose_env': 'diagnostic/diagnose_env.ts',
  'read_vscode_logs': '../read-vscode-logs.ts',

  // Maintenance/Config tools
  'get_mcp_best_practices': '../get_mcp_best_practices.ts',
  'manage_mcp_settings': '../manage-mcp-settings.ts',
  'rebuild_and_restart': '../rebuild-and-restart.ts',
  'storage_info': 'storage/storage-info.ts',
  'maintenance': 'maintenance/maintenance.ts',
  'build_skeleton_cache': 'cache/build-skeleton-cache.tool.ts',
  'touch_mcp_settings': '../manage-mcp-settings.ts',

  // BOM repair tools
  'diagnose_conversation_bom': 'repair/diagnose-conversation-bom.tool.ts',
  'repair_conversation_bom': 'repair/repair-conversation-bom.tool.ts',

  // RooSync tools
  'roosync_get_status': 'roosync/get-status.ts',
  'roosync_compare_config': 'roosync/compare-config.ts',
  'roosync_list_diffs': 'roosync/list-diffs.ts',
  'roosync_get_decision_details': 'roosync/decision-info.ts',
  'roosync_approve_decision': 'roosync/approve-decision.ts',
  'roosync_reject_decision': 'roosync/apply-decision.ts',
  'roosync_apply_decision': 'roosync/apply-decision.ts',
  'roosync_rollback_decision': 'roosync/apply-decision.ts',
  'roosync_init': 'roosync/roosync_init.ts',
  'roosync_update_baseline': 'roosync/baseline.ts',
  'roosync_manage_baseline': 'roosync/baseline.ts',
  'roosync_diagnose': 'roosync/debug-reset.ts',
  'roosync_export_baseline': 'roosync/export-baseline.ts',
  'roosync_collect_config': 'roosync/collect-config.ts',
  'roosync_publish_config': 'roosync/apply-config.ts',
  'roosync_apply_config': 'roosync/apply-config.ts',
  'roosync_decision': 'roosync/decision.ts',
  'roosync_decision_info': 'roosync/decision-info.ts',
  'roosync_baseline': 'roosync/baseline.ts',
  'roosync_config': 'roosync/config.ts',
  'roosync_inventory': 'roosync/inventory.ts',
  'roosync_machines': 'roosync/machines.ts',
  'roosync_heartbeat': 'roosync/heartbeat.ts',
  'roosync_send': 'roosync/send.ts',
  'roosync_read': 'roosync/read.ts',
  'roosync_manage': 'roosync/manage.ts',
  'roosync_cleanup_messages': 'roosync/cleanup.ts',
  'roosync_send_message': 'roosync/send-message.ts',
  'roosync_read_inbox': 'roosync/read-message.ts',
  'roosync_get_message': 'roosync/read-message.ts',
  'roosync_mark_message_read': 'roosync/archive-message.ts',
  'roosync_archive_message': 'roosync/archive-message.ts',
  'roosync_reply_message': 'roosync/amend-message.ts',
  'roosync_get_machine_inventory': 'roosync/get-machine-inventory.ts',
  'roosync_refresh_dashboard': 'roosync/refresh-dashboard.ts',
  'roosync_update_dashboard': 'roosync/update-dashboard.ts',
  'roosync_sync_event': 'roosync/sync-event.ts',
  'roosync_mcp_management': 'roosync/mcp-management.ts',
  'roosync_storage_management': 'roosync/storage-management.ts',
};

const ALL_MCP_TOOLS = [
  'analyze_roosync_problems',
  'build_skeleton_cache',
  'codebase_search',
  'debug_analyze_task_parsing',
  'diagnose_conversation_bom',
  'diagnose_env',
  'get_mcp_best_practices',
  'get_raw_conversation',
  'index_task_semantic',
  'maintenance',
  'manage_mcp_settings',
  'rebuild_and_restart',
  'rebuild_task_index_fixed',
  'repair_conversation_bom',
  'reset_qdrant_collection',
  'roosync_apply_config',
  'roosync_apply_decision',
  'roosync_approve_decision',
  'roosync_archive_message',
  'roosync_baseline',
  'roosync_cleanup_messages',
  'roosync_collect_config',
  'roosync_config',
  'roosync_decision',
  'roosync_decision_info',
  'roosync_diagnose',
  'roosync_export_baseline',
  'roosync_get_decision_details',
  'roosync_get_machine_inventory',
  'roosync_get_message',
  'roosync_get_status',
  'roosync_heartbeat',
  'roosync_init',
  'roosync_inventory',
  'roosync_list_diffs',
  'roosync_machines',
  'roosync_manage',
  'roosync_mcp_management',
  'roosync_publish_config',
  'roosync_read',
  'roosync_read_inbox',
  'roosync_refresh_dashboard',
  'roosync_reject_decision',
  'roosync_reply_message',
  'roosync_rollback_decision',
  'roosync_send',
  'roosync_send_message',
  'roosync_storage_management',
  'roosync_sync_event',
  'roosync_update_baseline',
  'roosync_update_dashboard',
  'roosync_summarize',
  'roosync_search',
  'roosync_indexing',
  'roosync_compare_config',
  'storage_info',
  'search_tasks_by_content',
  'task_browse',
  'task_export',
  'view_conversation_tree',
  'view_task_details',
  'read_vscode_logs',
  'touch_mcp_settings',
  'export_data',
  'export_config',
  'conversation_browser',
];

const toolsWithoutSource = [];

for (const toolName of ALL_MCP_TOOLS) {
  const sourcePath = TOOL_MAPPINGS[toolName];
  if (!sourcePath) {
    toolsWithoutSource.push(toolName);
    continue;
  }

  const fullPath = path.join(TOOLS_SRC_DIR, sourcePath);
  if (!existsSync(fullPath)) {
    toolsWithoutSource.push(toolName + ' (' + fullPath + ')');
  }
}

console.log('Tools without source files (' + toolsWithoutSource.length + '):');
toolsWithoutSource.forEach(t => console.log('  -', t));
