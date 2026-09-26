-- Migration: 008_roosync_dashboard_retirement.sql
-- Issue: #3782 (fork retirement at the journal level — arbitration ai-01,
-- comment 5844675985, 2026-09-26)
--
-- Context: after a merge, the source key of a fork family used to be removed
-- from the journal by `DELETE FROM roosync_dashboards` — which cascades to
-- `roosync_dashboard_messages` (migrations/002) and DESTROYS the journal rows.
-- With `deleteSource:false` the journal was left entirely alone, so the fork
-- stayed readable and kept being fed by file-reading hosts (measured
-- 2026-09-26: `machine-myia-po-2025 (1)` still growing at J+2, 101.8%).
--
-- Decisions traced (arbitration):
--   D1: `deleteSource` governs ONLY the file. The journal retires the source
--       key in BOTH cases, via a MARK, never a DELETE (gel des purges — the
--       lines stay in base, the gesture is reversible).
--   D2: a mark names its target and its merge timestamp; lifting the mark
--       (`lifted_at`) restores the key readable with its original content.
--   D3: reads, listings and the fork-family detector ignore retired keys;
--       writes addressed to a retired key are redirected to the target.
--
-- Additive and idempotent — safe to re-run. The rows of
-- `roosync_dashboards` / `roosync_dashboard_messages` are NOT touched: a
-- retired key keeps its rows, only its visibility changes.

BEGIN;

CREATE TABLE IF NOT EXISTS roosync_dashboard_retirements (
  source_key TEXT PRIMARY KEY,             -- the retired key (fork or merged-away key)
  target_key TEXT NOT NULL,                -- where reads/writes are redirected
  retired_by TEXT NOT NULL,                -- 'machine:workspace' of the merge author
  retired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lifted_at  TIMESTAMPTZ                   -- NULL = active mark; set = key readable again
);

CREATE INDEX IF NOT EXISTS idx_roosync_retirements_target
  ON roosync_dashboard_retirements (target_key);

COMMIT;
