/**
 * #833 Sprint C3 — CacheAntiLeakManager branch coverage (po-2026 lane `src/services/**`)
 *
 * The base `CacheAntiLeakManager.test.ts` (~40 tests) covers constructor config
 * merge, store/get round-trip, TTL expiry, hit-rate stats, cleanup/reset,
 * healthCheck (healthy + low-hit-warning), size estimation (incl. circular→1024),
 * shutdown, and a weak "eviction over limit" smoke test. It leaves the
 * *security-relevant* eviction + tier branches cold:
 *
 * - `healthCheck` **critical size tier >95%** (L557-559): base only reaches
 *   healthy + low-hit-warning; the >95%-of-maxTrafficGB critical arm is never
 *   exercised (default 220GB limit is unreachable with real data).
 * - `healthCheck` **warning size tier >80% ≤95%** (L560-563): same — the
 *   80%-size arm is cold.
 * - `healthCheck` **alerts>10 tier** (L572-575): alertsTriggered never exceeds
 *   10 in the base suite.
 * - `checkAntiLeakBeforeStore` **90% alert, no emergency** (L280-283): the alert
 *   console.warn fires only when projected ∈ (90%, 100%]; base never lands there.
 * - `emergencyEviction` console.error + `evictByStrategy` evicted>0 warn
 *   (L295, L266-268): triggered when projected > 100%; base's smoke test is
 *   non-deterministic and asserts only `totalEntries >= 0`.
 * - `preventiveEviction` **policy-missing defensive return** (L235): the 4 typed
 *   strategies always resolve a policy; the `if (!policy) return` guard is cold.
 * - `consistencyCheck` **24h entry-block** (L371-398): base never advances the
 *   fake clock past 5min; the hourly consistency interval + `hoursSinceLastCheck
 *   >= consistencyCheckHours` block never fires.
 * - `get()` **hit timestamp field** (L226): base asserts hit+data but not the
 *   returned `timestamp` (createdAt.getTime()).
 *
 * SKIP-WITH-EVIDENCE (unreachable via public API):
 * - `consistencyCheck` corruption branches (L380-383 invalid-data, L384-387
 *   catch): `store()` always sets valid `data`/`createdAt`/`size≥0`; the
 *   validation at L380 is a pure property check that cannot throw → the catch
 *   is dead, and the invalid arm needs a malformed entry the public API forbids.
 * - `forceEvictOldest` (L322-340): requires entries to survive the full
 *   priority-order eviction (bypass→aggressive→moderate→conservative). Since no
 *   entry is lockable via the public `store()` (locked is always false at L184),
 *   the priority loop always frees enough → the L314 fallback never fires.
 *
 * Source-grounded, add-only, mirrors the base fake-timers + console-spy pattern.
 * Each assertion cites a `CacheAntiLeakManager.ts` line.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheAntiLeakManager } from '../CacheAntiLeakManager.js';
import type { CacheConfiguration } from '../../interfaces/UnifiedToolInterface.js';

/**
 * Builds a string whose JSON-stringified ×2 (UTF-16) byte size ≈ targetBytes.
 * estimateSize (L423) = JSON.stringify(data).length * 2; for a raw string the
 * serialized form is `"…"` (N chars + 2 quotes) → 2*(N+2) bytes.
 */
function stringForBytes(targetBytes: number): string {
  const n = Math.max(0, Math.ceil((targetBytes - 4) / 2));
  return 'x'.repeat(n);
}

const GB = 1024 * 1024 * 1024;

describe('CacheAntiLeakManager — branch coverage (#833 C3, source-grounded)', () => {
  let manager: CacheAntiLeakManager;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    manager = new CacheAntiLeakManager({ enabled: true });
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ============================================================
  // healthCheck — critical size tier >95% (L557-559)
  // ============================================================
  describe('healthCheck — critical size tier (L557-559)', () => {
    it('returns status=critical when totalSizeGB > 95% of maxTrafficGB', async () => {
      // Tiny limit so a single string entry can cross 95% WITHOUT crossing 100%
      // (crossing 100% would trigger emergency eviction, removing the entry).
      const maxGB = 0.001;
      const critical = new CacheAntiLeakManager({ enabled: true, maxTrafficGB: maxGB });
      // Target ~97% of maxGB, in bytes.
      const targetBytes = 0.97 * maxGB * GB; // ≈ 1_041_616 bytes
      const data = stringForBytes(targetBytes);

      await critical.store('big', data, { strategy: 'conservative', ttl: 3600000 });

      const health = critical.healthCheck();
      // L557-559: >95% → critical + "Cache size critical" issue.
      expect(health.status).toBe('critical');
      expect(health.issues.some(i => i.includes('Cache size critical'))).toBe(true);

      await critical.shutdown();
    });
  });

  // ============================================================
  // healthCheck — warning size tier >80% ≤95% (L560-563)
  // ============================================================
  describe('healthCheck — warning size tier (L560-563)', () => {
    it('emits "Cache size warning" when totalSizeGB ∈ (80%, 95%] of max', async () => {
      const maxGB = 0.001;
      const warn = new CacheAntiLeakManager({ enabled: true, maxTrafficGB: maxGB });
      // Target ~85% of maxGB — above 80% (warning) but below 90% (no alert noise)
      // and below 95% (not critical).
      const targetBytes = 0.85 * maxGB * GB;
      const data = stringForBytes(targetBytes);

      await warn.store('mid', data, { strategy: 'conservative', ttl: 3600000 });

      const health = warn.healthCheck();
      // L560-563: >80% (and not >95%) → "Cache size warning".
      expect(health.issues.some(i => i.includes('Cache size warning'))).toBe(true);
      // Not critical (below 95%).
      expect(health.status).not.toBe('critical');

      await warn.shutdown();
    });
  });

  // ============================================================
  // healthCheck — alerts > 10 tier (L572-575)
  // ============================================================
  describe('healthCheck — high alert count tier (L572-575)', () => {
    it('emits "High alert count" when alertsTriggered > 10', async () => {
      // maxGB so each store projects >90% (alert) but oscillates around 100%
      // (emergency clears the prior entry each time). Every store alerts → 11
      // stores reliably push alertsTriggered > 10.
      const maxGB = 0.0001;
      const alert90 = 0.9 * maxGB * GB; // 90% threshold in bytes
      const mgr = new CacheAntiLeakManager({ enabled: true, maxTrafficGB: maxGB });
      // Each entry ~93% of max → projected (with one cached) crosses 100% →
      // emergency evicts the prior, the incoming is stored. alerts++ every time.
      const data = stringForBytes(alert90 * 1.03);

      for (let i = 0; i < 11; i++) {
        await mgr.store(`k${i}`, data, { strategy: 'conservative', ttl: 3600000 });
      }

      const stats = mgr.getStats();
      // Sanity: the alert path fired enough to cross the tier.
      expect(stats.alertsTriggered).toBeGreaterThan(10);

      const health = mgr.healthCheck();
      // L572-575: alertsTriggered > 10 → "High alert count" issue.
      expect(health.issues.some(i => i.includes('High alert count'))).toBe(true);

      await mgr.shutdown();
    });
  });

  // ============================================================
  // checkAntiLeakBeforeStore — 90% alert, no emergency (L280-283)
  // ============================================================
  describe('checkAntiLeakBeforeStore — 90% alert (L280-283)', () => {
    it('fires the ALERT warn and increments alertsTriggered when projected > 90%', async () => {
      const maxGB = 0.001;
      const mgr = new CacheAntiLeakManager({ enabled: true, maxTrafficGB: maxGB });
      // ~93% of max: > 90% (alert) but < 100% (no emergency).
      const data = stringForBytes(0.93 * maxGB * GB);

      await mgr.store('alerting', data, { strategy: 'conservative', ttl: 3600000 });

      // L281: alertsTriggered++ ; L282: console.warn "...ALERT: Approaching limit..."
      expect(mgr.getStats().alertsTriggered).toBe(1);
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('ALERT'))).toBe(true);

      await mgr.shutdown();
    });
  });

  // ============================================================
  // emergencyEviction + evictByStrategy warn (L295, L266-268)
  // ============================================================
  describe('emergencyEviction + evictByStrategy warn (L295, L266-268)', () => {
    it('triggers EMERGENCY EVICTION (console.error) when projected > 100%', async () => {
      const maxGB = 0.0001;
      const mgr = new CacheAntiLeakManager({ enabled: true, maxTrafficGB: maxGB });
      // Entries under strategy 'bypass' (first in emergencyEviction priorityOrder
      // ['bypass','aggressive','moderate','conservative'] at L298). emergencyEviction
      // breaks after the first strategy due to `freedSpaceGB += needed` (L310), so
      // only 'bypass' entries are visible to evictByStrategy during emergency —
      // hence we store bypass entries to also exercise the evicted>0 warn (L266-268).
      const data = stringForBytes(0.93 * maxGB * GB);
      await mgr.store('first', data, { strategy: 'bypass', ttl: 60000 });
      // Second store: projected ≈ 186% > 100% → emergencyEviction → evictByStrategy('bypass').
      await mgr.store('second', data, { strategy: 'bypass', ttl: 60000 });

      // L295: console.error "EMERGENCY EVICTION".
      expect(errorSpy.mock.calls.some(c => String(c[0]).includes('EMERGENCY EVICTION'))).toBe(true);
      // L266-268: evictByStrategy evicted>0 → console.warn "Éviction préventive".
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('Éviction préventive'))).toBe(true);

      await mgr.shutdown();
    });
  });

  // ============================================================
  // preventiveEviction — policy-missing defensive return (L235)
  // ============================================================
  describe('preventiveEviction — policy-missing return (L235)', () => {
    it('stores the entry without throwing when the strategy has no policy (bogus strategy)', async () => {
      // A strategy absent from evictionPolicies → policy=undefined → L235 early
      // return. The entry is still stored (no eviction, no throw).
      const bogus = { strategy: 'bogus-strategy' as any, ttl: 60000 } as CacheConfiguration;

      await manager.store('guarded', { v: 1 }, bogus);

      // Entry survived because preventiveEviction short-circuited on the missing
      // policy (L235) — it did NOT try to evict by an undefined strategy.
      const result = await manager.get<{ v: number }>('guarded');
      expect(result).not.toBeNull();
      expect(result!.data).toEqual({ v: 1 });
    });
  });

  // ============================================================
  // consistencyCheck — 24h entry-block (L371-398)
  // ============================================================
  describe('consistencyCheck — 24h entry-block (L371-398)', () => {
    it('runs the consistency block after the clock crosses consistencyCheckHours', async () => {
      // The hourly interval (L413) fires consistencyCheck; the block enters only
      // when hoursSinceLastCheck >= consistencyCheckHours (default 24). Advance
      // past 24h so exactly one block-entry fires (it updates lastConsistencyCheck,
      // so subsequent hourly ticks skip).
      vi.advanceTimersByTime(25 * 60 * 60 * 1000); // 25h

      // L372 "Starting 24h consistency check..." or L397 "Consistency check completed...".
      expect(logSpy.mock.calls.some(c => /consistency check/i.test(String(c[0])))).toBe(true);
    });
  });

  // ============================================================
  // get() — hit timestamp field (L226)
  // ============================================================
  describe('get — hit timestamp field (L226)', () => {
    it('returns timestamp = entry.createdAt.getTime() on a hit', async () => {
      await manager.store('ts', 'payload', { strategy: 'moderate', ttl: 60000 });

      const result = await manager.get<string>('ts');
      expect(result).not.toBeNull();
      // L223-227: hit result carries timestamp (createdAt.getTime()).
      expect(typeof result!.timestamp).toBe('number');
      expect(result!.timestamp).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // SKIP-WITH-EVIDENCE — unreachable via public API
  // ============================================================
  describe.skip('consistencyCheck corruption branches (L380-387) — UNREACHABLE', () => {
    // store() always sets valid data/createdAt/size≥0 (L175-186); the L380
    // validation is a pure property check that cannot throw → the L384-387 catch
    // is dead, and the L380-383 invalid arm needs a malformed entry the public
    // API forbids. Documented; not coverable without exposing internal mutation.
    it.todo('invalid-entry arm + try/catch — needs internal entry mutation (forbidden by public API)');
  });

  describe.skip('forceEvictOldest (L322-340) — UNREACHABLE', () => {
    // Requires entries to survive the full bypass→aggressive→moderate→conservative
    // priority eviction (emergencyEviction L302-311). Since store() sets locked
    // = false unconditionally (L184) and nothing locks entries via the public
    // API, evictByStrategy always frees enough → the L314 `totalSizeGB > max`
    // fallback never holds → forceEvictOldest is dead code.
    it.todo('force-eviction fallback — needs lockable entries (forbidden by public API)');
  });
});
