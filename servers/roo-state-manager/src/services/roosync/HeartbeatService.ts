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

export interface HeartbeatConfig {
  /** @deprecated No longer used — kept for backward compat in tool schemas */
  heartbeatInterval?: number;
  /** @deprecated No longer used — kept for backward compat in tool schemas */
  offlineTimeout?: number;
  /** @deprecated No longer used */
  missedHeartbeatThreshold?: number;
  /** @deprecated No longer used — no disk writes */
  autoSyncEnabled?: boolean;
  /** @deprecated No longer used — no disk writes */
  autoSyncInterval?: number;
  /** @deprecated No longer used — no disk writes */
  persistenceInterval?: number;
}

export interface HeartbeatData {
  machineId: string;
  lastHeartbeat: string;
  status: MachineStatus;
  metadata: {
    firstSeen: string;
    lastUpdated: string;
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
 * HeartbeatService — ADR 008 in-memory passive model
 *
 * No disk I/O. No background intervals. State lives in process memory.
 * Server restart → all machines start UNKNOWN → first tool call → ONLINE.
 */
export class HeartbeatService {
  private state: HeartbeatServiceState;
  private config: HeartbeatConfig;
  private onStatusChangeCallback?: (machineId: string, oldStatus: MachineStatus, newStatus: MachineStatus) => void;

  constructor(
    _sharedPath?: string,
    config?: Partial<HeartbeatConfig>
  ) {
    this.config = { ...config };
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
   * Set callback for status changes
   */
  public onStatusChange(callback: (machineId: string, oldStatus: MachineStatus, newStatus: MachineStatus) => void): void {
    this.onStatusChangeCallback = callback;
  }

  // --- Query methods ---

  public getHeartbeatData(machineId: string): HeartbeatData | undefined {
    return this.state.heartbeats.get(machineId.toLowerCase());
  }

  public getOnlineMachines(): string[] {
    return [...this.state.onlineMachines];
  }

  /** @deprecated Use getUnknownMachines() — ADR 008 Phase 2 */
  public getOfflineMachines(): string[] {
    return this.getUnknownMachines();
  }

  public getUnknownMachines(): string[] {
    return [...this.state.unknownMachines];
  }

  /** @deprecated Use getIdleMachines() — ADR 008 Phase 2 */
  public getWarningMachines(): string[] {
    return this.getIdleMachines();
  }

  public getIdleMachines(): string[] {
    return [...this.state.idleMachines];
  }

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

  // --- Backward compat methods (no-ops or redirects for ADR 008 Phase 2) ---

  /**
   * @deprecated No-op in ADR 008. Background service no longer needed.
   * Kept for backward compat with callers (background-services.ts, heartbeat-service tool).
   */
  public async startHeartbeatService(
    _machineId: string,
    onOfflineDetected?: (machineId: string) => void,
    onOnlineRestored?: (machineId: string) => void
  ): Promise<void> {
    logger.info('startHeartbeatService called — no-op (ADR 008 passive model)');
    // Set up status change callback if callers provide offline/online callbacks
    if (onOfflineDetected || onOnlineRestored) {
      this.onStatusChangeCallback = (machineId, oldStatus, newStatus) => {
        if (newStatus === 'unknown' && onOfflineDetected) onOfflineDetected(machineId);
        if (newStatus === 'online' && onOnlineRestored) onOnlineRestored(machineId);
      };
    }
  }

  /**
   * @deprecated No-op in ADR 008. No background interval to stop.
   */
  public async stopHeartbeatService(): Promise<void> {
    logger.info('stopHeartbeatService called — no-op (ADR 008 passive model)');
  }

  /**
   * @deprecated No-op in ADR 008.
   */
  public async updateConfig(_config: Partial<HeartbeatConfig>): Promise<void> {
    logger.info('updateConfig called — no-op (ADR 008 passive model)');
  }

  /**
   * @deprecated No disk state to reload.
   */
  public reloadFromDisk(): void {
    // No-op: ADR 008 in-memory only
  }

  /**
   * @deprecated No disk state to clean up. ADR 008: in-memory only.
   */
  public async cleanupOldUnknownMachines(_maxAge?: number): Promise<number> {
    return 0;
  }

  /** @deprecated Use cleanupOldUnknownMachines — ADR 008 terminology */
  public async cleanupOldOfflineMachines(maxAge?: number): Promise<number> {
    return this.cleanupOldUnknownMachines(maxAge);
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
