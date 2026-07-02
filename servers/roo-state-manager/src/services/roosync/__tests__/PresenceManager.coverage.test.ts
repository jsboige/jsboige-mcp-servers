/**
 * #833 Sprint C3 — PresenceManager branch coverage (po-2026 lane `src/services/roosync/**`)
 *
 * The existing `PresenceManager.test.ts` (15 tests) covers the API surface
 * (PresenceManagerError, read/update/remove/list/validate) but only ever
 * observes machines freshly registered — which HeartbeatService always
 * reports as `'online'`. That leaves the ADR 008 status-mapping branches
 * in `mapStatus` cold: the `'idle'` (L69) and `'unknown'` (L70) arms are
 * never exercised, nor is the lowercasing guard (L77) or the full field
 * contract of the mapped PresenceData (version/mode/firstSeen/lastSeen).
 *
 * This add-only file targets those residual branches so a regression in
 * the status mapping (e.g. forgetting `idle`) actually fails a test
 * instead of silently collapsing to `'unknown'`.
 *
 * Every assertion is anchored on a source line of `PresenceManager.ts`.
 * Uses the real HeartbeatService (in-memory) — no mocks, no fs.
 */

import { describe, test, expect, beforeEach } from 'vitest';

import { PresenceManager } from '../PresenceManager.js';
import { HeartbeatService } from '../HeartbeatService.js';

const mockConfig = {
  machineId: 'test-machine',
  sharedPath: '/shared/path',
};

describe('PresenceManager — branch coverage (#833 C3, source-grounded)', () => {
  let heartbeatService: HeartbeatService;
  let manager: PresenceManager;

  beforeEach(() => {
    heartbeatService = new HeartbeatService('/test');
    manager = new PresenceManager(mockConfig as any, heartbeatService);
  });

  // ── mapStatus 'idle' (source L67-71, idle arm L69) ──
  //
  // ADR 008: idle = lastHeartbeat 30-120 min ago. HeartbeatService.checkHeartbeats
  // derives this (HeartbeatService.ts L420-426); PresenceManager.mapStatus must
  // propagate it as 'idle' (L69), not collapse to 'unknown'.

  test('readPresence maps IDLE heartbeat (30-120 min) → status "idle" (L69)', async () => {
    await heartbeatService.registerHeartbeat('idle-machine');
    const hb = heartbeatService.getHeartbeatData('idle-machine')!;
    hb.lastHeartbeat = new Date(Date.now() - 45 * 60 * 1000).toISOString(); // 45 min ago
    await heartbeatService.checkHeartbeats(); // derive → idle

    const result = await manager.readPresence('idle-machine');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('idle');
  });

  test('listAllPresence propagates IDLE status across the mapStatus arm (L69, L133)', async () => {
    await heartbeatService.registerHeartbeat('idle-machine');
    heartbeatService.getHeartbeatData('idle-machine')!.lastHeartbeat =
      new Date(Date.now() - 90 * 60 * 1000).toISOString(); // 90 min ago
    await heartbeatService.checkHeartbeats();

    const all = await manager.listAllPresence();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('idle');
  });

  // ── mapStatus 'unknown' (source L67-71, unknown arm L70) ──
  //
  // ADR 008: unknown = lastHeartbeat >120 min ago.

  test('readPresence maps UNKNOWN heartbeat (>120 min) → status "unknown" (L70)', async () => {
    await heartbeatService.registerHeartbeat('gone-machine');
    heartbeatService.getHeartbeatData('gone-machine')!.lastHeartbeat =
      new Date(Date.now() - 150 * 60 * 1000).toISOString(); // 150 min ago
    await heartbeatService.checkHeartbeats();

    const result = await manager.readPresence('gone-machine');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('unknown');
  });

  test('listAllPresence propagates UNKNOWN status (L70, L133)', async () => {
    await heartbeatService.registerHeartbeat('gone-machine');
    heartbeatService.getHeartbeatData('gone-machine')!.lastHeartbeat =
      new Date(Date.now() - 200 * 60 * 1000).toISOString();
    await heartbeatService.checkHeartbeats();

    const all = await manager.listAllPresence();
    expect(all[0].status).toBe('unknown');
  });

  test('listAllPresence returns a mixed-status set preserving each mapStatus branch (L67-70)', async () => {
    // online — fresh
    await heartbeatService.registerHeartbeat('live-machine');
    // idle — 45 min
    await heartbeatService.registerHeartbeat('quiet-machine');
    heartbeatService.getHeartbeatData('quiet-machine')!.lastHeartbeat =
      new Date(Date.now() - 45 * 60 * 1000).toISOString();
    // unknown — 150 min
    await heartbeatService.registerHeartbeat('lost-machine');
    heartbeatService.getHeartbeatData('lost-machine')!.lastHeartbeat =
      new Date(Date.now() - 150 * 60 * 1000).toISOString();
    await heartbeatService.checkHeartbeats();

    const byId = new Map((await manager.listAllPresence()).map((p) => [p.id, p.status]));
    expect(byId.get('live-machine')).toBe('online');
    expect(byId.get('quiet-machine')).toBe('idle');
    expect(byId.get('lost-machine')).toBe('unknown');
  });

  // ── readPresence lowercasing guard (source L77 `machineId.toLowerCase()`) ──

  test('readPresence lowercases the machineId before lookup (L77)', async () => {
    await heartbeatService.registerHeartbeat('mixed-case-machine'); // HeartbeatService lowercases on register

    const result = await manager.readPresence('MIXED-CASE-MACHINE');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('mixed-case-machine');
  });

  // ── readPresence full field contract (source L80-88) ──
  //
  // The nominal test checks id/status/source only. Lock the complete contract:
  // version='3.0.0', mode='code', firstSeen/lastSeen from heartbeat metadata.

  test('readPresence returns the full PresenceData field contract (L80-88)', async () => {
    await heartbeatService.registerHeartbeat('full-machine');
    const hb = heartbeatService.getHeartbeatData('full-machine')!;

    const result = await manager.readPresence('full-machine');
    expect(result).toEqual({
      id: 'full-machine',
      status: 'online',
      lastSeen: hb.lastHeartbeat,
      version: '3.0.0',
      mode: 'code',
      source: 'heartbeat',
      firstSeen: hb.metadata.firstSeen,
    });
  });

  test('listAllPresence returns the same full field contract per entry (L131-139)', async () => {
    await heartbeatService.registerHeartbeat('full-machine');
    const hb = heartbeatService.getHeartbeatData('full-machine')!;

    const all = await manager.listAllPresence();
    expect(all[0]).toEqual({
      id: 'full-machine',
      status: 'online',
      lastSeen: hb.lastHeartbeat,
      version: '3.0.0',
      mode: 'code',
      source: 'heartbeat',
      firstSeen: hb.metadata.firstSeen,
    });
  });

  // ── updatePresence backward-compat stub explicit contract (source L94-102) ──

  test('updatePresence returns conflictDetected=false explicitly and ignores force (L97, L101)', async () => {
    const result = await manager.updatePresence('m', { status: 'offline' }, true);
    expect(result).toEqual({ success: true, conflictDetected: false });
    // force=true is ignored (no disk conflict in dashboard-derived model) — still registers.
    expect(heartbeatService.getHeartbeatData('m')).toBeDefined();
  });
});
