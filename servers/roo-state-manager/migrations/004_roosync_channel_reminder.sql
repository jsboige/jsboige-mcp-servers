-- #3151 Phase A.2 — expiry-reminder state for the RooSync channel.
--
-- `sendExpiryReminders` sets `reminder_sent` on the original message so each
-- auto-destruct message gets exactly one reminder. Without a PG mirror, a
-- Phase B reader would find the flag permanently unset and re-send it on every
-- sweep. Stored as a timestamp rather than a boolean, matching read_at /
-- archived_at / destroyed_at: `IS NOT NULL` is the flag, and the value says when.
--
-- Idempotent: safe to re-run.

BEGIN;

ALTER TABLE roosync_messages
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

COMMIT;
