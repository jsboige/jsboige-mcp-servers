/**
 * Export centralisé des outils RooSync
 *
 * @module tools/roosync
 * @version 3.0.0
 */

export {
  roosyncGetStatus,
  GetStatusArgsSchema,
  GetStatusResultSchema
} from './get-status.js';

export type {
  GetStatusArgs,
  GetStatusResult
} from './get-status.js';

export {
  roosyncCompareConfig,
  CompareConfigArgsSchema,
  CompareConfigResultSchema
} from './compare-config.js';

export type {
  CompareConfigArgs,
  CompareConfigResult
} from './compare-config.js';

export {
  roosyncListDiffs,
  ListDiffsArgsSchema,
  ListDiffsResultSchema
} from './list-diffs.js';

export type {
  ListDiffsArgs,
  ListDiffsResult
} from './list-diffs.js';

// [REMOVED Phase B #1863] approve/reject/apply/rollback decision + get-decision-details backward-compat exports

// CONS-5: Outils consolidés de décisions (5→2)
export {
  roosyncDecision,
  RooSyncDecisionArgsSchema,
  RooSyncDecisionResultSchema
} from './decision.js';

export type {
  RooSyncDecisionArgs,
  RooSyncDecisionResult
} from './decision.js';

// [REMOVED #1863] Deprecated roosync_decision_info exports — fused into roosync_decision(action: "info")
// Source file decision-info.ts retained for: decision.ts imports + registry.ts redirect + tests

export {
  roosyncInit,
  InitArgsSchema,
  InitResultSchema
} from './roosync_init.js';

export type {
  InitArgs,
  InitResult
} from './roosync_init.js';

// [REMOVED Phase B #1863] update-baseline backward-compat export

// [REMOVED Phase B #1863] manage-baseline backward-compat export

export {
  roosync_debug_reset,
  DebugResetArgsSchema,
  DebugResetResultSchema
} from './debug-reset.js';

export type {
  DebugResetArgs,
  DebugResetResult
} from './debug-reset.js';

// [REMOVED Phase B #1863] export-baseline backward-compat export

// Outil consolidé Baseline (CONS-4) - Remplace update-baseline, manage-baseline et export-baseline
export {
  roosync_baseline,
  BaselineArgsSchema,
  BaselineResultSchema
} from './baseline.js';

export type {
  BaselineArgs,
  BaselineResult
} from './baseline.js';

// Les outils de diff granulaire ont été supprimés en Phase 3

// Export des outils de configuration partagée (Cycle 6)

// CONS-3: Outil consolidé de configuration (collect + publish + apply → roosync_config)
export { roosyncConfig, ConfigArgsSchema } from './config.js';
export type { ConfigArgs } from './config.js';

// Export des nouveaux outils de messagerie (Phase 1)
export { sendMessage } from './send_message.js';
export { readInbox } from './read_inbox.js';
export { getMessage } from './get_message.js';

// Export des outils de messagerie Phase 2 - Management Tools
export { markMessageRead } from './mark_message_read.js';
export { archiveMessage } from './archive_message.js';
export { replyMessage } from './reply_message.js';

// Export des outils de messagerie Phase 3 - Advanced Features
export { amendMessage } from './amend_message.js';

// ============================================================
// CONS-1 : Outils consolidés de messagerie (7→3)
// ============================================================
// Ces 3 outils remplacent progressivement les 7 outils legacy ci-dessus :
// - roosyncRead (mode: inbox|message) → remplace read_inbox + get_message
// - roosyncSend (action: send|reply|amend) → remplace send_message + reply_message + amend_message
// - roosyncManage (action: mark_read|archive) → remplace mark_message_read + archive_message
export { roosyncRead } from './read.js';
export { roosyncSend } from './send.js';
export { roosyncManage } from './manage.js';

// CONS-8 (#1841 Cluster G): Outil consolide messagerie (4→1: send+read+manage+attachments)
export { roosyncMessages } from './messages.js';

// [REMOVED #1863] Deprecated cleanup_messages exports — fused into roosync_manage(action: "bulk_*")
// Source file cleanup.ts retained for: registry.ts redirect + tests

// #674: Outils de gestion des pièces jointes (legacy — backward compat)
export {
  roosyncListAttachments,
  roosyncGetAttachment,
  roosyncDeleteAttachment
} from './roosync-attachments.tool.js';

// CONS-7: Outil consolidé (list + get + delete → 1)
export {
  roosyncAttachments
} from './roosync-attachments.tool.js';

// NOTE: modes-management.ts est une API INTERNE (pas un outil MCP séparé).
// La gestion des modes sera intégrée dans le mécanisme unifié de config (#603).
// Voir #595 (subsumed by #603). Ne PAS exposer comme outil MCP indépendant.
// Usage interne uniquement: import { readCustomModes, compareModes } from './modes-management.js';

// CONS-6: Outils consolidés Inventory (4→2)
export { inventoryTool } from './inventory.js';
// [REMOVED #1863] Deprecated roosync_machines exports — fused into roosync_inventory(type: "machines")
// Source file machines.ts retained for: registry.ts redirect + tests

// #519: Legacy heartbeat tools retirés (7 outils) - utiliser roosync_heartbeat consolidé
// ADR 008 Phase 2: Dead heartbeat tools removed (heartbeat.ts, heartbeat-service.ts, heartbeat-status.ts)
// Active: heartbeat-activity.ts (utility), auto-heartbeat.ts (utility), HeartbeatService.ts (in-memory core)

// CONS-#443 Groupe 2: Outil consolidé de synchronisation automatique (2→1)
// Remplace sync-on-offline + sync-on-online
export { roosyncSyncEvent } from './sync-event.js';

// CONS-#443 Groupe 3: Outil consolidé de gestion MCP (3→1)
// Remplace manage_mcp_settings + rebuild_and_restart_mcp + touch_mcp_settings
export { roosyncMcpManagement } from './mcp-management.js';

// CONS-#443 Groupe 4: Outil consolidé de gestion du stockage (2→1)
// Remplace storage_info + maintenance
export { roosyncStorageManagement } from './storage-management.js';

// CONS-#443 Groupe 5: Outil consolidé de diagnostic (3→1)
// Remplace diagnose_env + debug_reset + minimal_test_tool
export { roosyncDiagnose } from './diagnose.js';

// Export des outils de dashboard (T3.17)
export { roosyncRefreshDashboard } from './refresh-dashboard.js';
// #546: Dashboard hiérarchique
export { roosyncUpdateDashboard, UpdateDashboardArgsSchema, UpdateDashboardResultSchema } from './update-dashboard.js';

export type {
	UpdateDashboardArgs,
	UpdateDashboardResult
} from './update-dashboard.js';

// [REMOVED] Dead *ToolMetadata imports — the roosyncTools array that consumed them
// was removed (#1470, orphan never used by registry.ts). The MCP tool definitions
// served to clients live in tool-definitions.ts (allToolDefinitions).

// #1320: Lifecycle state machine tool
export {
  reportLifecycle,
  LifecycleArgsSchema,
  LifecycleResultSchema,
  lifecycleToolMetadata,
  AGENT_LIFECYCLE_STATES
} from './lifecycle.js';
export type { LifecycleArgs, LifecycleResult } from './lifecycle.js';
import { lifecycleToolMetadata } from './lifecycle.js';

// #675: Dashboards markdown partagés cross-machine
// #1470: Metadata import from dashboard-schemas.ts (no handler dependency)
import { dashboardToolMetadata } from './dashboard-schemas.js';

export {
  roosyncDashboard,
  DashboardArgsSchema,
  AuthorSchema,
  IntercomMessageSchema
} from './dashboard.js';

// #1470: Re-export metadata from single source of truth
export { dashboardToolMetadata } from './dashboard-schemas.js';

export type {
  DashboardArgs,
  Dashboard,
  Author,
  IntercomMessage,
  DashboardResult
} from './dashboard.js';

// NOTE: modes-management.ts = API interne only, pas d'import MCP ici (#595/#603)

// #1470: roosyncTools array removed — orphan, never consumed by registry.ts
// (registry uses allToolDefinitions from tool-definitions.ts instead)
// #2224: 26 dead *ToolMetadata exports removed from handler files + this barrel.