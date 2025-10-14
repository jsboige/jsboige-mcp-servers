/**
 * Export centralisé des outils RooSync
 *
 * @module tools/roosync
 * @version 2.0.0
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

/**
 * Liste de tous les outils RooSync pour enregistrement MCP
 * Phase 5 : 9 outils complets (Configuration + Services + Présentation + Décision + Exécution + Initialisation)
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
  getDecisionDetailsToolMetadata
];