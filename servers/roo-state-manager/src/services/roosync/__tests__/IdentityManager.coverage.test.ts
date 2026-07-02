/**
 * #833 Sprint C3 — IdentityManager branch coverage (po-2026 lane `src/services/roosync/**`)
 *
 * The existing `IdentityManager.test.ts` (18 tests) exercises the happy paths with a
 * REAL HeartbeatService + PresenceManager. Because PresenceManager is heartbeat-derived
 * (#2121 Phase 2.1), every machine present in `listAllPresence()` is ALSO in HeartbeatService
 * state → it is always added by the heartbeat loop first (source `'heartbeat'`) and the
 * presence loop then hits the `continue` guard. Three branches are therefore unreachable
 * in the base suite's wiring:
 *
 * - presence-ADD branch (L104-111): a presence entry whose `id` is NOT already in the
 *   identity map → added with `source: 'presence'`.
 * - presence `firstSeen` fallback (L107 `presence.firstSeen || presence.lastSeen`): when
 *   a presence entry carries no `firstSeen`, the identity's `firstSeen` must fall back to
 *   `lastSeen`.
 * - presence `continue` skip (L103): a presence entry whose `id` is already known (e.g. the
 *   config machineId) must NOT be overwritten with `source: 'presence'`.
 *
 * This add-only file injects a stub PresenceManager to reach those cold paths. Every
 * assertion is anchored on a source line of `IdentityManager.ts`.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { IdentityManager } from '../IdentityManager.js';
import { HeartbeatService } from '../HeartbeatService.js';
import type { PresenceData } from '../PresenceManager.js';

const mockConfig = {
  machineId: 'test-machine',
  sharedPath: '/shared/path',
};

/** Build an IdentityManager with a stub PresenceManager returning the given presence list. */
function makeManager(presenceList: PresenceData[]): IdentityManager {
  const heartbeatService = new HeartbeatService('/test');
  const presenceManagerStub = {
    listAllPresence: vi.fn().mockResolvedValue(presenceList),
  };
  return new IdentityManager(mockConfig as any, presenceManagerStub as any, heartbeatService);
}

describe('IdentityManager — presence-path branch coverage (#833 C3, source-grounded)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── collectAllIdentities: presence-ADD branch (source L104-111) ──

  test('collectAllIdentities adds a presence-only machine with source "presence" (L104-111)', async () => {
    // A machine that appears in PresenceManager but NOT in HeartbeatService state and is
    // NOT the config machineId → only reachable via the presence loop's ADD branch.
    const presenceOnly: PresenceData[] = [
      {
        id: 'presence-only-machine',
        status: 'online',
        lastSeen: '2026-07-02T12:00:00.000Z',
        version: '3.0.0',
        mode: 'code',
        source: 'heartbeat',
        firstSeen: '2026-07-01T08:00:00.000Z',
      },
    ];
    const manager = makeManager(presenceOnly);

    const identities = await manager.collectAllIdentities();
    // config identity + the presence-only identity.
    expect(identities.size).toBe(2);
    expect(identities.has('presence-only-machine')).toBe(true);
    // The presence ADD branch sets source 'presence' — distinct from 'heartbeat'/'config'.
    expect(identities.get('presence-only-machine')?.source).toBe('presence');
    // metadata.presencePath marker from L110.
    expect(identities.get('presence-only-machine')?.metadata?.presencePath).toBe('heartbeat-derived');
  });

  // ── collectAllIdentities: firstSeen fallback to lastSeen (source L107) ──

  test('collectAllIdentities falls back to lastSeen when presence.firstSeen is absent (L107)', async () => {
    const lastSeen = '2026-07-02T12:00:00.000Z';
    const presenceNoFirstSeen: PresenceData[] = [
      {
        id: 'no-firstseen-machine',
        status: 'idle',
        lastSeen,
        version: '3.0.0',
        mode: 'code',
        source: 'heartbeat',
        firstSeen: undefined,
      },
    ];
    const manager = makeManager(presenceNoFirstSeen);

    const identities = await manager.collectAllIdentities();
    const identity = identities.get('no-firstseen-machine');
    expect(identity).toBeDefined();
    // L107 `presence.firstSeen || presence.lastSeen` → firstSeen must equal lastSeen.
    expect(identity!.firstSeen).toBe(lastSeen);
    expect(identity!.lastSeen).toBe(lastSeen);
  });

  // ── collectAllIdentities: presence `continue` skip — config machineId not overwritten (L103) ──

  test('collectAllIdentities does NOT overwrite the config identity with a presence entry (L103)', async () => {
    // Presence list includes the CONFIG machineId ('test-machine'). It is already in the
    // map from the config step (L78-85) → presence loop must `continue` and keep source 'config'.
    const presenceWithConfigId: PresenceData[] = [
      {
        id: 'test-machine', // same as mockConfig.machineId
        status: 'online',
        lastSeen: '2026-07-02T12:00:00.000Z',
        version: '3.0.0',
        mode: 'code',
        source: 'heartbeat',
        firstSeen: '2026-07-01T08:00:00.000Z',
      },
    ];
    const manager = makeManager(presenceWithConfigId);

    const identities = await manager.collectAllIdentities();
    // Only the config identity exists — presence entry was skipped, not added twice.
    expect(identities.size).toBe(1);
    expect(identities.get('test-machine')?.source).toBe('config');
    // The presence marker must NOT have been written over the config identity.
    expect(identities.get('test-machine')?.metadata?.presencePath).toBeUndefined();
  });
});
