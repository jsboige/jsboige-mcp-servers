-- Migration: 012_roosync_store_meta.sql
-- Issue: #4131 (PostgreSQL cutover) — review ms#1540 BLOCKER
-- Author: claude on myia-ai-01, 27/10
--
-- Why: the cutover gates used to be opt-in env flags, and the proposed
-- "default ON" made the read side depend on a HUMAN flag — the review
-- rejected that: a seat that holds a PG URL but whose channel was never
-- backfilled would read an EMPTY mailbox, with no error, no breaker trip
-- and no GDrive fallback (under-show — the one failure this channel cannot
-- tolerate; scripts/backfill-roosync-channel.mjs:9-10 says so in its own
-- header).
--
-- The default must therefore be gated on DATA, not on a flag: the backfill
-- writes a completeness MARKER in PG when it finishes without errors, and
-- the default-on read resolves only when that marker is present. Absent
-- marker → the GDrive path stays in charge; one log line says why.
--
-- `roosync_store_meta` is a generic key/value side table (key, value,
-- updated_at). It carries the backfill markers:
--   channel_backfill_complete_at   — set by scripts/backfill-roosync-channel.mjs
--   dashboard_backfill_complete_at — set by scripts/backfill-roosync-dashboards.mjs
--
-- The GDrive tree is SHARED (`.shared-state/messages` — `inbox/` has no
-- recipient index, which is why the historical sweep was fleet-wide), so one
-- backfill of that tree covers the fleet: the marker is fleet-wide, not
-- per-seat.
--
-- Additive and idempotent, same style as 001-011 (plain CREATE TABLE IF NOT
-- EXISTS inside a transaction). Applying it twice is a no-op.
--
-- Rollback: DROP TABLE roosync_store_meta;  (the flags fall back to the
-- "marker absent" path — GDrive reads — which is the safe direction.)

BEGIN;

CREATE TABLE IF NOT EXISTS roosync_store_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
