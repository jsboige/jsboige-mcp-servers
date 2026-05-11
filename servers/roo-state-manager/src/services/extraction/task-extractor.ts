/**
 * TaskExtractor — Base interface for cross-format task extraction
 *
 * @module services/extraction/task-extractor
 * @issue #1392 (#1360-2)
 *
 * Common API that both Roo and Claude extractors implement,
 * enabling UnifiedTaskExtractor to delegate transparently.
 */

import type { UnifiedTask } from '../../types/unified-task.js';

/** Options shared by all extractors */
export interface ExtractionOptions {
  /** Include computed fields like storageTier */
  includeComputedFields?: boolean;
  /** Custom machine ID override */
  machineId?: string;
}

/** Result of a single-source extraction */
export interface ExtractionResult {
  tasks: UnifiedTask[];
  source: 'roo' | 'claude-code';
  errors: Array<{ taskId?: string; message: string }>;
}

/**
 * Base interface for task extractors.
 * Each source (Roo, Claude Code) implements this interface.
 */
export interface TaskExtractor {
  /** Human-readable source name */
  readonly sourceName: 'roo' | 'claude-code';

  /** Extract all tasks from this source */
  extractAll(options?: ExtractionOptions): Promise<ExtractionResult>;

  /** Extract a single task by ID */
  extractById(taskId: string, options?: ExtractionOptions): Promise<UnifiedTask | null>;

  /** Check if this extractor's storage is available */
  isAvailable(): Promise<boolean>;
}
