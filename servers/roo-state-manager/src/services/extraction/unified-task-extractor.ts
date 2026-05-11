/**
 * UnifiedTaskExtractor — Orchestrator for cross-format task extraction
 *
 * @module services/extraction/unified-task-extractor
 * @issue #1392 (#1360-2)
 *
 * Delegates to RooTaskExtractor and ClaudeTaskExtractor,
 * merging results into a single unified collection.
 */

import type { UnifiedTask } from '../../types/unified-task.js';
import type {
  TaskExtractor,
  ExtractionOptions,
  ExtractionResult,
} from './task-extractor.js';
import { RooTaskExtractor } from './roo-task-extractor.js';
import { ClaudeTaskExtractor } from './claude-task-extractor.js';

/** Combined result from all extractors */
export interface UnifiedExtractionResult {
  tasks: UnifiedTask[];
  bySource: {
    roo: ExtractionResult;
    'claude-code': ExtractionResult;
  };
  totalErrors: number;
}

export class UnifiedTaskExtractor {
  private readonly extractors: TaskExtractor[];

  constructor(extractors?: TaskExtractor[]) {
    this.extractors = extractors ?? [
      new RooTaskExtractor(),
      new ClaudeTaskExtractor(),
    ];
  }

  /** Extract tasks from all available sources */
  async extractAll(options?: ExtractionOptions): Promise<UnifiedExtractionResult> {
    const rooResult = await this.extractors[0].extractAll(options);
    const claudeResult = await this.extractors[1].extractAll(options);

    const allTasks = [...rooResult.tasks, ...claudeResult.tasks];
    const totalErrors = rooResult.errors.length + claudeResult.errors.length;

    return {
      tasks: allTasks,
      bySource: {
        roo: rooResult,
        'claude-code': claudeResult,
      },
      totalErrors,
    };
  }

  /** Extract a single task by ID from the appropriate source */
  async extractById(
    taskId: string,
    options?: ExtractionOptions,
  ): Promise<UnifiedTask | null> {
    // Determine source from taskId format
    const extractor = this.getExtractorForTask(taskId);
    return extractor.extractById(taskId, options);
  }

  /** Check which sources are available */
  async getAvailableSources(): Promise<Array<'roo' | 'claude-code'>> {
    const available: Array<'roo' | 'claude-code'> = [];

    for (const extractor of this.extractors) {
      if (await extractor.isAvailable()) {
        available.push(extractor.sourceName);
      }
    }

    return available;
  }

  /** Pick the right extractor based on taskId format */
  private getExtractorForTask(taskId: string): TaskExtractor {
    // Claude tasks use "claude-{projectName}" format
    if (taskId.startsWith('claude-')) {
      return this.extractors.find(e => e.sourceName === 'claude-code')
        ?? this.extractors[1];
    }
    // Default to Roo (UUID format or other)
    return this.extractors.find(e => e.sourceName === 'roo')
      ?? this.extractors[0];
  }
}
