/**
 * ClaudeTaskExtractor — Extracts UnifiedTasks from Claude Code storage
 *
 * @module services/extraction/claude-task-extractor
 * @issue #1392 (#1360-2)
 *
 * Wraps ClaudeStorageDetector and converts ConversationSkeleton → UnifiedTask
 * via the toUnifiedTask() conversion helper from #1391.
 */

import * as os from 'os';
import { ClaudeStorageDetector } from '../../utils/claude-storage-detector.js';
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

export class ClaudeTaskExtractor implements TaskExtractor {
  readonly sourceName = 'claude-code' as const;

  async isAvailable(): Promise<boolean> {
    try {
      const locations = await ClaudeStorageDetector.detectStorageLocations();
      return locations.length > 0;
    } catch {
      return false;
    }
  }

  async extractAll(options?: ExtractionOptions): Promise<ExtractionResult> {
    const errors: Array<{ taskId?: string; message: string }> = [];
    const tasks: UnifiedTask[] = [];

    try {
      const locations = await ClaudeStorageDetector.detectStorageLocations();

      for (const location of locations) {
        const projects = await ClaudeStorageDetector.listProjects(location.path);

        for (const projectName of projects) {
          const taskId = `claude-${projectName}`;
          const projectPath = location.projectPath;

          try {
            const skeleton = await ClaudeStorageDetector.analyzeConversation(
              taskId,
              projectPath,
            );

            if (skeleton) {
              const task = this.skeletonToTask(skeleton, options);
              if (task) tasks.push(this.applyOptions(task, options));
            }
          } catch (err) {
            errors.push({
              taskId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch (err) {
      errors.push({
        message: `Claude extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return { tasks, source: 'claude-code', errors };
  }

  async extractById(
    taskId: string,
    options?: ExtractionOptions,
  ): Promise<UnifiedTask | null> {
    try {
      const skeleton = await ClaudeStorageDetector.findConversationById(taskId);
      if (!skeleton) return null;

      const task = this.skeletonToTask(skeleton, options);
      if (!task) return null;
      return this.applyOptions(task, options);
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
      metadata: {
        title: skeleton.metadata?.title,
        lastActivity: skeleton.metadata?.lastActivity || new Date().toISOString(),
        createdAt: skeleton.metadata?.createdAt || new Date().toISOString(),
        messageCount: skeleton.metadata?.messageCount || 0,
        actionCount: skeleton.metadata?.actionCount || 0,
        totalSize: skeleton.metadata?.totalSize || 0,
        workspace: skeleton.metadata?.workspace,
        machineId: skeleton.metadata?.machineId || os.hostname(),
        source: 'claude-code' as const,
      },
      isCompleted: false,
    };

    return toUnifiedTask(input);
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
