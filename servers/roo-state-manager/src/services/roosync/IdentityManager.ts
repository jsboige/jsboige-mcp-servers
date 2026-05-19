/**
 * Gestionnaire central d'identité pour RooSync — #2121 Phase 2.1
 *
 * Dashboard-derived identity model. No disk I/O — derives machine identities
 * from HeartbeatService in-memory state. GDrive writes to .identity-registry.json
 * eliminated.
 *
 * @module IdentityManager
 * @version 2.0.0 (#2121 Phase 2.1: dashboard-derived identity)
 */

import { createLogger } from '../../utils/logger.js';
import { RooSyncConfig } from '../../config/roosync-config.js';
import { PresenceManager } from './PresenceManager.js';
import { HeartbeatService } from './HeartbeatService.js';
import {
  IdentityManagerError,
  IdentityManagerErrorCode
} from '../../types/errors.js';

const logger = createLogger('IdentityManager');

/**
 * Sources d'identité possibles
 */
export type IdentitySource = 'config' | 'presence' | 'baseline' | 'dashboard' | 'registry';

/**
 * Informations d'identité complètes
 */
export interface IdentityInfo {
  machineId: string;
  source: IdentitySource;
  firstSeen: string;
  lastSeen: string;
  status: 'valid' | 'conflict' | 'orphaned';
  metadata?: {
    configPath?: string;
    presencePath?: string;
    baselinePath?: string;
    dashboardPath?: string;
    registryPath?: string;
  };
}

/**
 * Résultat de validation d'identité
 */
export interface IdentityValidationResult {
  isValid: boolean;
  conflicts: Array<{
    machineId: string;
    sources: IdentitySource[];
    warningMessage: string;
  }>;
  orphaned: IdentityInfo[];
  recommendations: string[];
}

/**
 * Gestionnaire central d'identité — dashboard-derived, no disk I/O
 */
export class IdentityManager {
  constructor(
    private config: RooSyncConfig,
    private presenceManager: PresenceManager,
    private heartbeatService: HeartbeatService
  ) {}

  /**
   * Collecter les identités depuis HeartbeatService + config
   */
  public async collectAllIdentities(): Promise<Map<string, IdentityInfo>> {
    const identities = new Map<string, IdentityInfo>();
    const now = new Date().toISOString();

    // 1. Config identity (this machine)
    identities.set(this.config.machineId, {
      machineId: this.config.machineId,
      source: 'config',
      firstSeen: now,
      lastSeen: now,
      status: 'valid',
      metadata: { configPath: process.env.ROOSYNC_CONFIG_PATH || 'environment' }
    });

    // 2. HeartbeatService state (all known machines)
    const state = this.heartbeatService.getState();
    for (const [machineId, data] of state.heartbeats.entries()) {
      if (identities.has(machineId)) continue; // config identity takes priority
      identities.set(machineId, {
        machineId,
        source: 'heartbeat' as IdentitySource,
        firstSeen: data.metadata.firstSeen,
        lastSeen: data.lastHeartbeat,
        status: 'valid'
      });
    }

    // 3. PresenceManager (backward compat — reads from HeartbeatService)
    const allPresence = await this.presenceManager.listAllPresence();
    for (const presence of allPresence) {
      if (identities.has(presence.id)) continue;
      identities.set(presence.id, {
        machineId: presence.id,
        source: 'presence',
        firstSeen: presence.firstSeen || presence.lastSeen,
        lastSeen: presence.lastSeen,
        status: 'valid',
        metadata: { presencePath: 'heartbeat-derived' }
      });
    }

    logger.info(`Collected ${identities.size} identities from HeartbeatService`);
    return identities;
  }

  /**
   * Valider toutes les identités — in-memory, always valid
   */
  public async validateIdentities(): Promise<IdentityValidationResult> {
    const identities = await this.collectAllIdentities();
    const conflicts: IdentityValidationResult['conflicts'] = [];
    const orphaned: IdentityInfo[] = [];

    return {
      isValid: conflicts.length === 0 && orphaned.length === 0,
      conflicts,
      orphaned,
      recommendations: conflicts.length === 0 && orphaned.length === 0
        ? ['No identity issues detected']
        : []
    };
  }

  /**
   * Obtenir l'identité principale (celle de la configuration courante)
   */
  public getPrimaryIdentity(): IdentityInfo {
    return {
      machineId: this.config.machineId,
      source: 'config',
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      status: 'valid',
      metadata: {
        configPath: process.env.ROOSYNC_CONFIG_PATH || 'environment'
      }
    };
  }

  /**
   * Synchroniser le registre d'identité — deprecated no-op (#2121 Phase 2.1)
   */
  public async syncIdentityRegistry(): Promise<void> {
    logger.info('syncIdentityRegistry() — deprecated no-op (dashboard-derived identity)');
  }

  /**
   * Nettoyer les identités orphelines — deprecated no-op (#2121 Phase 2.1)
   */
  public async cleanupIdentities(_options?: {
    removeOrphaned?: boolean;
    resolveConflicts?: boolean;
    dryRun?: boolean;
  }): Promise<{ removed: string[]; resolved: string[]; errors: string[] }> {
    return { removed: [], resolved: [], errors: [] };
  }

  /**
   * Vérifier s'il y a un conflit d'identité au démarrage
   *
   * With auto-heartbeat (ADR 008), concurrent identity is normal — multiple
   * MCP instances for the same machineId register heartbeats independently.
   * Only warn if a heartbeat is very recent AND from a different process.
   */
  public async checkIdentityConflict(): Promise<void> {
    const data = this.heartbeatService.getHeartbeatData(this.config.machineId);
    if (!data) {
      logger.info(`No existing heartbeat for ${this.config.machineId} — first registration`);
      return;
    }

    const elapsed = Date.now() - new Date(data.lastHeartbeat).getTime();
    const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min

    if (elapsed < ACTIVE_THRESHOLD_MS) {
      logger.warn(`Recent heartbeat found for ${this.config.machineId} (${Math.round(elapsed / 1000)}s ago) — concurrent instance possible but not blocking`);
    } else {
      logger.info(`Previous heartbeat for ${this.config.machineId} expired (${Math.round(elapsed / 1000)}s ago) — safe to proceed`);
    }
  }
}
