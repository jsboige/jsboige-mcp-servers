/**
 * Export centralisé des outils RooSync
 *
 * @module tools/roosync
 * @version 3.0.0
 */

export {
  roosyncGetStatus,
  GetStatusArgsSchema,
  GetStatusResultSchema,
  getStatusToolMetadata
} from './get-status.js';

export type {
  GetStatusArgs,
  GetStatusResult
} from './get-status.js';

export {
  roosyncCompareConfig,
  CompareConfigArgsSchema,
  CompareConfigResultSchema,
  compareConfigToolMetadata
} from './compare-config.js';

export type {
  CompareConfigArgs,
  CompareConfigResult
} from './compare-config.js';

export {
  roosyncListDiffs,
  ListDiffsArgsSchema,
  ListDiffsResultSchema,
  listDiffsToolMetadata
} from './list-diffs.js';

export type {
  ListDiffsArgs,
  ListDiffsResult
} from './list-diffs.js';

export {
  roosyncApproveDecision,
  ApproveDecisionArgsSchema,
  ApproveDecisionResultSchema,
  approveDecisionToolMetadata
} from './approve-decision.js';

export type {
  ApproveDecisionArgs,
  ApproveDecisionResult
} from './approve-decision.js';

export {
  roosyncRejectDecision,
  RejectDecisionArgsSchema,
  RejectDecisionResultSchema,
  rejectDecisionToolMetadata
} from './reject-decision.js';

export type {
  RejectDecisionArgs,
  RejectDecisionResult
} from './reject-decision.js';

export {
  roosyncApplyDecision,
  ApplyDecisionArgsSchema,
  ApplyDecisionResultSchema,
  applyDecisionToolMetadata
} from './apply-decision.js';

export type {
  ApplyDecisionArgs,
  ApplyDecisionResult
} from './apply-decision.js';

export {
  roosyncRollbackDecision,
  RollbackDecisionArgsSchema,
  RollbackDecisionResultSchema,
  rollbackDecisionToolMetadata
} from './rollback-decision.js';

export type {
  RollbackDecisionArgs,
  RollbackDecisionResult
} from './rollback-decision.js';

export {
  roosyncGetDecisionDetails,
  GetDecisionDetailsArgsSchema,
  GetDecisionDetailsResultSchema,
  getDecisionDetailsToolMetadata
} from './get-decision-details.js';

export type {
  GetDecisionDetailsArgs,
  GetDecisionDetailsResult
} from './get-decision-details.js';

// CONS-5: Outils consolidés de décisions (5→2)
export {
  roosyncDecision,
  RooSyncDecisionArgsSchema,
  RooSyncDecisionResultSchema,
  roosyncDecisionToolMetadata
} from './decision.js';

export type {
  RooSyncDecisionArgs,
  RooSyncDecisionResult
} from './decision.js';

export {
  roosyncDecisionInfo,
  RooSyncDecisionInfoArgsSchema,
  RooSyncDecisionInfoResultSchema,
  roosyncDecisionInfoToolMetadata
} from './decision-info.js';

export type {
  RooSyncDecisionInfoArgs,
  RooSyncDecisionInfoResult
} from './decision-info.js';

export {
  roosyncInit,
  InitArgsSchema,
  InitResultSchema,
  initToolMetadata
} from './roosync_init.js';

export type {
  InitArgs,
  InitResult
} from './roosync_init.js';

export {
  roosyncUpdateBaseline,
  UpdateBaselineArgsSchema,
  UpdateBaselineResultSchema,
  updateBaselineToolMetadata
} from './update-baseline.js';

export type {
  UpdateBaselineArgs,
  UpdateBaselineResult
} from './update-baseline.js';

// Outils consolidés v2.3 - Remplacent version-baseline et restore-baseline
export {
  roosync_manage_baseline,
  ManageBaselineArgsSchema,
  ManageBaselineResultSchema,
  manageBaselineToolMetadata
} from './manage-baseline.js';

export type {
  ManageBaselineArgs,
  ManageBaselineResult
} from './manage-baseline.js';

export {
  roosync_debug_reset,
  DebugResetArgsSchema,
  DebugResetResultSchema,
  debugResetToolMetadata
} from './debug-reset.js';

export type {
  DebugResetArgs,
  DebugResetResult
} from './debug-reset.js';

export {
  roosync_export_baseline,
  ExportBaselineArgsSchema,
  ExportBaselineResultSchema
} from './export-baseline.js';

export type {
  ExportBaselineArgs,
  ExportBaselineResult
} from './export-baseline.js';

// Outil consolidé Baseline (CONS-4) - Remplace update-baseline, manage-baseline et export-baseline
export {
  roosync_baseline,
  BaselineArgsSchema,
  BaselineResultSchema,
  baselineToolMetadata
} from './baseline.js';

export type {
  BaselineArgs,
  BaselineResult
} from './baseline.js';

// Les outils de diff granulaire ont été supprimés en Phase 3

// Export des outils de configuration partagée (Cycle 6)
export { roosyncCollectConfig, collectConfigToolMetadata } from './collect-config.js';
export { roosyncPublishConfig, publishConfigToolMetadata } from './publish-config.js';
export { roosyncApplyConfig, applyConfigToolMetadata } from './apply-config.js';

// CONS-3: Outil consolidé de configuration (collect + publish + apply → roosync_config)
export { roosyncConfig, ConfigArgsSchema, configToolMetadata } from './config.js';
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
export { roosyncRead, readToolMetadata } from './read.js';
export { roosyncSend, sendToolMetadata } from './send.js';
export { roosyncManage, manageToolMetadata } from './manage.js';

// CONS-6: Outils consolidés Inventory (4→2)
export { inventoryTool, inventoryToolMetadata } from './inventory.js';
export { roosyncMachines, machinesToolMetadata } from './machines.js';
// [DEPRECATED] Legacy inventory tool - utiliser inventoryTool à la place
export { getMachineInventoryTool } from './get-machine-inventory.js';

// Export des outils Heartbeat (T3.16)
// @deprecated Ces 7 outils seront remplaces par heartbeat_status et heartbeat_service dans une future version
export { roosyncRegisterHeartbeat, registerHeartbeatToolMetadata } from './register-heartbeat.js';
export { roosyncGetOfflineMachines, getOfflineMachinesToolMetadata } from './get-offline-machines.js';
export { roosyncGetWarningMachines, getWarningMachinesToolMetadata } from './get-warning-machines.js';
export { roosyncGetHeartbeatState, getHeartbeatStateToolMetadata } from './get-heartbeat-state.js';
export { roosyncStartHeartbeatService, startHeartbeatServiceToolMetadata } from './start-heartbeat-service.js';
export { roosyncStopHeartbeatService, stopHeartbeatServiceToolMetadata } from './stop-heartbeat-service.js';
export { roosyncCheckHeartbeats, checkHeartbeatsToolMetadata } from './check-heartbeats.js';

// NOUVEAU: Outils Heartbeat consolides v3.1 (CONS-2)
export { roosyncHeartbeatStatus, heartbeatStatusToolMetadata } from './heartbeat-status.js';
export { roosyncHeartbeatService, heartbeatServiceToolMetadata } from './heartbeat-service.js';

// CONS-#443 Groupe 2: Outil consolidé de synchronisation automatique (2→1)
// Remplace sync-on-offline + sync-on-online
export { roosyncSyncEvent, syncEventToolMetadata } from './sync-event.js';

// CONS-#443 Groupe 3: Outil consolidé de gestion MCP (3→1)
// Remplace manage_mcp_settings + rebuild_and_restart_mcp + touch_mcp_settings
export { roosyncMcpManagement, mcpManagementToolMetadata } from './mcp-management.js';

// CONS-#443 Groupe 4: Outil consolidé de gestion du stockage (2→1)
// Remplace storage_info + maintenance
export { roosyncStorageManagement, storageManagementToolMetadata } from './storage-management.js';

// Export des outils de dashboard (T3.17)
export { roosyncRefreshDashboard, refreshDashboardToolMetadata } from './refresh-dashboard.js';

// Import des métadonnées pour l'array
import { getStatusToolMetadata } from './get-status.js';
import { compareConfigToolMetadata } from './compare-config.js';
import { listDiffsToolMetadata } from './list-diffs.js';
// CONS-5: Legacy decision imports replaced by consolidated
import { roosyncDecisionToolMetadata } from './decision.js';
import { roosyncDecisionInfoToolMetadata } from './decision-info.js';
import { initToolMetadata } from './roosync_init.js';
import { updateBaselineToolMetadata } from './update-baseline.js';
import { manageBaselineToolMetadata } from './manage-baseline.js';
import { baselineToolMetadata } from './baseline.js';
import { debugResetToolMetadata } from './debug-reset.js';
import { collectConfigToolMetadata } from './collect-config.js';
import { publishConfigToolMetadata } from './publish-config.js';
import { applyConfigToolMetadata } from './apply-config.js';
import { configToolMetadata } from './config.js'; // CONS-3
// Import des métadonnées des outils consolidés Inventory (CONS-6)
import { inventoryToolMetadata } from './inventory.js';
import { machinesToolMetadata } from './machines.js';

// CLEANUP-1: Imports deprecated heartbeat retirés (register, get-offline, get-warning, get-state, start, stop, check)
// Les modules existent toujours pour backward compat dans registry.ts CallTool handlers

// Import des métadonnées des outils Heartbeat consolidés (CONS-2)
import { heartbeatStatusToolMetadata } from './heartbeat-status.js';
import { heartbeatServiceToolMetadata } from './heartbeat-service.js';

// CONS-#443 Groupe 2: Import de l'outil consolidé de synchronisation
import { syncEventToolMetadata } from './sync-event.js';

// CONS-#443 Groupe 3: Import de l'outil consolidé de gestion MCP
import { mcpManagementToolMetadata } from './mcp-management.js';

// CONS-#443 Groupe 4: Import de l'outil consolidé de gestion du stockage
import { storageManagementToolMetadata } from './storage-management.js';

// Import des métadonnées des outils de dashboard (T3.17)
import { refreshDashboardToolMetadata } from './refresh-dashboard.js';

// CONS-1: Import des métadonnées des outils de messagerie consolidés
import { sendToolMetadata } from './send.js';
import { readToolMetadata } from './read.js';
import { manageToolMetadata } from './manage.js';

// Métadonnées pour l'outil d'inventaire (format JSON Schema standard)
// CONS-6: Remplacé par inventoryToolMetadata
// const getMachineInventoryToolMetadata = {
//   name: 'roosync_get_machine_inventory',
//   description: 'Collecte l\'inventaire complet de configuration de la machine courante pour RooSync.',
//   inputSchema: {
//     type: 'object',
//     properties: {
//       machineId: {
//         type: 'string',
//         description: 'Identifiant optionnel de la machine (défaut: hostname)'
//       }
//     }
//   }
// };

// Métadonnées pour l'outil export baseline
const exportBaselineToolMetadata = {
  name: 'roosync_export_baseline',
  description: 'Exporte une baseline vers différents formats (JSON, YAML, CSV)',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['json', 'yaml', 'csv'],
        description: 'Format d\'exportation'
      },
      outputPath: {
        type: 'string',
        description: 'Chemin de sortie pour le fichier exporté (optionnel)'
      },
      machineId: {
        type: 'string',
        description: 'ID de la machine à exporter (optionnel, utilise la baseline actuelle si non spécifié)'
      },
      includeHistory: {
        type: 'boolean',
        description: 'Inclure l\'historique des modifications (défaut: false)'
      },
      includeMetadata: {
        type: 'boolean',
        description: 'Inclure les métadonnées complètes (défaut: true)'
      },
      prettyPrint: {
        type: 'boolean',
        description: 'Formater la sortie pour une meilleure lisibilité (défaut: true)'
      }
    },
    required: ['format']
  }
};

/**
 * Liste de tous les outils RooSync pour enregistrement MCP
 * Version 3.10 : 20 outils (CONS-#443 Groupe 4: Storage management 2→1)
 *
 * - Configuration: init, compare-config, roosync_config (CONS-3), baseline (CONS-4)
 * - Services: inventory (CONS-6), machines (CONS-6)
 * - Presentation: get-status, list-diffs, refresh-dashboard
 * - Decision (CONS-5): roosync_decision, roosync_decision_info
 * - Heartbeat (CONS-2): heartbeat-status, heartbeat-service
 * - Synchronisation automatique (CONS-#443 Groupe 2): roosync_sync_event
 * - Messagerie (CONS-1): roosync_send, roosync_read, roosync_manage
 * - Gestion MCP (CONS-#443 Groupe 3): roosync_mcp_management
 * - Gestion stockage (CONS-#443 Groupe 4): roosync_storage_management
 * - Debug: debug-reset
 */
export const roosyncTools = [
  initToolMetadata,
  getStatusToolMetadata,
  compareConfigToolMetadata,
  listDiffsToolMetadata,
  // CONS-5: Outils de décision consolidés (5→2)
  roosyncDecisionToolMetadata,
  roosyncDecisionInfoToolMetadata,
  baselineToolMetadata, // CONS-4: Outil consolidé Baseline 3→1
  configToolMetadata, // CONS-3: Outil consolidé Config 4→2
  inventoryToolMetadata, // CONS-6: Outil consolidé Inventory (machine + heartbeat)
  machinesToolMetadata, // CONS-6: Outil consolidé Machines (offline + warning)
  debugResetToolMetadata,
  // CONS-2: heartbeat consolidés (7→2)
  heartbeatStatusToolMetadata,
  heartbeatServiceToolMetadata,
  // CONS-#443 Groupe 2: Outil consolidé de synchronisation (sync-on-offline + sync-on-online → roosync_sync_event)
  syncEventToolMetadata,
  // CONS-#443 Groupe 3: Outil consolidé de gestion MCP (manage_mcp_settings + rebuild_and_restart_mcp + touch_mcp_settings → roosync_mcp_management)
  mcpManagementToolMetadata,
  // CONS-#443 Groupe 4: Outil consolidé de gestion du stockage (storage_info + maintenance → roosync_storage_management)
  storageManagementToolMetadata,
  // Outils de dashboard (T3.17)
  refreshDashboardToolMetadata,
  // CONS-1: Outils de messagerie consolidés (6→3)
  sendToolMetadata,
  readToolMetadata,
  manageToolMetadata
];