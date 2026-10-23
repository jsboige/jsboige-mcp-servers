/**
 * #2428 levier (a) — a date window older than the row cap must still return rows.
 *
 * WHY THIS FILE EXISTS (the bug, measured 2026-10-23): `listConversations` read
 * `ORDER BY last_ts DESC LIMIT 5000` with a WHERE on `machine_id` only, then the
 * caller filtered the window in JS (`unified-header-pipeline.ts`). The 5 000th
 * newest row sat at 2026-07-25T15:37:57Z, so ANY older window rendered 0 while
 * the store held the rows — 11 081 of 16 081 conversations were unreachable.
 *
 * The bite: before the fix this file's first test fails twice over — the window
 * returns the newest rows regardless, so `every last_ts within the window` is red.
 * The control test pins the other half of the requirement: an unfiltered call
 * keeps EXACTLY the previous cap.
 *
 * Real network, no pg mock. OPT-IN: `tests/setup/jest.setup.js` deletes
 * `UNIFIED_STORE_PG_URL` for every test on purpose (so a unit test cannot reach
 * the production store by accident). This file therefore needs an explicit
 * pointer at a `.env` holding the URL:
 *
 *   RSM_E2E_LIVE_STORE_ENV_FILE=<path to the server's .env> npx vitest run …
 *
 * Without the pointer the suite skips — CI stays green and no ambient
 * credentials are picked up. Read-only: SELECTs only, and the URL is never
 * printed.
 *
 * @module services/unified-store/__tests__/pg-list-conversations-date.e2e.test
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { PgUnifiedStoreReader } from '../PgUnifiedStoreReader.js';
import { DEFAULT_PG_LIST_LIMIT } from '../conversation-list-store.js';
import { resolveDateRangeBounds } from '../../../utils/date-filters.js';

// Opt-in only: the global test setup deletes the URL precisely so tests do not
// reach the store ambiently. Reading it back from the caller-supplied file keeps
// that guard intact for every other file.
const liveEnvFile = process.env.RSM_E2E_LIVE_STORE_ENV_FILE;
if (liveEnvFile) {
  dotenv.config({ path: liveEnvFile, quiet: true });
}

const PG_URL = liveEnvFile ? process.env.UNIFIED_STORE_PG_URL : undefined;
const storeSuite = PG_URL ? describe : describe.skip;

const TEST_TIMEOUT_MS = 60_000;

storeSuite('#2428 — PG listConversations honours the date window before the cap', () => {
  let reader: PgUnifiedStoreReader;

  beforeAll(async () => {
    reader = new PgUnifiedStoreReader({ connectionString: PG_URL!, connectionTimeoutMillis: 15_000 });
    await reader.init();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await reader?.close();
  }, TEST_TIMEOUT_MS);

  test('a May 2026 window returns rows, all inside it (was 0 before #2428)', async () => {
    // Same bounds the tool computes — end-of-day widening included, so SQL and
    // the in-memory filter agree on what "2026-05-31" means.
    const { start, end } = resolveDateRangeBounds('2026-05-01', '2026-05-31');
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();

    const rows = await reader.listConversations({
      startDate: start!,
      endDate: end!,
      limit: DEFAULT_PG_LIST_LIMIT,
    });

    // Positive: the window is reachable at all (pre-fix this was always 0 for
    // the caller's filter, and the raw tier returned out-of-window rows).
    expect(rows.length).toBeGreaterThan(0);
    // Biting: every row is inside the window. Pre-fix the tier returned the
    // newest 5 000 rows (all >= 2026-07-25) and this assertion goes red.
    for (const row of rows) {
      expect(row.last_ts).not.toBeNull();
      const ts = new Date(row.last_ts as unknown as string).getTime();
      expect(ts).toBeGreaterThanOrEqual(start!.getTime());
      expect(ts).toBeLessThanOrEqual(end!.getTime());
    }
  }, TEST_TIMEOUT_MS);

  test('control: without a window the cap is exactly the previous one', async () => {
    const rows = await reader.listConversations({ limit: DEFAULT_PG_LIST_LIMIT });

    // Same plafond qu'avant #2428 — the fix must not rotate the store's ordering
    // or cap. (The store holds > 5 000 conversations; that is what makes the
    // unfiltered read truncate, and what the windowed read must escape.)
    expect(rows.length).toBe(DEFAULT_PG_LIST_LIMIT);
    // And the newest row is newer than the window we just read, which is the
    // asymmetry the bug hid.
    const newest = rows[0]?.last_ts;
    expect(newest).toBeTruthy();
    expect(new Date(newest as unknown as string).getTime()).toBeGreaterThan(
      new Date('2026-06-01T00:00:00.000Z').getTime(),
    );
  }, TEST_TIMEOUT_MS);
});
