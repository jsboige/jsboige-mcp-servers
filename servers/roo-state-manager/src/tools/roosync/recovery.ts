/**
 * Outil MCP : roosync_diagnose recovery extension
 *
 * Recovery-Before-Escalation decision endpoint (#1320 — claw-code pattern).
 * Workers and scheduler modes consult this BEFORE escalating a failure:
 * a known transient failure mode returns a matched auto-heal action
 * (rebuild_mcp / rebase_git / reset_submodule / retry_once); an unmatched
 * error returns no_match and the caller escalates immediately.
 *
 * The decision lives in HeartbeatService (single source of truth, in-memory
 * history). This module is the MCP-facing adapter, mirroring lifecycle.ts.
 *
 * @module tools/roosync/recovery
 * @version 1.0.0
 */

import { z } from 'zod';
import os from 'os';
import { getRooSyncService } from '../../services/lazy-roosync.js';

export const RECOVERY_ACTIONS = [
  'rebuild_mcp',
  'rebase_git',
  'reset_submodule',
  'retry_once',
] as const;

export const RecoveryArgsSchema = z.object({
  errorMessage: z.string().optional()
    .describe('Raw error message to classify. Present => attempt recovery match.'),
  outcomeAction: z.enum(RECOVERY_ACTIONS).optional()
    .describe('Report the outcome of an executed recovery action. Present => record outcome (requires success).'),
  success: z.boolean().optional()
    .describe('Whether the executed recovery action healed the failure (action: recovery, with outcomeAction).'),
  machineId: z.string().optional()
    .describe('Machine ID (default: hostname)'),
  limit: z.number().int().positive().optional()
    .describe('Max history entries to return (action: recovery, no errorMessage/outcomeAction)'),
});

export type RecoveryArgs = z.infer<typeof RecoveryArgsSchema>;

export const RecoveryResultSchema = z.object({
  success: z.boolean(),
  machineId: z.string().optional(),
  mode: z.enum(['matched', 'no_match', 'outcome_recorded', 'history']),
  timestamp: z.string(),
  /** Present when mode=matched: the auto-heal action to execute before escalating. */
  matchedAction: z.enum(RECOVERY_ACTIONS).optional(),
  description: z.string().optional(),
  /** Present when mode=history: recent recovery attempts. */
  history: z.array(z.any()).optional(),
  error: z.string().optional(),
});

export type RecoveryResult = z.infer<typeof RecoveryResultSchema>;

function getDefaultMachineId(): string {
  return os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

export async function reportRecovery(args: RecoveryArgs): Promise<RecoveryResult> {
  const machineId = (args.machineId || getDefaultMachineId()).toLowerCase();
  const timestamp = new Date().toISOString();

  try {
    const service = await getRooSyncService();
    const heartbeat = service.getHeartbeatService();

    if (args.errorMessage !== undefined) {
      const attempt = heartbeat.attemptRecovery(machineId, args.errorMessage);
      if (attempt === null) {
        return {
          success: true,
          machineId,
          mode: 'no_match',
          timestamp,
          description: 'No known recovery pattern matched — escalate to coordinator',
        };
      }
      return {
        success: true,
        machineId,
        mode: 'matched',
        timestamp,
        matchedAction: attempt.matchedAction,
        description: attempt.description,
      };
    }

    if (args.outcomeAction !== undefined) {
      heartbeat.recordRecoveryOutcome(machineId, args.outcomeAction, args.success === true);
      return {
        success: true,
        machineId,
        mode: 'outcome_recorded',
        timestamp,
        matchedAction: args.outcomeAction,
        description: args.success === true ? 'recovered' : 'failed',
      };
    }

    return {
      success: true,
      machineId,
      mode: 'history',
      timestamp,
      history: heartbeat.getRecoveryHistory(args.limit),
    };
  } catch (err) {
    return {
      success: false,
      machineId,
      mode: 'history',
      timestamp,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const recoveryToolMetadata = {
  name: 'roosync_recovery',
  description: 'Recovery-Before-Escalation decision endpoint (#1320). Pass errorMessage to classify a failure: a known transient pattern returns a matchedAction to auto-heal once (rebuild_mcp / rebase_git / reset_submodule / retry_once) BEFORE escalating; no match means escalate immediately. Pass outcomeAction+success to record the result of an executed recovery. No arguments returns recent recovery history. Callers execute the remediation themselves — this tool provides the decision, not the execution.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      errorMessage: {
        type: 'string' as const,
        description: 'Raw error message to classify (triggers a recovery match attempt)',
      },
      outcomeAction: {
        type: 'string' as const,
        enum: RECOVERY_ACTIONS,
        description: 'Recovery action whose execution outcome is being reported',
      },
      success: {
        type: 'boolean' as const,
        description: 'Whether the executed recovery action healed the failure',
      },
      machineId: {
        type: 'string' as const,
        description: 'Machine ID (default: hostname)',
      },
      limit: {
        type: 'number' as const,
        description: 'Max history entries to return',
      },
    },
  },
};
