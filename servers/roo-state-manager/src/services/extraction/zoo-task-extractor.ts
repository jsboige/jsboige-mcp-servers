/**
 * ZooTaskExtractor — Extracts UnifiedTasks from Zoo-Code storage
 *
 * @module services/extraction/zoo-task-extractor
 * @issue #2429
 *
 * Zoo-Code is a Roo/Cline fork with identical on-disk format.
 * This extractor delegates parsing to RooStorageDetector (format-identical)
 * but attributes tasks to source 'zoo-code' via ZooStorageDetector for
 * path detection and source attribution.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';
import { ZooStorageDetector } from '../../utils/zoo-storage-detector.js';
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

/** Zoo task_metadata.json format */
interface ZooTaskMetadata {
  messageCount: number;
  dataSource: string;
  lastActivity: string;
  workspace: string;
  actionCount: number;
  totalSize: number;
  createdAt: string;
}

/** Zoo history_item.json format */
interface ZooHistoryItem {
  number: number;
  task: string;
  id: string;
  ts: number;
}

export class ZooTaskExtractor implements TaskExtractor {
  readonly sourceName = 'zoo-code' as const;

  async isAvailable(): Promise<boolean> {
    try {
      const locations = await ZooStorageDetector.detectStorageLocations();
      return locations.length > 0;
    } catch {
      return false;
    }
  }

  async extractAll(options?: ExtractionOptions): Promise<ExtractionResult> {
    const errors: Array<{ taskId?: string; message: string }> = [];
    const tasks: UnifiedTask[] = [];

    try {
      const locations = await ZooStorageDetector.detectStorageLocations();

      for (const locationPath of locations) {
        const tasksDir = path.join(locationPath, 'tasks');
        let entries: string[];

        try {
          const dirents = await fs.readdir(tasksDir, { withFileTypes: true });
          entries = dirents
            .filter(d => d.isDirectory() && d.name !== '_index.json')
            .map(d => d.name);
        } catch {
          continue;
        }

        for (const taskId of entries) {
          try {
            const task = await this.extractSingleTask(taskId, tasksDir, options);
            if (task) tasks.push(task);
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
        message: `Zoo extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return { tasks, source: 'zoo-code', errors };
  }

  async extractById(
    taskId: string,
    options?: ExtractionOptions,
  ): Promise<UnifiedTask | null> {
    try {
      const locations = await ZooStorageDetector.detectStorageLocations();

      for (const locationPath of locations) {
        const taskDir = path.join(locationPath, 'tasks', taskId);
        try {
          const stat = await fs.stat(taskDir);
          if (stat.isDirectory()) {
            return await this.extractSingleTask(taskId, path.join(locationPath, 'tasks'), options);
          }
        } catch {
          continue;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extract a single Zoo task from its directory.
   *
   * Strategy: read task_metadata.json for core fields, then delegate
   * to RooStorageDetector.analyzeConversation for full ConversationSkeleton
   * parsing (format-identical). Falls back to metadata-only if analyzeConversation
   * fails (e.g. corrupted api_conversation_history).
   */
  private async extractSingleTask(
    taskId: string,
    tasksDir: string,
    options?: ExtractionOptions,
  ): Promise<UnifiedTask | null> {
    const taskDir = path.join(tasksDir, taskId);

    // Read task_metadata.json for core fields
    let metadata: ZooTaskMetadata;
    try {
      const raw = await fs.readFile(path.join(taskDir, 'task_metadata.json'), 'utf-8');
      metadata = JSON.parse(raw) as ZooTaskMetadata;
    } catch {
      // No metadata — skip this task
      return null;
    }

    // Try to get title from history_item.json (optional)
    let title: string | undefined;
    try {
      const raw = await fs.readFile(path.join(taskDir, 'history_item.json'), 'utf-8');
      const historyItem = JSON.parse(raw) as ZooHistoryItem;
      title = historyItem.task?.substring(0, 100) || undefined;
    } catch {
      // history_item.json is optional
    }

    // Normalize workspace: empty string → undefined
    const workspace = metadata.workspace && metadata.workspace.trim() !== ''
      ? metadata.workspace.replace(/\\/g, '/')
      : undefined;

    const input = {
      taskId,
      metadata: {
        title,
        lastActivity: metadata.lastActivity,
        createdAt: metadata.createdAt,
        messageCount: metadata.messageCount || 0,
        actionCount: metadata.actionCount || 0,
        totalSize: metadata.totalSize || 0,
        workspace,
        source: 'zoo-code' as const,
        machineId: os.hostname(),
      },
      isCompleted: false,
    };

    const task = toUnifiedTask(input);

    // Try enriching with RooStorageDetector (format-identical parsing)
    try {
      const skeleton = await RooStorageDetector.analyzeConversation(taskId, taskDir);
      if (skeleton) {
        // Override with richer data from skeleton if available
        if (skeleton.metadata?.title) {
          task.title = skeleton.metadata.title;
        }
        if (skeleton.truncatedInstruction) {
          task.instruction = skeleton.truncatedInstruction.length > 500
            ? skeleton.truncatedInstruction.slice(0, 500) + '...'
            : skeleton.truncatedInstruction;
        }
        if (skeleton.parentTaskId) {
          task.parentId = skeleton.parentTaskId;
        }
        if (skeleton.isCompleted) {
          task.status = 'completed';
          task.completedAt = skeleton.metadata?.lastActivity;
          task.outcome = 'success';
        }
      }
    } catch {
      // Skeleton enrichment failed — use metadata-only conversion
    }

    // Apply options
    if (options?.machineId) {
      task.machineId = options.machineId;
    }
    if (options?.includeComputedFields) {
      task.storageTier = computeStorageTier(task);
    }

    return task;
  }
}
