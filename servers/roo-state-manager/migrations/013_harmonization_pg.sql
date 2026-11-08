-- Migration: 013_harmonization_pg.sql
-- Issue: #3544 (fleet harmonization campaign store — PG authority, G: mirror)
-- Author: claude on myia-web2, 08/11 — implementation of ai-01's decision
--         (issue comment 6710974383: "PG is the authority, and G: is the
--         fallback mirror").
--
-- Why: the campaign store lives only as files under
-- `<shared-state>/harmonization/campaigns/*.json` plus per-machine event
-- journals. GDrive is the measured SPOF of the coordination fabric (#4131),
-- and the 07/11 measurement showed the consequence in its purest form: the
-- campaign store was INVISIBLE to five seats out of six because they mount
-- the 28/10 tree while web2 mounts the 2025 shortcut — the "8/8 confirmed,
-- 0 drift" proof of `hc-claude-settings-2026.10.25-1` could only be read from
-- one seat. A store nobody can read proves nothing.
--
-- Two tables, same shape as the dashboard pair (`roosync_dashboards` +
-- `roosync_dashboard_messages`, migrations/002):
--
--   `harmonization_campaigns`     ← one row per campaign. The queryable
--                                   columns duplicate the cheap filters
--                                   (status, target, canon identity); the
--                                   `payload` column carries the FULL
--                                   campaign record, so a reader
--                                   reconstructs exactly what the organ
--                                   wrote (dispatches/reminders bookkeeping
--                                   included) without a schema bump every
--                                   time the bookkeeping grows.
--   `harmonization_confirmations` ← append-only journal, one row per LIVE
--                                   re-read that confirmed a seat. A claimed
--                                   hash never lands here: only the
--                                   `confirm` action writes, and only after
--                                   re-reading the seat's own file.
--
-- WRITE AUTHORITY — only the `roosync_harmonization` organ writes these
-- tables. No lane writes directly, not even a confirmation. The GDrive files
-- remain the write-through mirror while the rollout settles, so a seat
-- without a PG channel still has a fallback.
--
-- READ GATE — the default PG read is gated on DATA, not on a flag
-- (`pg-read-gates.ts`): the backfill writes the completeness marker
-- `harmonization_backfill_complete_at` in `roosync_store_meta`
-- (migrations/012) only after a full-scope run that finished without error.
-- A store that was never imported must present as "not found" so the caller
-- falls back to the file — never as an empty campaign.
--
-- Additive and idempotent, same style as 001-012 (plain CREATE ... IF NOT
-- EXISTS). Applying it twice is a no-op.
--
-- Rollback: DROP TABLE harmonization_confirmations, harmonization_campaigns;
-- (and DELETE FROM roosync_store_meta WHERE key = 'harmonization_backfill_complete_at';)
-- — the gates then fall back to the "marker absent" path, i.e. GDrive, which
-- is the safe direction.

BEGIN;

CREATE TABLE IF NOT EXISTS harmonization_campaigns (
  campaign_id   TEXT PRIMARY KEY,
  target_file   TEXT NOT NULL,
  canon_version TEXT NOT NULL,
  canon_hash    TEXT NOT NULL,
  canon_mode    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  rev           INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  close_reason  TEXT,
  fleet         JSONB NOT NULL DEFAULT '[]'::jsonb,
  exceptions    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The full HarmonizationCampaignRecord as written by the organ. Kept whole
  -- on purpose: dispatches/reminders are bookkeeping the organ owns and may
  -- extend, and a reader must reconstruct it byte-for-byte.
  payload       JSONB NOT NULL
);

-- `list` (active campaigns, newest first) and the drift sweep behind the
-- coordinator cadence both filter on status.
CREATE INDEX IF NOT EXISTS idx_harmonization_campaigns_status
  ON harmonization_campaigns (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS harmonization_confirmations (
  id            BIGSERIAL PRIMARY KEY,
  campaign_id   TEXT NOT NULL
                REFERENCES harmonization_campaigns (campaign_id) ON DELETE CASCADE,
  machine_id    TEXT NOT NULL,
  workspace     TEXT,
  confirmed_at  TIMESTAMPTZ NOT NULL,
  canon_hash    TEXT NOT NULL,
  observed_hash TEXT NOT NULL,
  -- Provenance of the confirmation. Only 'live-read' is written by the organ
  -- today; the column exists so a future source can never masquerade as one.
  source        TEXT NOT NULL DEFAULT 'live-read',
  -- The organ's immutable event id. UNIQUE per campaign: a re-run of the
  -- backfill replays the same journal files, and replay must be a no-op.
  event_id      TEXT NOT NULL,
  UNIQUE (campaign_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_harmonization_confirmations_campaign
  ON harmonization_confirmations (campaign_id, confirmed_at DESC);

COMMIT;
