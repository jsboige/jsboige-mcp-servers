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

export {
  roosyncInit,
  InitArgsSchema,
  InitResultSchema,
  initToolMetadata
} from './init.js';

export type {
  InitArgs,
  InitResult
} from './init.js';

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

// Les outils de diff granulaire ont été supprimés en Phase 3

// Export des outils de configuration partagée (Cycle 6)
export { roosyncCollectConfig, collectConfigToolMetadata } from './collect-config.js';
export { roosyncPublishConfig, publishConfigToolMetadata } from './publish-config.js';
export { roosyncApplyConfig, applyConfigToolMetadata } from './apply-config.js';

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

// NOUVEAU: Outil d'inventaire
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

// Export des outils de synchronisation automatique (T3.16)
export { roosyncSyncOnOffline, syncOnOfflineToolMetadata } from './sync-on-offline.js';
export { roosyncSyncOnOnline, syncOnOnlineToolMetadata } from './sync-on-online.js';

// Export des outils de dashboard (T3.17)
export { roosyncRefreshDashboard, refreshDashboardToolMetadata } from './refresh-dashboard.js';

// Import des métadonnées pour l'array
import { getStatusToolMetadata } from './get-status.js';
import { compareConfigToolMetadata } from './compare-config.js';
import { listDiffsToolMetadata } from './list-diffs.js';
import { approveDecisionToolMetadata } from './approve-decision.js';
import { rejectDecisionToolMetadata } from './reject-decision.js';
import { applyDecisionToolMetadata } from './apply-decision.js';
import { rollbackDecisionToolMetadata } from './rollback-decision.js';
import { getDecisionDetailsToolMetadata } from './get-decision-details.js';
import { initToolMetadata } from './init.js';
import { updateBaselineToolMetadata } from './update-baseline.js';
import { manageBaselineToolMetadata } from './manage-baseline.js';
import { debugResetToolMetadata } from './debug-reset.js';
import { collectConfigToolMetadata } from './collect-config.js';
import { publishConfigToolMetadata } from './publish-config.js';
import { applyConfigToolMetadata } from './apply-config.js';
import { getMachineInventoryTool } from './get-machine-inventory.js';

// Import des métadonnées des outils Heartbeat (T3.16) - @deprecated
import { registerHeartbeatToolMetadata } from './register-heartbeat.js';
import { getOfflineMachinesToolMetadata } from './get-offline-machines.js';
import { getWarningMachinesToolMetadata } from './get-warning-machines.js';
import { getHeartbeatStateToolMetadata } from './get-heartbeat-state.js';
import { startHeartbeatServiceToolMetadata } from './start-heartbeat-service.js';
import { stopHeartbeatServiceToolMetadata } from './stop-heartbeat-service.js';
import { checkHeartbeatsToolMetadata } from './check-heartbeats.js';

// Import des métadonnées des outils Heartbeat consolides (CONS-2)
import { heartbeatStatusToolMetadata } from './heartbeat-status.js';
import { heartbeatServiceToolMetadata } from './heartbeat-service.js';

// Import des métadonnées des outils de synchronisation automatique (T3.16)
import { syncOnOfflineToolMetadata } from './sync-on-offline.js';
import { syncOnOnlineToolMetadata } from './sync-on-online.js';

// Import des métadonnées des outils de dashboard (T3.17)
import { refreshDashboardToolMetadata } from './refresh-dashboard.js';

// Métadonnées pour l'outil d'inventaire (format JSON Schema standard)
const getMachineInventoryToolMetadata = {
  name: 'roosync_get_machine_inventory',
  description: 'Collecte l\'inventaire complet de configuration de la machine courante pour RooSync.',
  inputSchema: {
    type: 'object',
    properties: {
      machineId: {
        type: 'string',
        description: 'Identifiant optionnel de la machine (défaut: hostname)'
      }
    }
  }
};

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
 * Version 3.1.1 : 27 outils (dont 2 nouveaux consolides)
 * - Configuration: init, compare-config, update-baseline, manage-baseline, export-baseline
 * - Services: collect-config, publish-config, apply-config, get-machine-inventory
 * - Presentation: get-status (fusionne avec read-dashboard), list-diffs, refresh-dashboard
 * - Decision: approve-decision, reject-decision, apply-decision, rollback-decision, get-decision-details
 * - Heartbeat legacy (deprecated): register-heartbeat, get-offline-machines, get-warning-machines, get-heartbeat-state, start-heartbeat-service, stop-heartbeat-service, check-heartbeats
 * - Heartbeat v3.1 (CONS-2): heartbeat-status, heartbeat-service
 * - Synchronisation automatique: sync-on-offline, sync-on-online
 * - Debug: debug-reset (fusionne avec debug-dashboard et reset-service)
 */
export const roosyncTools = [
  initToolMetadata,
  getStatusToolMetadata,
  compareConfigToolMetadata,
  listDiffsToolMetadata,
  approveDecisionToolMetadata,
  rejectDecisionToolMetadata,
  applyDecisionToolMetadata,
  rollbackDecisionToolMetadata,
  getDecisionDetailsToolMetadata,
  updateBaselineToolMetadata,
  manageBaselineToolMetadata,
  exportBaselineToolMetadata,
  collectConfigToolMetadata,
  publishConfigToolMetadata,
  applyConfigToolMetadata,
  getMachineInventoryToolMetadata,
  debugResetToolMetadata,
  // Outils Heartbeat legacy (T3.16) - @deprecated, utiliser heartbeat-status et heartbeat-service
  registerHeartbeatToolMetadata,
  getOfflineMachinesToolMetadata,
  getWarningMachinesToolMetadata,
  getHeartbeatStateToolMetadata,
  startHeartbeatServiceToolMetadata,
  stopHeartbeatServiceToolMetadata,
  checkHeartbeatsToolMetadata,
  // Outils Heartbeat consolides v3.1 (CONS-2)
  heartbeatStatusToolMetadata,
  heartbeatServiceToolMetadata,
  // Outils de synchronisation automatique (T3.16)
  syncOnOfflineToolMetadata,
  syncOnOnlineToolMetadata,
  // Outils de dashboard (T3.17)
  refreshDashboardToolMetadata
];