-- Migration: 011_roosync_messages_mailbox_live.sql
-- Issue: #4131 B15 (mailbox PG read path under load, Epic #4131 PG cutover)
-- Author: claude on myia-po-2024, GO dispatcher 23/10
--
-- Why: the mailbox read (`to_machine = $1 OR to_machine IN ('all','All')` plus
-- `status <> 'archived' AND destroyed_at IS NULL`) cannot use
-- idx_roosync_messages_mailbox (to_machine, to_workspace, status, created_at
-- DESC): the OR-shaped recipient clause plus the inequality on status degrade
-- every plan to a sequential scan — 57 671 rows / ~4.7 MB per read, ~2 200
-- reads/h on ai-01 (22/10: 723 connect timeouts + 189 statement timeouts).
-- On 24/10 the channel goes PG-only fleet-wide; a timed-out read becomes a
-- broken inbox, so the live-set query must be index-served.
--
-- Fix: two PARTIAL indexes whose predicate is EXACTLY the live-set predicate
-- of the reader (`status <> 'archived' AND destroyed_at IS NULL`, verbatim so
-- the planner proves implication) —
--   * mailbox: (to_machine, created_at DESC) — serves `to_machine = ANY($1)`
--     with the 2.5 K-row candidate sort replacing the 57 K-row seq scan;
--   * whole channel: (created_at DESC) — serves the recipient-blind pool
--     scan (#4302 cleanupExpiredMessages / sendExpiryReminders) as an ordered
--     index scan instead of a full-table sort.
--
-- Additive and idempotent, same style as 001-010 (plain CREATE INDEX). On a
-- LIVE host prefer the CONCURRENTLY variant below (no write lock during
-- build) — applied OUTSIDE a transaction block:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_roosync_messages_mailbox_live
--     ON roosync_messages (to_machine, created_at DESC)
--     WHERE status <> 'archived' AND destroyed_at IS NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_roosync_messages_channel_live
--     ON roosync_messages (created_at DESC)
--     WHERE status <> 'archived' AND destroyed_at IS NULL;
--
-- Rollback: DROP INDEX idx_roosync_messages_channel_live;
--           DROP INDEX idx_roosync_messages_mailbox_live;

BEGIN;

CREATE INDEX IF NOT EXISTS idx_roosync_messages_mailbox_live
  ON roosync_messages (to_machine, created_at DESC)
  WHERE status <> 'archived' AND destroyed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_roosync_messages_channel_live
  ON roosync_messages (created_at DESC)
  WHERE status <> 'archived' AND destroyed_at IS NULL;

COMMIT;
