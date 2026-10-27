/**
 * PG READ gates — the default is gated on DATA, not on a human flag.
 *
 * @issue #4131 + review ms#1540 (BLOCKER + HIGH)
 *
 * What this suite pins:
 *   1. the default read resolves ON only when the backfill marker is present
 *      (a PG URL alone is NOT enough — an un-imported store would serve an
 *      empty mailbox: under-show);
 *   2. an explicit '1' still forces the read on (backward compatibility);
 *   3. an explicit '0' turns it off at CALL time (the emergency recipe, no
 *      restart);
 *   4. `UNIFIED_STORE_DUAL_WRITE=0` — the seat-wide kill-switch documented as
 *      "back to the old GDrive-only behaviour" — stops the READS too, even
 *      though the reader instance is built once per process (review ms#1540
 *      HIGH: the flag used to stop the writes only);
 *   5. flipping the env at runtime flips the decision (the flags are read at
 *      call time, never at import time).
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  isChannelReadPgEnabled,
  isChannelPgPrimaryEnabled,
  isDashboardReadPgEnabled,
  isDashboardPgPrimaryEnabled,
  isDualWriteExplicitlyOff,
} from '../pg-read-gates.js';
import { setBackfillMarkerState } from '../pg-backfill-marker.js';

const PG_URL = 'postgres://t:t@localhost:5432/x';

describe('PG read gates (#4131, review ms#1540)', () => {
  beforeEach(() => {
    delete process.env.UNIFIED_STORE_PG_URL;
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
    delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
    delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
    // A fresh 'absent' marker state (never 'unknown') so no gate call
    // triggers a live marker lookup against a non-existent store.
    setBackfillMarkerState('channel', 'absent');
    setBackfillMarkerState('dashboard', 'absent');
  });

  afterEach(() => {
    delete process.env.UNIFIED_STORE_PG_URL;
    delete process.env.UNIFIED_STORE_DUAL_WRITE;
    delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
    delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
    delete process.env.UNIFIED_STORE_DASHBOARD_PG_PRIMARY;
    setBackfillMarkerState('channel', 'absent');
    setBackfillMarkerState('dashboard', 'absent');
  });

  // ── 1 — the default is gated on DATA ───────────────────────────────

  test('PG URL alone does NOT open the default read (no marker ⇒ GDrive)', () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    expect(isChannelReadPgEnabled()).toBe(false);
    expect(isDashboardReadPgEnabled()).toBe(false);
  });

  test('PG URL + backfill marker ⇒ the default read opens', () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    setBackfillMarkerState('channel', 'complete');
    setBackfillMarkerState('dashboard', 'complete');
    expect(isChannelReadPgEnabled()).toBe(true);
    expect(isDashboardReadPgEnabled()).toBe(true);
  });

  test('the primary gate follows the same marker rule', () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    expect(isChannelPgPrimaryEnabled()).toBe(false);
    expect(isDashboardPgPrimaryEnabled()).toBe(false);
    setBackfillMarkerState('channel', 'complete');
    setBackfillMarkerState('dashboard', 'complete');
    expect(isChannelPgPrimaryEnabled()).toBe(true);
    expect(isDashboardPgPrimaryEnabled()).toBe(true);
  });

  test('no PG URL ⇒ every gate stays closed (a seat without PG sees no change)', () => {
    expect(isChannelReadPgEnabled()).toBe(false);
    expect(isChannelPgPrimaryEnabled()).toBe(false);
    expect(isDashboardReadPgEnabled()).toBe(false);
    expect(isDashboardPgPrimaryEnabled()).toBe(false);
  });

  // ── 2 — an explicit '1' still forces the read on ───────────────────

  test('an explicit 1 forces the read on even without a marker', () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    expect(isChannelReadPgEnabled()).toBe(true);
    expect(isDashboardReadPgEnabled()).toBe(true);
  });

  test('an explicit 1 on the PRIMARY flag implies the read', () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
    expect(isChannelReadPgEnabled()).toBe(true);
    expect(isChannelPgPrimaryEnabled()).toBe(true);
  });

  // ── 3 — an explicit '0' turns it off ───────────────────────────────

  test('an explicit 0 on the read flag closes the read', () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    setBackfillMarkerState('channel', 'complete');
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '0';
    expect(isChannelReadPgEnabled()).toBe(false);
  });

  test('an explicit 0 on the primary flag closes the primary but not the read', () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    setBackfillMarkerState('channel', 'complete');
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '0';
    expect(isChannelPgPrimaryEnabled()).toBe(false);
    // The operator closed the PRIMARY, not the READ: the read follows the
    // default (marker present ⇒ PG reads).
    expect(isChannelReadPgEnabled()).toBe(true);
  });

  test('an explicit PRIMARY wins over an explicit read kill-switch (a primary seat must read)', () => {
    // Historical precedence, preserved: the gate used to be
    // `!READ_PG && !PG_PRIMARY` — a PG_PRIMARY seat that did not read PG
    // would write into a store it never looks at (the under-show trap).
    // The emergency recipe therefore closes BOTH flags.
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    setBackfillMarkerState('channel', 'complete');
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '1';
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '0';
    expect(isChannelReadPgEnabled()).toBe(true);
    expect(isChannelPgPrimaryEnabled()).toBe(true);

    // The documented recipe closes both — then the read closes too.
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '0';
    expect(isChannelReadPgEnabled()).toBe(false);
  });

  // ── 4 — the DUAL_WRITE kill-switch stops the reads too ────────────

  test('UNIFIED_STORE_DUAL_WRITE=0 stops the PG READS, not only the writes', () => {
    // Review ms#1540 HIGH: the reader instance is built once per process, so
    // without this check the flag stopped the writes while the reads kept
    // hitting PG — and .env.example documents it as "back to the old
    // GDrive-only behaviour".
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    setBackfillMarkerState('channel', 'complete');
    setBackfillMarkerState('dashboard', 'complete');
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    expect(isChannelReadPgEnabled()).toBe(true);

    process.env.UNIFIED_STORE_DUAL_WRITE = '0';
    expect(isDualWriteExplicitlyOff()).toBe(true);
    expect(isChannelReadPgEnabled()).toBe(false);
    expect(isDashboardReadPgEnabled()).toBe(false);
    expect(isChannelPgPrimaryEnabled()).toBe(false);
    expect(isDashboardPgPrimaryEnabled()).toBe(false);
  });

  // ── 5 — the decision is taken at CALL time ─────────────────────────

  test('flipping the env at runtime flips the decision (no restart)', () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    setBackfillMarkerState('channel', 'complete');

    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '1';
    expect(isChannelReadPgEnabled()).toBe(true);

    // The emergency recipe, applied live on a running seat.
    process.env.UNIFIED_STORE_CHANNEL_READ_PG = '0';
    process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY = '0';
    expect(isChannelReadPgEnabled()).toBe(false);

    delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
    delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
    expect(isChannelReadPgEnabled()).toBe(true);
  });

  test('the marker state is read live: absent ⇒ off, complete ⇒ on', () => {
    process.env.UNIFIED_STORE_PG_URL = PG_URL;
    expect(isChannelReadPgEnabled()).toBe(false);
    setBackfillMarkerState('channel', 'complete');
    expect(isChannelReadPgEnabled()).toBe(true);
    setBackfillMarkerState('channel', 'absent');
    expect(isChannelReadPgEnabled()).toBe(false);
  });
});
