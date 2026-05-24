/**
 * Service de Heartbeat pour RooSync
 *
 * ADR 008: Passive activity derivation — every MCP tool call IS the heartbeat.
 * No disk I/O, no background intervals, no GDrive writes.
 *
 * Status model: ONLINE (<30min), IDLE (30-120min), UNKNOWN (>120min)
 * No OFFLINE status — true machine failure detected by external tools.
 *
 * @module HeartbeatService
 * @version 4.0.0 (ADR 008 Phase 2)
 */

import { createLogger } from '../../utils/logger.js';

const logger = createLogger('HeartbeatService');

// Status thresholds (ADR 008)
const ONLINE_THRESHOLD = 30 * 60 * 1000;  // 30 min
const IDLE_THRESHOLD = 120 * 60 * 1000;   // 120 min

export type MachineStatus = 'online' | 'idle' | 'unknown';

/**
 * Agent lifecycle states (#1320 — claw-code pattern: state machine first).
 *
 * Workers explicitly report transitions. Status is NOT derived from timestamps.
 * Combined with MachineStatus: MachineStatus = "is the MCP process alive?",
 * AgentLifecycleState = "what is the agent DOING?"
 *
 * Valid transitions:
 *   BOOTSTRAPPING → READY → CLAIMED → WORKING → REPORTING → IDLE
 *   Any state → ERROR → RECOVERING → READY
 *   IDLE → CLAIMED (new task)
 *   BOOTSTRAPPING → ERROR (startup failed)
 */
export type AgentLifecycleState =
  | 'BOOTSTRAPPING'  // Process started, MCP/tools not yet confirmed
  | 'READY'          // MCP confirmed, awaiting dispatch
  | 'CLAIMED'        // Task assigned, investigation starting
  | 'WORKING'        // Active code changes / implementation
  | 'REPORTING'      // Posting [DONE] to dashboard
  | 'IDLE'           // No tasks in queue, waiting
  | 'ERROR'          // Failure detected
  | 'RECOVERING';    // Auto-healing (rebuild MCP, rebase git, etc.)

const VALID_TRANSITIONS: Record<AgentLifecycleState, AgentLifecycleState[]> = {
  BOOTSTRAPPING: ['READY', 'ERROR'],
  READY: ['CLAIMED', 'IDLE', 'ERROR'],
  CLAIMED: ['WORKING', 'IDLE', 'ERROR'],
  WORKING: ['REPORTING', 'IDLE', 'ERROR'],
  REPORTING: ['IDLE', 'ERROR'],
  IDLE: ['CLAIMED', 'READY', 'ERROR'],
  ERROR: ['RECOVERING', 'IDLE'],
  RECOVERING: ['READY', 'ERROR'],
};

export interface LifecycleTransitionEvent {
  machineId: string;
  fromState: AgentLifecycleState;
  toState: AgentLifecycleState;
  reason?: string;
  timestamp: string;
}

export interface HeartbeatConfig {
  // ADR 008 Phase 2: All config properties removed (no disk I/O, no background intervals).
  // Interface kept empty for forward compat with callers that pass config objects.
}

export interface SchedulerMetrics {
  totalRuns: number;
  successCount: number;
  failureCount: number;
  lastRunAt?: string;
  lastRunDurationMs?: number;
  lastRunStatus?: 'success' | 'failure';
  lastError?: string;
}

export interface HeartbeatData {
  machineId: string;
  lastHeartbeat: string;
  status: MachineStatus;
  lifecycleState?: AgentLifecycleState;
  metadata: {
    firstSeen: string;
    lastUpdated: string;
    scheduler?: SchedulerMetrics;
    lifecycleSince?: string;
    lifecycleReason?: string;
  };
}

export interface HeartbeatServiceState {
  heartbeats: Map<string, HeartbeatData>;
  onlineMachines: string[];
  idleMachines: string[];
  unknownMachines: string[];
  statistics: {
    totalMachines: number;
    onlineCount: number;
    idleCount: number;
    unknownCount: number;
    lastHeartbeatCheck: string;
  };
}

export interface HeartbeatCheckResult {
  success: boolean;
  newlyUnknownMachines: string[];
  newlyOnlineMachines: string[];
  newlyIdleMachines: string[];
  checkedAt: string;
}

export class HeartbeatServiceError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(`[HeartbeatService] ${message}`);
    this.name = 'HeartbeatServiceError';
  }
}

/**
 * Recovery-Before-Escalation (#1320 Pattern 3).
 *
 * Known failure modes with auto-heal actions. Each entry defines:
 * - pattern: regex to match against the error message
 * - action: what the recovery handler should do
 * - description: human-readable label for logging
 */
export interface RecoveryAction {
  pattern: RegExp;
  action: 'rebuild_mcp' | 'rebase_git' | 'reset_submodule' | 'retry_once';
  description: string;
}

const DEFAULT_RECOVERY_ACTIONS: RecoveryAction[] = [
  { pattern: /ENOENT.*roo-state-manager/i, action: 'rebuild_mcp', description: 'MCP build artifacts missing — rebuild required' },
  { pattern: /upload-pack: not our ref/i, action: 'reset_submodule', description: 'Phantom submodule pointer — reset to origin/main' },
  { pattern: /CONFLICT.*Merge conflict/i, action: 'rebase_git', description: 'Merge conflict — rebase from main' },
  { pattern: /EBUSY.*\.node/i, action: 'retry_once', description: 'Windows file lock — transient, retry once' },
  { pattern: /rate.limit|429|too many requests/i, action: 'retry_once', description: 'Rate limited — transient, retry once' },
  { pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT/i, action: 'retry_once', description: 'Network transient — retry once' },
];

export interface RecoveryAttempt {
  machineId: string;
  errorSignature: string;
  matchedAction: RecoveryAction['action'];
  description: string;
  timestamp: string;
  result: 'matched' | 'no_match' | 'recovered' | 'failed';
}

/**
 * HeartbeatService — ADR 008 in-memory passive model
 *
 * No disk I/O. No background intervals. State lives in process memory.
 * Server restart → all machines start UNKNOWN → first tool call → ONLINE.
 */
export class HeartbeatService {
  private state: HeartbeatServiceState;
  private config: HeartbeatConfig;
  private onStatusChangeCallback?: (machineId: string, oldStatus: MachineStatus, newStatus: MachineStatus) => void;
  private onLifecycleChangeCallback?: (event: LifecycleTransitionEvent) => void;
  private lifecycleHistory: LifecycleTransitionEvent[] = [];
  private static MAX_HISTORY = 100;
  private recoveryActions: RecoveryAction[];
  private recoveryHistory: RecoveryAttempt[] = [];
  private static MAX_RECOVERY_HISTORY = 50;

  constructor(
    _sharedPath?: string,
    config?: Partial<HeartbeatConfig>
  ) {
    this.config = { ...config };
    this.recoveryActions = [...DEFAULT_RECOVERY_ACTIONS];
    this.state = {
      heartbeats: new Map(),
      onlineMachines: [],
      idleMachines: [],
      unknownMachines: [],
      statistics: {
        totalMachines: 0,
        onlineCount: 0,
        idleCount: 0,
        unknownCount: 0,
        lastHeartbeatCheck: new Date().toISOString()
      }
    };
    logger.info('HeartbeatService v4.0 initialized (ADR 008 in-memory model)');
  }

  /**
   * Register activity for a machine (called by auto-heartbeat hook on every tool call)
   */
  public async registerHeartbeat(
    machineId: string,
    _metadata?: Record<string, unknown>
  ): Promise<void> {
    machineId = machineId.toLowerCase();
    const now = new Date().toISOString();

    let data = this.state.heartbeats.get(machineId);
    const previousStatus = data?.status;

    if (!data) {
      data = {
        machineId,
        lastHeartbeat: now,
        status: 'online',
        metadata: { firstSeen: now, lastUpdated: now }
      };
      logger.info(`New machine registered: ${machineId}`);
    } else {
      data.lastHeartbeat = now;
      data.status = 'online';
      data.metadata.lastUpdated = now;
    }

    this.state.heartbeats.set(machineId, data);
    this.updateMachineStatus();

    if (previousStatus && previousStatus !== 'online' && this.onStatusChangeCallback) {
      this.onStatusChangeCallback(machineId, previousStatus, 'online');
    }
  }

  /**
   * Transition a machine's lifecycle state (#1320).
   *
   * Validates the transition against VALID_TRANSITIONS.
   * Auto-registers the machine if not yet known (initial state = BOOTSTRAPPING).
   *
   * @returns The transition event, or throws HeartbeatServiceError on invalid transition.
   */
  public transitionLifecycle(
    machineId: string,
    newState: AgentLifecycleState,
    reason?: string
  ): LifecycleTransitionEvent {
    machineId = machineId.toLowerCase();
    const now = new Date().toISOString();

    let data = this.state.heartbeats.get(machineId);
    if (!data) {
      // Auto-register with BOOTSTRAPPING as initial state
      data = {
        machineId,
        lastHeartbeat: now,
        status: 'online',
        lifecycleState: 'BOOTSTRAPPING',
        metadata: { firstSeen: now, lastUpdated: now, lifecycleSince: now }
      };
      this.state.heartbeats.set(machineId, data);
      this.updateMachineStatus();
    }

    const currentState = data.lifecycleState || 'BOOTSTRAPPING';

    if (currentState === newState) {
      logger.debug(`Lifecycle no-op: ${machineId} already ${newState}`);
      return { machineId, fromState: currentState, toState: newState, reason, timestamp: now };
    }

    const allowed = VALID_TRANSITIONS[currentState];
    if (!allowed || !allowed.includes(newState)) {
      const msg = `Invalid lifecycle transition: ${machineId} ${currentState} → ${newState} (allowed: ${allowed?.join(', ') || 'none'})`;
      logger.warn(msg);
      throw new HeartbeatServiceError(msg, 'INVALID_TRANSITION');
    }

    const event: LifecycleTransitionEvent = {
      machineId,
      fromState: currentState,
      toState: newState,
      reason,
      timestamp: now,
    };

    data.lifecycleState = newState;
    data.metadata.lifecycleSince = now;
    data.metadata.lifecycleReason = reason;
    data.metadata.lastUpdated = now;
    this.state.heartbeats.set(machineId, data);

    // Record history (bounded)
    this.lifecycleHistory.push(event);
    if (this.lifecycleHistory.length > HeartbeatService.MAX_HISTORY) {
      this.lifecycleHistory = this.lifecycleHistory.slice(-HeartbeatService.MAX_HISTORY);
    }

    logger.info(`Lifecycle: ${machineId} ${currentState} → ${newState}${reason ? ` (${reason})` : ''}`);

    if (this.onLifecycleChangeCallback) {
      this.onLifecycleChangeCallback(event);
    }

    return event;
  }

  /**
   * Get the current lifecycle state for a machine.
   */
  public getLifecycleState(machineId: string): AgentLifecycleState | undefined {
    const data = this.state.heartbeats.get(machineId.toLowerCase());
    return data?.lifecycleState;
  }

  /**
   * Get recent lifecycle transition history.
   */
  public getLifecycleHistory(limit?: number): LifecycleTransitionEvent[] {
    const events = limit ? this.lifecycleHistory.slice(-limit) : this.lifecycleHistory;
    return [...events];
  }

  /**
   * Set callback for lifecycle state changes.
   */
  public onLifecycleChange(callback: (event: LifecycleTransitionEvent) => void): void {
    this.onLifecycleChangeCallback = callback;
  }

  // --- Recovery-Before-Escalation (#1320 Pattern 3) ---

  /**
   * Attempt automatic recovery for a known failure pattern.
   *
   * Matches the error message against registered recovery actions.
   * If matched, transitions the machine to ERROR then RECOVERING,
   * logs the recovery attempt, and returns the action to take.
   *
   * The caller (worker script or MCP tool) is responsible for executing
   * the actual remediation — this method provides the decision, not the execution.
   */
  public attemptRecovery(machineId: string, errorMessage: string): RecoveryAttempt | null {
    machineId = machineId.toLowerCase();
    const now = new Date().toISOString();

    for (const action of this.recoveryActions) {
      if (action.pattern.test(errorMessage)) {
        const attempt: RecoveryAttempt = {
          machineId,
          errorSignature: errorMessage.slice(0, 200),
          matchedAction: action.action,
          description: action.description,
          timestamp: now,
          result: 'matched',
        };

        // Record history (bounded)
        this.recoveryHistory.push(attempt);
        if (this.recoveryHistory.length > HeartbeatService.MAX_RECOVERY_HISTORY) {
          this.recoveryHistory = this.recoveryHistory.slice(-HeartbeatService.MAX_RECOVERY_HISTORY);
        }

        logger.info(`Recovery matched: ${machineId} → ${action.action} (${action.description})`);
        return attempt;
      }
    }

    logger.debug(`No recovery match for ${machineId}: ${errorMessage.slice(0, 100)}`);
    return null;
  }

  /**
   * Mark a recovery attempt as succeeded or failed.
   */
  public recordRecoveryOutcome(machineId: string, action: RecoveryAction['action'], success: boolean): void {
    const last = [...this.recoveryHistory].reverse().find((a: RecoveryAttempt) => a.machineId === machineId.toLowerCase() && a.matchedAction === action);
    if (last) {
      last.result = success ? 'recovered' : 'failed';
    }
    logger.info(`Recovery outcome: ${machineId} ${action} → ${success ? 'recovered' : 'failed'}`);
  }

  /**
   * Get recent recovery attempts.
   */
  public getRecoveryHistory(limit?: number): RecoveryAttempt[] {
    const events = limit ? this.recoveryHistory.slice(-limit) : this.recoveryHistory;
    return [...events];
  }

  /**
   * Register a custom recovery action.
   */
  public addRecoveryAction(action: RecoveryAction): void {
    this.recoveryActions.push(action);
  }

  /**
   * Get all registered recovery actions.
   */
  public getRecoveryActions(): RecoveryAction[] {
    return [...this.recoveryActions];
  }

  /**
   * Derive status for all machines based on last activity timestamps
   */
  public async checkHeartbeats(): Promise<HeartbeatCheckResult> {
    const now = Date.now();
    const result: HeartbeatCheckResult = {
      success: true,
      newlyUnknownMachines: [],
      newlyOnlineMachines: [],
      newlyIdleMachines: [],
      checkedAt: new Date().toISOString()
    };

    for (const [machineId, data] of this.state.heartbeats.entries()) {
      const lastActivity = new Date(data.lastHeartbeat).getTime();
      const elapsed = now - lastActivity;
      const previousStatus = data.status;

      let newStatus: MachineStatus;
      if (elapsed > IDLE_THRESHOLD) {
        newStatus = 'unknown';
      } else if (elapsed > ONLINE_THRESHOLD) {
        newStatus = 'idle';
      } else {
        newStatus = 'online';
      }

      if (previousStatus !== newStatus) {
        data.status = newStatus;
        data.metadata.lastUpdated = new Date().toISOString();

        if (newStatus === 'unknown') result.newlyUnknownMachines.push(machineId);
        else if (newStatus === 'idle') result.newlyIdleMachines.push(machineId);
        else result.newlyOnlineMachines.push(machineId);

        logger.info(`Status ${previousStatus} → ${newStatus}: ${machineId}`, { elapsedMs: elapsed });

        if (this.onStatusChangeCallback) {
          this.onStatusChangeCallback(machineId, previousStatus, newStatus);
        }
      }

      this.state.heartbeats.set(machineId, data);
    }

    this.updateMachineStatus();
    this.state.statistics.lastHeartbeatCheck = new Date().toISOString();
    return result;
  }

  /**
   * Record a scheduler run outcome for a machine (#1442)
   *
   * In-memory only. Called by tools that observe scheduler activity
   * (e.g. dashboard intercom parsing, inventory collection).
   */
  public recordSchedulerRun(
    machineId: string,
    outcome: { success: boolean; durationMs?: number; error?: string }
  ): void {
    machineId = machineId.toLowerCase();
    const now = new Date().toISOString();

    let data = this.state.heartbeats.get(machineId);
    if (!data) {
      // Auto-register machine if not yet known
      data = {
        machineId,
        lastHeartbeat: now,
        status: 'online',
        metadata: { firstSeen: now, lastUpdated: now }
      };
      this.state.heartbeats.set(machineId, data);
      this.updateMachineStatus();
    }

    const sched: SchedulerMetrics = data.metadata.scheduler ?? {
      totalRuns: 0,
      successCount: 0,
      failureCount: 0
    };

    sched.totalRuns++;
    if (outcome.success) {
      sched.successCount++;
    } else {
      sched.failureCount++;
    }
    sched.lastRunAt = now;
    sched.lastRunDurationMs = outcome.durationMs;
    sched.lastRunStatus = outcome.success ? 'success' : 'failure';
    sched.lastError = outcome.success ? undefined : outcome.error;

    data.metadata.scheduler = sched;
    data.metadata.lastUpdated = now;
    logger.debug(`Scheduler run recorded: ${machineId} → ${outcome.success ? 'ok' : 'fail'}`);
  }

  /**
   * Get scheduler metrics for a specific machine (#1442)
   */
  public getSchedulerMetrics(machineId: string): SchedulerMetrics | undefined {
    const data = this.state.heartbeats.get(machineId.toLowerCase());
    return data?.metadata.scheduler;
  }

  /**
   * Get scheduler metrics for all machines (#1442)
   */
  public getAllSchedulerMetrics(): Map<string, SchedulerMetrics> {
    const result = new Map<string, SchedulerMetrics>();
    for (const [machineId, data] of this.state.heartbeats.entries()) {
      if (data.metadata.scheduler) {
        result.set(machineId, data.metadata.scheduler);
      }
    }
    return result;
  }

  /**
   * Set callback for status changes
   */
  public onStatusChange(callback: (machineId: string, oldStatus: MachineStatus, newStatus: MachineStatus) => void): void {
    this.onStatusChangeCallback = callback;
  }

  // --- Query methods ---

  public getHeartbeatData(machineId: string): HeartbeatData | undefined {
    return this.state.heartbeats.get(machineId.toLowerCase());
  }

  /**
   * LOCAL-SELF ONLY: Returns machines that have called this MCP process.
   * Does NOT reflect cross-machine activity. Use dashboard-derived presence
   * (crossCheckWithDashboard) for reliable cross-machine status. (#2318)
   */
  public getOnlineMachines(): string[] {
    return [...this.state.onlineMachines];
  }

  /**
   * @deprecated #2318 — Returns machines not seen in THIS process. Misleading
   * for cross-machine use (other machines are always "unknown"). Use
   * dashboard-derived presence via crossCheckWithDashboard() instead.
   */
  public getUnknownMachines(): string[] {
    return [...this.state.unknownMachines];
  }

  /**
   * @deprecated #2318 — Returns machines idle in THIS process. Misleading
   * for cross-machine use. Use dashboard-derived presence instead.
   */
  public getIdleMachines(): string[] {
    return [...this.state.idleMachines];
  }

  /**
   * LOCAL-SELF ONLY: Full heartbeat state snapshot.
   * The onlineMachines/unknownMachines/idleMachines arrays reflect only
   * the local MCP process activity. Not suitable for cross-machine presence. (#2318)
   */
  public getState(): HeartbeatServiceState {
    return {
      heartbeats: new Map(this.state.heartbeats),
      onlineMachines: [...this.state.onlineMachines],
      idleMachines: [...this.state.idleMachines],
      unknownMachines: [...this.state.unknownMachines],
      statistics: { ...this.state.statistics }
    };
  }

  public async removeMachine(machineId: string): Promise<void> {
    this.state.heartbeats.delete(machineId.toLowerCase());
    this.updateMachineStatus();
    logger.info(`Machine removed: ${machineId}`);
  }

  // --- No-op backward compat methods (callers still reference these) ---

  /** No-op in ADR 008. Sets up status change callback if provided. */
  public async startHeartbeatService(
    _machineId: string,
    onUnknownDetected?: (machineId: string) => void,
    onOnlineRestored?: (machineId: string) => void
  ): Promise<void> {
    if (onUnknownDetected || onOnlineRestored) {
      this.onStatusChangeCallback = (machineId, oldStatus, newStatus) => {
        if (newStatus === 'unknown' && onUnknownDetected) onUnknownDetected(machineId);
        if (newStatus === 'online' && onOnlineRestored) onOnlineRestored(machineId);
      };
    }
  }

  /** No-op in ADR 008. */
  public async stopHeartbeatService(): Promise<void> {}

  /** No-op in ADR 008. */
  public async updateConfig(_config: Partial<HeartbeatConfig>): Promise<void> {}

  /** No-op in ADR 008. */
  public reloadFromDisk(): void {}

  /** No-op in ADR 008. In-memory only, no cleanup needed. */
  public async cleanupOldUnknownMachines(_maxAge?: number): Promise<number> {
    return 0;
  }

  // --- Internal ---

  private updateMachineStatus(): void {
    const online: string[] = [];
    const idle: string[] = [];
    const unknown: string[] = [];

    for (const [machineId, data] of this.state.heartbeats.entries()) {
      switch (data.status) {
        case 'online': online.push(machineId); break;
        case 'idle': idle.push(machineId); break;
        case 'unknown': unknown.push(machineId); break;
      }
    }

    this.state.onlineMachines = online;
    this.state.idleMachines = idle;
    this.state.unknownMachines = unknown;

    this.state.statistics.totalMachines = this.state.heartbeats.size;
    this.state.statistics.onlineCount = online.length;
    this.state.statistics.idleCount = idle.length;
    this.state.statistics.unknownCount = unknown.length;
  }
}
