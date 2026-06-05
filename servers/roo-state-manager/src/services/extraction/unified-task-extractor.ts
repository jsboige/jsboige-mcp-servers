/**
 * UnifiedTaskExtractor — Orchestrator for cross-format task extraction
 *
 * @module services/extraction/unified-task-extractor
 * @issue #1392 (#1360-2), #2429 (zoo-code source)
 *
 * Delegates to RooTaskExtractor, ClaudeTaskExtractor, and ZooTaskExtractor,
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
import { ZooTaskExtractor } from './zoo-task-extractor.js';

/** Source types supported by the unified extractor */
type SupportedSource = 'roo' | 'claude-code' | 'zoo-code';

/** Combined result from all extractors */
export interface UnifiedExtractionResult {
  tasks: UnifiedTask[];
  bySource: Record<SupportedSource, ExtractionResult>;
  totalErrors: number;
}

export class UnifiedTaskExtractor {
  private readonly extractors: TaskExtractor[];

  constructor(extractors?: TaskExtractor[]) {
    this.extractors = extractors ?? [
      new RooTaskExtractor(),
      new ClaudeTaskExtractor(),
      new ZooTaskExtractor(),
    ];
  }

  /** Extract tasks from all available sources */
  async extractAll(options?: ExtractionOptions): Promise<UnifiedExtractionResult> {
    const results = await Promise.all(
      this.extractors.map(ext => ext.extractAll(options)),
    );

    const allTasks = results.flatMap(r => r.tasks);
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

    const bySource = {} as Record<SupportedSource, ExtractionResult>;
    for (let i = 0; i < this.extractors.length; i++) {
      const sourceName = this.extractors[i].sourceName as SupportedSource;
      bySource[sourceName] = results[i];
    }

    return { tasks: allTasks, bySource, totalErrors };
  }

  /** Extract a single task by ID from the appropriate source */
  async extractById(
    taskId: string,
    options?: ExtractionOptions,
  ): Promise<UnifiedTask | null> {
    const extractor = this.getExtractorForTask(taskId);
    return extractor.extractById(taskId, options);
  }

  /** Check which sources are available */
  async getAvailableSources(): Promise<SupportedSource[]> {
    const available: SupportedSource[] = [];

    for (const extractor of this.extractors) {
      if (await extractor.isAvailable()) {
        available.push(extractor.sourceName as SupportedSource);
      }
    }

    return available;
  }

  /** Pick the right extractor based on taskId format */
  private getExtractorForTask(taskId: string): TaskExtractor {
    // Claude tasks use "claude-{projectName}" format
    if (taskId.startsWith('claude-')) {
      return this.extractors.find(e => e.sourceName === 'claude-code')
        ?? this.extractors.find(e => e.sourceName !== 'roo')
        ?? this.extractors[0];
    }
    // Default to Roo (UUID format or other)
    return this.extractors.find(e => e.sourceName === 'roo')
      ?? this.extractors[0];
  }
}
