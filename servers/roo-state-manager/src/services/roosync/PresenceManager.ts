/**
 * Gestionnaire de présence pour RooSync — #2121 Phase 2.1
 *
 * Dashboard-derived presence model. No disk I/O — delegates to HeartbeatService
 * for in-memory status tracking. GDrive writes to presence/{machineId}.json
 * eliminated; reads mapped from HeartbeatService in-memory state.
 *
 * @module PresenceManager
 * @version 3.0.0 (#2121 Phase 2.1: dashboard-derived presence)
 */

import { createLogger } from '../../utils/logger.js';
import { RooSyncConfig } from '../../config/roosync-config.js';
import type { HeartbeatService } from './HeartbeatService.js';

const logger = createLogger('PresenceManager');

/**
 * Interface pour les données de présence
 */
export interface PresenceData {
  id: string;
  status: 'online' | 'idle' | 'unknown' | 'offline' | 'conflict';
  lastSeen: string;
  version: string;
  mode: string;
  source?: string;
  firstSeen?: string;
}

/**
 * Résultat de mise à jour de présence
 */
export interface PresenceUpdateResult {
  success: boolean;
  conflictDetected?: boolean;
  warningMessage?: string;
  existingData?: PresenceData;
}

/**
 * Erreur du gestionnaire de présence
 */
export class PresenceManagerError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(`[PresenceManager] ${message}`);
    this.name = 'PresenceManagerError';
  }
}

/**
 * Gestionnaire de présence — dashboard-derived, no disk I/O
 *
 * Delegates all presence state to HeartbeatService (in-memory Map).
 * Backward-compatible API preserved for callers.
 */
export class PresenceManager {
  constructor(
    private config: RooSyncConfig,
    private heartbeatService: HeartbeatService
  ) {}

  /**
   * Map HeartbeatService status to PresenceData status
   */
  // #2121 Phase 2: Align with ADR 008 — no 'offline' status, only online/idle/unknown.
  private mapStatus(s: 'online' | 'idle' | 'unknown'): PresenceData['status'] {
    if (s === 'online') return 'online';
    if (s === 'idle') return 'idle';
    return 'unknown';
  }

  /**
   * Lire les données de présence d'une machine — from HeartbeatService in-memory
   */
  public async readPresence(machineId: string): Promise<PresenceData | null> {
    const data = this.heartbeatService.getHeartbeatData(machineId.toLowerCase());
    if (!data) return null;

    return {
      id: data.machineId,
      status: this.mapStatus(data.status),
      lastSeen: data.lastHeartbeat,
      version: '3.0.0',
      mode: 'code',
      source: 'heartbeat',
      firstSeen: data.metadata.firstSeen
    };
  }

  /**
   * Mettre à jour les données de présence — backward compat stub (no disk I/O)
   */
  public async updatePresence(
    machineId: string,
    _updates: Partial<PresenceData>,
    _force: boolean = false
  ): Promise<PresenceUpdateResult> {
    logger.debug(`updatePresence(${machineId}) — deprecated stub, registering heartbeat`);
    await this.heartbeatService.registerHeartbeat(machineId);
    return { success: true, conflictDetected: false };
  }

  /**
   * Mettre à jour la présence de la machine courante — delegates to HeartbeatService
   */
  public async updateCurrentPresence(
    _status: 'online' | 'offline' | 'conflict' = 'online',
    _mode: string = 'code'
  ): Promise<PresenceUpdateResult> {
    await this.heartbeatService.registerHeartbeat(this.config.machineId);
    return { success: true };
  }

  /**
   * Supprimer un machine — delegates to HeartbeatService.removeMachine
   */
  public async removePresence(machineId: string): Promise<boolean> {
    await this.heartbeatService.removeMachine(machineId);
    return true;
  }

  /**
   * Lister toutes les machines présentes — from HeartbeatService state
   */
  public async listAllPresence(): Promise<PresenceData[]> {
    const state = this.heartbeatService.getState();
    const result: PresenceData[] = [];

    for (const [machineId, data] of state.heartbeats.entries()) {
      result.push({
        id: machineId,
        status: this.mapStatus(data.status),
        lastSeen: data.lastHeartbeat,
        version: '3.0.0',
        mode: 'code',
        source: 'heartbeat',
        firstSeen: data.metadata.firstSeen
      });
    }

    return result;
  }

  /**
   * Valider l'unicité — always valid (in-memory Map guarantees uniqueness)
   */
  public async validatePresenceUniqueness(): Promise<{
    isValid: boolean;
    conflicts: Array<{
      machineId: string;
      duplicateFiles: string[];
      warningMessage: string;
    }>;
  }> {
    return { isValid: true, conflicts: [] };
  }
}
