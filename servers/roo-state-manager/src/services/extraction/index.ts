/**
 * Extraction module barrel export
 * @module services/extraction
 * @issue #1392
 */

export { RooTaskExtractor } from './roo-task-extractor.js';
export { ClaudeTaskExtractor } from './claude-task-extractor.js';
export { UnifiedTaskExtractor } from './unified-task-extractor.js';
export type {
  TaskExtractor,
  ExtractionOptions,
  ExtractionResult,
} from './task-extractor.js';
export type { UnifiedExtractionResult } from './unified-task-extractor.js';
