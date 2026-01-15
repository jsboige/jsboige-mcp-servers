/**
 * Point d'entrée pour tous les types du roo-state-manager
 */

// Types Baseline canoniques (v3.0 - Source de vérité)
// @see docs/suivi/RooSync/T3_9_ANALYSE_BASELINE_UNIQUE.md
export * from './baseline-unified.js';

// Types Baseline legacy (v2.1 - @deprecated)
// @deprecated Utiliser les types de baseline-unified.js
export type {
  BaselineConfig as LegacyBaselineConfig,
  BaselineFileConfig as LegacyBaselineFileConfig,
} from './baseline.js';

// Types Baseline intermédiaire (v2.2 - @deprecated)
// @deprecated Utiliser les types de baseline-unified.js
export type {
  MachineInventory as LegacyMachineInventoryV2,
  MachineConfigurationMapping as LegacyMachineConfigurationMappingV2,
  NonNominativeBaseline as LegacyNonNominativeBaselineV2,
  NonNominativeComparisonReport as LegacyNonNominativeComparisonReportV2,
  NonNominativeBaselineState as LegacyNonNominativeBaselineStateV2,
  AggregationConfig as LegacyAggregationConfigV2,
  MigrationOptions as LegacyMigrationOptionsV2,
  MigrationResult as LegacyMigrationResultV2,
} from './non-nominative-baseline.js';

// Types de conversation
export * from './conversation.js';

// Types d'arborescence de tâches
export * from './task-tree.js';

// Types d'indexation
export * from './indexing.js';

// Types de conversation améliorés
export * from './enhanced-conversation.js';

// Types d'hiérarchie améliorés
export * from './enhanced-hierarchy.js';

// Types de définitions d'outils
export * from './tool-definitions.js';