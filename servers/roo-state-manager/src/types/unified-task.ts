/**
 * UnifiedTask — Schema unifié pour les tâches Roo et Claude Code
 *
 * @module types/unified-task
 * @issue #1391 (#1360-1), #2429 (zoo-code source)
 * @version 1.1.0
 *
 * Représente une tâche (conversation/session) de N'IMPORTE QUELLE source
 * (Roo Code, Zoo-Code, ou Claude Code) dans un format commun, permettant la recherche
 * cross-source, le reporting unifié et le stockage partagé.
 */

import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

export const TaskSource = z.enum(['roo', 'claude-code', 'zoo-code']);
export type TaskSource = z.infer<typeof TaskSource>;

export const TaskStatus = z.enum(['active', 'completed', 'abandoned', 'stuck', 'unknown']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskOutcome = z.enum(['success', 'failure', 'partial', 'cancelled']);
export type TaskOutcome = z.infer<typeof TaskOutcome>;

export const StorageTier = z.enum(['hot', 'warm', 'cold']);
export type StorageTier = z.infer<typeof StorageTier>;

// ─── Core Schema (Zod) ────────────────────────────────────────────────────────

export const UnifiedTaskSchema = z.object({
  id: z.string().describe('Unique task identifier (taskId from source system)'),

  source: TaskSource.describe('Origin system: Roo Code, Zoo-Code, or Claude Code'),

  parentId: z.string().optional().describe('Parent task ID for sub-task relationships'),

  rootId: z.string().optional().describe('Root task ID in the task hierarchy'),

  // Identity
  title: z.string().optional().describe('Human-readable task title'),
  instruction: z.string().optional().describe('Original task prompt/instruction'),

  // Temporal
  createdAt: z.string().datetime({ offset: true }).describe('ISO 8601 creation timestamp'),
  lastActivity: z.string().datetime({ offset: true }).describe('ISO 8601 last activity timestamp'),
  completedAt: z.string().datetime({ offset: true }).optional().describe('ISO 8601 completion timestamp'),

  // Metrics
  messageCount: z.number().int().min(0).describe('Total message count'),
  actionCount: z.number().int().min(0).describe('Total tool/action count'),
  totalSizeBytes: z.number().int().min(0).describe('Total conversation size in bytes'),

  // Context
  workspace: z.string().optional().describe('Workspace path or identifier'),
  machineId: z.string().optional().describe('Machine where the task ran'),
  mode: z.string().optional().describe('Roo mode or Claude agent type used'),
  model: z.string().optional().describe('LLM model identifier'),

  // Status
  status: TaskStatus.describe('Current task lifecycle status'),
  outcome: TaskOutcome.optional().describe('Task outcome (set when status=completed|abandoned)'),

  // Storage (#1393 hot/warm/cold)
  storageTier: StorageTier.optional().describe('Storage tier for retention policy'),

  // Indexing
  indexedAt: z.string().datetime({ offset: true }).optional().describe('Last Qdrant indexing timestamp'),

  // Source-specific fields that don't map to unified schema
  sourceMetadata: z.record(z.unknown()).optional().describe('Opaque source-specific metadata'),
});

export type UnifiedTask = z.infer<typeof UnifiedTaskSchema>;

// ─── Conversion helpers ───────────────────────────────────────────────────────

/**
 * Common fields shared by SkeletonHeader and ConversationSummary.
 * Used as input for conversion functions.
 */
interface SourceTaskLike {
  taskId: string;
  parentTaskId?: string;
  metadata: {
    title?: string;
    lastActivity: string;
    createdAt: string;
    mode?: string;
    messageCount: number;
    actionCount?: number;
    totalSize?: number;
    workspace?: string;
    machineId?: string;
    qdrantIndexedAt?: string;
    source?: 'roo' | 'claude-code' | 'zoo-code';
    parentTaskId?: string;
  };
  truncatedInstruction?: string;
  isCompleted?: boolean;
}

/**
 * Convert a SkeletonHeader/ConversationSummary to UnifiedTask.
 */
export function toUnifiedTask(input: SourceTaskLike): UnifiedTask {
  const source: TaskSource = input.metadata.source ?? 'roo';
  const instruction = input.truncatedInstruction;

  let status: TaskStatus = 'unknown';
  let outcome: TaskOutcome | undefined;
  let completedAt: string | undefined;

  if (input.isCompleted === true) {
    status = 'completed';
    outcome = 'success'; // Default assumption; can be overridden
    completedAt = input.metadata.lastActivity;
  } else {
    const lastActivity = new Date(input.metadata.lastActivity);
    const staleThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days
    if (Date.now() - lastActivity.getTime() > staleThreshold) {
      status = 'stuck';
    } else {
      status = 'active';
    }
  }

  return {
    id: input.taskId,
    source,
    parentId: input.parentTaskId ?? input.metadata.parentTaskId,
    rootId: undefined, // Not available in skeleton; populated later via hierarchy
    title: input.metadata.title,
    instruction: instruction ? (instruction.length > 500 ? instruction.slice(0, 500) + '...' : instruction) : undefined,
    createdAt: input.metadata.createdAt,
    lastActivity: input.metadata.lastActivity,
    completedAt,
    messageCount: input.metadata.messageCount,
    actionCount: input.metadata.actionCount ?? 0,
    totalSizeBytes: input.metadata.totalSize ?? 0,
    workspace: input.metadata.workspace,
    machineId: input.metadata.machineId,
    mode: input.metadata.mode,
    status,
    outcome,
    indexedAt: input.metadata.qdrantIndexedAt,
  };
}

/**
 * Determine storage tier based on age and activity.
 */
export function computeStorageTier(task: UnifiedTask): StorageTier {
  const age = Date.now() - new Date(task.lastActivity).getTime();
  const days = age / (24 * 60 * 60 * 1000);

  if (days <= 7) return 'hot';
  if (days <= 90) return 'warm';
  return 'cold';
}

/**
 * Validate and parse a UnifiedTask from unknown input.
 */
export function parseUnifiedTask(data: unknown): UnifiedTask {
  return UnifiedTaskSchema.parse(data);
}

/**
 * Safe parse that returns a result object instead of throwing.
 */
export function safeParseUnifiedTask(data: unknown): { success: true; data: UnifiedTask } | { success: false; errors: z.ZodError } {
  const result = UnifiedTaskSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: result.error };
}
