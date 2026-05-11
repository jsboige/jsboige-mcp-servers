/**
 * RooTaskExtractor — Extracts UnifiedTasks from Roo Code storage
 *
 * @module services/extraction/roo-task-extractor
 * @issue #1392 (#1360-2)
 *
 * Wraps RooStorageDetector and converts ConversationSkeleton → UnifiedTask
 * via the toUnifiedTask() conversion helper from #1391.
 */

import * as path from 'path';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import {
  toUnifiedTask,
  computeStorageTier,
} from '../../types/unified-task.js';
import type { UnifiedTask } from '../../types/unified-task.js';
import type {
  TaskExtractor,
  ExtractionOptions,
  ExtractionResult,
} from './task-extractor.js';

export class RooTaskExtractor implements TaskExtractor {
  readonly sourceName = 'roo' as const;

  async isAvailable(): Promise<boolean> {
    try {
      const locations = await RooStorageDetector.detectStorageLocations();
      return locations.length > 0;
    } catch {
      return false;
    }
  }

  async extractAll(options?: ExtractionOptions): Promise<ExtractionResult> {
    const errors: Array<{ taskId?: string; message: string }> = [];
    const tasks: UnifiedTask[] = [];

    try {
      const skeletons = await RooStorageDetector.buildHierarchicalSkeletons(
        undefined,
        true,
        false,
      );

      for (const skeleton of skeletons) {
        try {
          const task = this.skeletonToTask(skeleton, options);
          if (task) tasks.push(task);
        } catch (err) {
          errors.push({
            taskId: skeleton.taskId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      errors.push({
        message: `Roo extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return { tasks, source: 'roo', errors };
  }

  async extractById(
    taskId: string,
    options?: ExtractionOptions,
  ): Promise<UnifiedTask | null> {
    try {
      const summary = await RooStorageDetector.findConversationById(taskId);
      if (!summary) return null;

      const input = {
        taskId: summary.taskId,
        metadata: {
          title: summary.metadata?.title,
          lastActivity: summary.lastActivity || new Date().toISOString(),
          createdAt: summary.lastActivity || new Date().toISOString(),
          messageCount: summary.messageCount || 0,
          actionCount: 0,
          totalSize: summary.size || 0,
          workspace: summary.metadata?.workspace,
          source: 'roo' as const,
        },
        isCompleted: false,
      };

      return this.applyOptions(toUnifiedTask(input), options);
    } catch {
      return null;
    }
  }

  private skeletonToTask(
    skeleton: any,
    options?: ExtractionOptions,
  ): UnifiedTask | null {
    const input = {
      taskId: skeleton.taskId,
      parentTaskId: skeleton.parentTaskId,
      metadata: {
        title: skeleton.metadata?.title,
        lastActivity: skeleton.metadata?.lastActivity || new Date().toISOString(),
        createdAt: skeleton.metadata?.createdAt || new Date().toISOString(),
        mode: skeleton.metadata?.mode,
        messageCount: skeleton.metadata?.messageCount || 0,
        actionCount: skeleton.metadata?.actionCount || 0,
        totalSize: skeleton.metadata?.totalSize || 0,
        workspace: skeleton.metadata?.workspace,
        source: 'roo' as const,
      },
      truncatedInstruction: skeleton.truncatedInstruction,
      isCompleted: skeleton.isCompleted ?? false,
    };

    return this.applyOptions(toUnifiedTask(input), options);
  }

  private applyOptions(
    task: UnifiedTask,
    options?: ExtractionOptions,
  ): UnifiedTask {
    if (options?.machineId) {
      task.machineId = options.machineId;
    }
    if (options?.includeComputedFields) {
      task.storageTier = computeStorageTier(task);
    }
    return task;
  }
}
