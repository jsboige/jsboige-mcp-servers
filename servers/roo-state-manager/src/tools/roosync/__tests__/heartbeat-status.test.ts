/**
 * Tests unitaires pour roosyncHeartbeatStatus
 *
 * Couvre roosyncHeartbeatStatus (lignes 124-209) :
 * - Cas de base (filter=all, includeHeartbeats=true)
 * - Filtres : online, offline, warning
 * - forceCheck / includeChanges
 * - includeHeartbeats=false
 * - Propagation HeartbeatServiceError
 * - Wrapping erreur générique
 *
 * @module tools/roosync/__tests__/heartbeat-status.test
 * @version 1.0.0 (#492)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { HeartbeatServiceError } from '../../../services/roosync/HeartbeatService.js';

// ─────────────────── mocks ───────────────────

const mockCheckHeartbeats = vi.fn();
const mockGetState = vi.fn();
const mockGetHeartbeatService = vi.fn(() => ({
  checkHeartbeats: mockCheckHeartbeats,
  getState: mockGetState
}));
const mockGetConfig = vi.fn(() => ({ sharedPath: '/mock', machineId: 'test' }));

vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(() => ({
    getConfig: mockGetConfig,
    getHeartbeatService: mockGetHeartbeatService
  })),
  RooSyncServiceError: class RooSyncServiceError extends Error {
    constructor(message: string, public code: string) { super(message); }
  }
}));

vi.mock('../../../services/roosync/HeartbeatService.js', () => ({
  HeartbeatServiceError: class HeartbeatServiceError extends Error {
    constructor(message: string, public code: string) { super(message); }
  }
}));

// ─────────────────── helpers ───────────────────

import { roosyncHeartbeatStatus } from '../heartbeat-status.js';

/** State complet typique retourné par heartbeatService.getState() */
function makeState(overrides: Record<string, any> = {}) {
  return {
    onlineMachines: ['myia-ai-01', 'myia-po-2025'],
    offlineMachines: ['myia-web1'],
    warningMachines: ['myia-po-2023'],
    heartbeats: new Map([
      ['myia-ai-01', {
        machineId: 'myia-ai-01', lastHeartbeat: '2026-02-22T10:00:00.000Z',
        status: 'online', missedHeartbeats: 0,
        metadata: { firstSeen: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-02-22T10:00:00.000Z', version: '1.0' }
      }],
      ['myia-po-2025', {
        machineId: 'myia-po-2025', lastHeartbeat: '2026-02-22T09:58:00.000Z',
        status: 'online', missedHeartbeats: 0,
        metadata: { firstSeen: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-02-22T09:58:00.000Z', version: '1.0' }
      }],
      ['myia-web1', {
        machineId: 'myia-web1', lastHeartbeat: '2026-02-21T10:00:00.000Z',
        status: 'offline', missedHeartbeats: 5,
        metadata: { firstSeen: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-02-21T10:00:00.000Z', version: '1.0' }
      }],
      ['myia-po-2023', {
        machineId: 'myia-po-2023', lastHeartbeat: '2026-02-22T09:30:00.000Z',
        status: 'warning', missedHeartbeats: 2,
        metadata: { firstSeen: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-02-22T09:30:00.000Z', version: '1.0' }
      }]
    ]),
    statistics: {
      totalMachines: 4,
      onlineCount: 2,
      offlineCount: 1,
      warningCount: 1,
      lastHeartbeatCheck: '2026-02-22T10:00:00.000Z'
    },
    ...overrides
  };
}

function makeCheckResult(overrides: Record<string, any> = {}) {
  return {
    newlyOfflineMachines: [],
    newlyOnlineMachines: [],
    warningMachines: [],
    ...overrides
  };
}

// ─────────────────── tests ───────────────────

describe('roosyncHeartbeatStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue(makeState());
    mockCheckHeartbeats.mockResolvedValue(makeCheckResult());
  });

  // ── cas de base ──

  test('retourne success=true avec état complet (filter=all, defaults)', async () => {
    const result = await roosyncHeartbeatStatus({});

    expect(result.success).toBe(true);
    expect(result.onlineMachines).toEqual(['myia-ai-01', 'myia-po-2025']);
    expect(result.offlineMachines).toEqual(['myia-web1']);
    expect(result.warningMachines).toEqual(['myia-po-2023']);
    expect(result.statistics.totalMachines).toBe(4);
    expect(result.retrievedAt).toBeDefined();
    expect(result.changes).toBeUndefined();
    // checkHeartbeats pas appelé par défaut
    expect(mockCheckHeartbeats).not.toHaveBeenCalled();
  });

  test('inclut les heartbeats par défaut (includeHeartbeats=true)', async () => {
    const result = await roosyncHeartbeatStatus({ includeHeartbeats: true });

    expect(result.heartbeats).toBeDefined();
    expect(result.heartbeats!['myia-ai-01']).toBeDefined();
    expect(result.heartbeats!['myia-ai-01'].status).toBe('online');
  });

  test('n\'inclut pas les heartbeats si includeHeartbeats=false', async () => {
    const result = await roosyncHeartbeatStatus({ includeHeartbeats: false });

    expect(result.heartbeats).toBeUndefined();
  });

  // ── filtres ──

  test('filter=online : vide offlineMachines et warningMachines', async () => {
    const result = await roosyncHeartbeatStatus({ filter: 'online' });

    expect(result.onlineMachines).toEqual(['myia-ai-01', 'myia-po-2025']);
    expect(result.offlineMachines).toEqual([]);
    expect(result.warningMachines).toEqual([]);
  });

  test('filter=offline : vide onlineMachines et warningMachines', async () => {
    const result = await roosyncHeartbeatStatus({ filter: 'offline' });

    expect(result.onlineMachines).toEqual([]);
    expect(result.offlineMachines).toEqual(['myia-web1']);
    expect(result.warningMachines).toEqual([]);
  });

  test('filter=warning : vide onlineMachines et offlineMachines', async () => {
    const result = await roosyncHeartbeatStatus({ filter: 'warning' });

    expect(result.onlineMachines).toEqual([]);
    expect(result.offlineMachines).toEqual([]);
    expect(result.warningMachines).toEqual(['myia-po-2023']);
  });

  test('filter=online avec includeHeartbeats : ne garde que les heartbeats online', async () => {
    const result = await roosyncHeartbeatStatus({ filter: 'online', includeHeartbeats: true });

    expect(result.heartbeats).toBeDefined();
    expect(Object.keys(result.heartbeats!)).toContain('myia-ai-01');
    expect(Object.keys(result.heartbeats!)).not.toContain('myia-web1');
    expect(Object.keys(result.heartbeats!)).not.toContain('myia-po-2023');
  });

  test('filter=offline avec includeHeartbeats : ne garde que les heartbeats offline', async () => {
    const result = await roosyncHeartbeatStatus({ filter: 'offline', includeHeartbeats: true });

    expect(result.heartbeats).toBeDefined();
    expect(Object.keys(result.heartbeats!)).toEqual(['myia-web1']);
  });

  test('filter=warning avec includeHeartbeats : ne garde que les heartbeats warning', async () => {
    const result = await roosyncHeartbeatStatus({ filter: 'warning', includeHeartbeats: true });

    expect(result.heartbeats).toBeDefined();
    expect(Object.keys(result.heartbeats!)).toEqual(['myia-po-2023']);
  });

  // ── forceCheck / includeChanges ──

  test('forceCheck=true appelle checkHeartbeats et retourne les changes', async () => {
    mockCheckHeartbeats.mockResolvedValue(makeCheckResult({
      newlyOfflineMachines: ['myia-po-2024'],
      newlyOnlineMachines: [],
      warningMachines: []
    }));

    const result = await roosyncHeartbeatStatus({ forceCheck: true });

    expect(mockCheckHeartbeats).toHaveBeenCalledTimes(1);
    expect(result.changes).toBeDefined();
    expect(result.changes!.newlyOfflineMachines).toEqual(['myia-po-2024']);
    expect(result.changes!.totalChanges).toBe(1);
  });

  test('includeChanges=true appelle checkHeartbeats', async () => {
    const result = await roosyncHeartbeatStatus({ includeChanges: true });

    expect(mockCheckHeartbeats).toHaveBeenCalledTimes(1);
    expect(result.changes).toBeDefined();
    expect(result.changes!.totalChanges).toBe(0);
  });

  test('forceCheck=true avec changements multiples calcule totalChanges correctement', async () => {
    mockCheckHeartbeats.mockResolvedValue(makeCheckResult({
      newlyOfflineMachines: ['myia-po-2024'],
      newlyOnlineMachines: ['myia-po-2026'],
      warningMachines: ['myia-ai-01']
    }));

    const result = await roosyncHeartbeatStatus({ forceCheck: true });

    expect(result.changes!.totalChanges).toBe(3);
    expect(result.changes!.newWarnings).toEqual(['myia-ai-01']);
  });

  // ── gestion d'erreurs ──

  test('propage HeartbeatServiceError sans wrapping', async () => {
    const original = new HeartbeatServiceError('Service down', 'SERVICE_DOWN');
    mockGetState.mockImplementation(() => { throw original; });

    await expect(roosyncHeartbeatStatus({})).rejects.toBeInstanceOf(HeartbeatServiceError);
  });

  test('wrap les erreurs génériques en HeartbeatServiceError', async () => {
    mockGetState.mockImplementation(() => { throw new Error('unexpected error'); });

    await expect(roosyncHeartbeatStatus({}))
      .rejects.toThrow('Erreur lors de la recuperation du statut heartbeat');
  });

  test('wrap les erreurs de checkHeartbeats en HeartbeatServiceError', async () => {
    mockCheckHeartbeats.mockRejectedValue(new Error('check failed'));

    await expect(roosyncHeartbeatStatus({ forceCheck: true }))
      .rejects.toThrow('Erreur lors de la recuperation du statut heartbeat');
  });
});
