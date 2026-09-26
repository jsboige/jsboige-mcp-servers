/**
 * #1240 follow-up — OPT-IN e2e: the PG consultative lock row exercised on the
 * REAL store with TWO real connections.
 *
 * Why opt-in: it needs migration 009 (`roosync_dashboard_locks`) applied and a
 * reachable UNIFIED_STORE_PG_URL — neither is true in CI. Enable with:
 *
 *   ROOSYNC_E2E_PG=1 UNIFIED_STORE_PG_URL=postgres://… npx vitest run \
 *     src/services/unified-store/__tests__/dashboard-lock-store.e2e.test.ts
 *
 * The unit-level contract (wrapper fail-open, 'held'/'unavailable' semantics)
 * lives in dashboard-lock-store.test.ts. What ONLY a real two-connection run
 * can prove — and what the CoursIA 26/09 incident made load-bearing:
 *
 *   1. INSERT concurrent — two separate pools race the ON CONFLICT DO NOTHING
 *      insert; exactly one wins, the loser reads 'held', the row keeps the
 *      winner's holder.
 *   2. Vol par TTL — the steal UPDATE compares acquired_at against the single
 *      PG clock; a backdated row is stealable, a fresh one is not.
 *   3. Release ownership — DELETE matches the exact jsonb holder; a foreign
 *      release is a no-op.
 *
 * Rows are namespaced `e2e-lock-…` and deleted in afterAll — the locks table
 * is designed for this churn (TTL-steal semantics on transient rows).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { PgUnifiedStoreWriter } from '../PgUnifiedStoreWriter.js';

const E2E_ENABLED =
  process.env.ROOSYNC_E2E_PG === '1' && !!process.env.UNIFIED_STORE_PG_URL;

describe.skipIf(!E2E_ENABLED)('roosync_dashboard_locks e2e (#1240) — deux connexions PG réelles', () => {
  const url = process.env.UNIFIED_STORE_PG_URL!;
  // Deux writers = deux pools = deux connexions réellement distinctes.
  const writerA = new PgUnifiedStoreWriter({ connectionString: url });
  const writerB = new PgUnifiedStoreWriter({ connectionString: url });
  // Connexion admin : backdate TTL + cleanup (jamais via les writers, qui ne
  // savent qu'acquérir/stealer/relâcher).
  const raw = new Client({ connectionString: url });

  const KEY = `e2e-lock-${process.pid}-${Date.now()}`;
  const TTL_MS = 30_000;
  const holderA = JSON.stringify({ machineId: 'e2e-a', workspace: 'e2e', pid: 111, acquiredAt: new Date().toISOString() });
  const holderB = JSON.stringify({ machineId: 'e2e-b', workspace: 'e2e', pid: 222, acquiredAt: new Date().toISOString() });

  beforeAll(async () => {
    await raw.connect();
    const probe = await raw
      .query('SELECT 1 FROM roosync_dashboard_locks LIMIT 1')
      .catch(() => null);
    if (probe === null) {
      throw new Error(
        '[e2e] la table roosync_dashboard_locks est absente — appliquer la migration 009 avant ce test'
      );
    }
  });

  afterAll(async () => {
    await raw.query('DELETE FROM roosync_dashboard_locks WHERE lock_key = $1', [KEY]).catch(() => {});
    await raw.end();
    await writerA.close().catch(() => {});
    await writerB.close().catch(() => {});
  });

  async function currentHolder(): Promise<unknown> {
    const res = await raw.query('SELECT holder FROM roosync_dashboard_locks WHERE lock_key = $1', [KEY]);
    return res.rows[0]?.holder ?? null;
  }

  test('1. INSERT concurrent — A gagne, B lit held, le row garde le holder de A', async () => {
    const a = await writerA.tryAcquireRooSyncDashboardLock(KEY, holderA, TTL_MS);
    expect(a).toBe('acquired');

    const b = await writerB.tryAcquireRooSyncDashboardLock(KEY, holderB, TTL_MS);
    expect(b).toBe('held');

    const holder = await currentHolder();
    expect((holder as { machineId?: string })?.machineId).toBe('e2e-a');
  });

  test('2. vol par TTL — row backdaté volable, row frais non volable (horloge PG unique)', async () => {
    // A détient un lock FRAIS : B ne peut pas le voler malgré son TTL.
    const freshSteal = await writerB.tryAcquireRooSyncDashboardLock(KEY, holderB, TTL_MS);
    expect(freshSteal).toBe('held');

    // On backdate acquired_at au-delà du TTL (le détenteur "a crashé").
    await raw.query(
      `UPDATE roosync_dashboard_locks
       SET acquired_at = NOW() - interval '70 seconds'
       WHERE lock_key = $1`,
      [KEY]
    );
    const stolen = await writerB.tryAcquireRooSyncDashboardLock(KEY, holderB, TTL_MS);
    expect(stolen).toBe('acquired');

    const holder = await currentHolder();
    expect((holder as { machineId?: string })?.machineId).toBe('e2e-b');
  });

  test('3. release ownership — le release d\'un tiers est un no-op, le propriétaire efface le row', async () => {
    // A (tiers désormais — B a volé) tente de relâcher : row intact.
    await writerA.releaseRooSyncDashboardLock(KEY, holderA);
    expect(await currentHolder()).not.toBeNull();

    // B relâche SON lock : row parti.
    await writerB.releaseRooSyncDashboardLock(KEY, holderB);
    expect(await currentHolder()).toBeNull();
  });
});
