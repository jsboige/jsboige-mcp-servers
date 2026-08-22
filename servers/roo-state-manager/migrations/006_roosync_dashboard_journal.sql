-- Migration: 006_roosync_dashboard_journal.sql
-- Issue: #3151 Phase C (RooSync canal sous PostgreSQL, Epic #2191)
--
-- The 002 schema created `roosync_dashboards` + `roosync_dashboard_messages`
-- with the Phase A shape: BIGSERIAL id, no per-message identity, no notion of
-- a message having been condensed away. Phase C makes the journal the source
-- of truth for the intercom section, which requires:
--
--   D1: `message_id` — the IntercomMessage id (`machine:workspace:ic-…`, #1363)
--       must round-trip: reply_to references (#1956) and the #2328 concurrent
--       append merge both key on it. Unique per dashboard → the sync writer is
--       idempotent (ON CONFLICT), like `roosync_messages.id` in Phase A.
--       NULL is allowed (hand-inserted legacy rows); Postgres unique indexes
--       treat NULLs as distinct, so those never conflict — the sync writer
--       skips NULL ids rather than duplicate them.
--   D2: `reply_to` + `acknowledged_at` — the #1956 metadata lines persisted in
--       the GDrive markdown; without columns the PG mirror loses them and the
--       read path cannot reconstruct full fidelity.
--   D3: `archived_at` — condensation on the GDrive path DELETES messages from
--       the markdown (they survive only as an LLM summary). In PG the journal
--       is append-mostly: condensed messages are stamped `archived_at` and
--       excluded from the active read set instead of destroyed. The full
--       history stays queryable — strictly better than the file format.
--
-- Additive and idempotent — safe to re-run.

BEGIN;

ALTER TABLE roosync_dashboard_messages
  ADD COLUMN IF NOT EXISTS message_id      TEXT,
  ADD COLUMN IF NOT EXISTS reply_to        TEXT,
  ADD COLUMN IF NOT EXISTS acknowledged_at JSONB,
  ADD COLUMN IF NOT EXISTS archived_at     TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_roosync_dash_msgs_msgid
  ON roosync_dashboard_messages (dashboard_key, message_id);

-- Active-set read path: one indexed range scan per dashboard read
-- (the 002 idx_roosync_dash_msgs index stays for full-history queries).
CREATE INDEX IF NOT EXISTS idx_roosync_dash_msgs_active
  ON roosync_dashboard_messages (dashboard_key, archived_at, created_at DESC);

COMMIT;
