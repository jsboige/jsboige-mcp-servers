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

// Import des métadonnées pour l'array
import { getStatusToolMetadata } from './get-status.js';
import { compareConfigToolMetadata } from './compare-config.js';
import { listDiffsToolMetadata } from './list-diffs.js';

/**
 * Liste de tous les outils RooSync pour enregistrement MCP
 */
export const roosyncTools = [
  getStatusToolMetadata,
  compareConfigToolMetadata,
  listDiffsToolMetadata
];