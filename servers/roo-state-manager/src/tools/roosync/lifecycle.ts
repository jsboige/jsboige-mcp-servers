/**
 * Outil MCP : roosync_inventory lifecycle extension
 *
 * Agent lifecycle state machine (#1320 — claw-code pattern).
 * Workers explicitly report their lifecycle transitions.
 * Combined with MachineStatus (derived): lifecycle = "what is the agent DOING?"
 *
 * @module tools/roosync/lifecycle
 * @version 1.0.0
 */

import { z } from 'zod';
import { getRooSyncService } from '../../services/lazy-roosync.js';
import { HeartbeatServiceError } from '../../services/roosync/HeartbeatService.js';
import type { AgentLifecycleState, LifecycleTransitionEvent } from '../../services/roosync/HeartbeatService.js';
import os from 'os';

export const AGENT_LIFECYCLE_STATES: AgentLifecycleState[] = [
  'BOOTSTRAPPING', 'READY', 'CLAIMED', 'WORKING', 'REPORTING', 'IDLE', 'ERROR', 'RECOVERING'
];

export const LifecycleArgsSchema = z.object({
  state: z.enum(AGENT_LIFECYCLE_STATES as unknown as [string, ...string[]])
    .describe('Target lifecycle state to transition to'),
  machineId: z.string().optional()
    .describe('Machine ID (default: hostname)'),
  reason: z.string().optional()
    .describe('Reason for the transition'),
});

export type LifecycleArgs = z.infer<typeof LifecycleArgsSchema>;

export const LifecycleResultSchema = z.object({
  success: z.boolean(),
  machineId: z.string(),
  fromState: z.string(),
  toState: z.string(),
  reason: z.string().optional(),
  timestamp: z.string(),
  error: z.string().optional(),
});

export type LifecycleResult = z.infer<typeof LifecycleResultSchema>;

function getDefaultMachineId(): string {
  return os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

export async function reportLifecycle(args: LifecycleArgs): Promise<LifecycleResult> {
  const { state, reason } = args;
  const machineId = (args.machineId || getDefaultMachineId()).toLowerCase();

  try {
    const service = await getRooSyncService();
    const heartbeatService = service.getHeartbeatService();

    const event: LifecycleTransitionEvent = heartbeatService.transitionLifecycle(
      machineId,
      state as AgentLifecycleState,
      reason
    );

    return {
      success: true,
      machineId: event.machineId,
      fromState: event.fromState,
      toState: event.toState,
      reason: event.reason,
      timestamp: event.timestamp,
    };
  } catch (err) {
    if (err instanceof HeartbeatServiceError) {
      return {
        success: false,
        machineId,
        fromState: '',
        toState: state,
        reason,
        timestamp: new Date().toISOString(),
        error: err.message,
      };
    }
    throw err;
  }
}

export const lifecycleToolMetadata = {
  name: 'roosync_report_lifecycle',
  description: 'Report agent lifecycle state transition (#1320). Workers use this to signal their current phase: BOOTSTRAPPING (starting up), READY (MCP confirmed), CLAIMED (task assigned), WORKING (active code changes), REPORTING (posting results), IDLE (waiting), ERROR (failed), RECOVERING (auto-healing). Transitions are validated against a state machine — invalid transitions return an error.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      state: {
        type: 'string' as const,
        enum: AGENT_LIFECYCLE_STATES,
        description: 'Target lifecycle state',
      },
      machineId: {
        type: 'string' as const,
        description: 'Machine ID (default: hostname)',
      },
      reason: {
        type: 'string' as const,
        description: 'Reason for the transition',
      },
    },
    required: ['state'] as const,
  },
};
