/**
 * Export centralisé des outils RooSync
 *
 * @module tools/roosync
 * @version 2.3.0
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
 * Version 2.3 : 16 outils consolidés
 * - Configuration: init, compare-config, update-baseline, manage-baseline, export-baseline
 * - Services: collect-config, publish-config, apply-config, get-machine-inventory
 * - Présentation: get-status (fusionné avec read-dashboard), list-diffs
 * - Décision: approve-decision, reject-decision, apply-decision, rollback-decision, get-decision-details
 * - Debug: debug-reset (fusionné avec debug-dashboard et reset-service)
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
  debugResetToolMetadata
];