-- Migration: 007_roosync_attachment_metadata.sql
-- Issue: #3151 (RooSync canal sous PostgreSQL, Epic #2191) — §7.5.2 attachments
--        PG-primaire read/write
-- Author: claude on myia-po-2023, 2026-09-18
--
-- The GDrive metadata.json of an attachment carries fields the Phase A bytea
-- mirror never shipped (uploader identity, message binding, original upload
-- timestamp). Reading attachments PG-first (#3151 §7.5.2) requires them in
-- `roosync_attachments`:
--   - getAttachmentMetadata / listAttachments must reconstruct AttachmentMetadata
--     verbatim, or the read path cannot serve PG rows (parity rule: a row with
--     NULL uploader metadata is treated as a miss → GDrive fallback);
--   - per-message listing bounds via message_id (index) instead of a full scan;
--   - uploaded_at preserves the original timestamp on backfill — created_at
--     would stamp the import date on historical attachments.
--
-- Additive and idempotent. Existing rows (pre-007 dual-write payloads) start
-- with NULL metadata: the read path treats them as misses (GDrive fallback,
-- the parity rule above) until the attachments backfill phase
-- (scripts/backfill-roosync-channel.mjs) upgrades them — its upsert fills ONLY
-- the NULL metadata columns and never touches an existing payload.

BEGIN;

ALTER TABLE roosync_attachments
  ADD COLUMN IF NOT EXISTS uploader_machine TEXT,
  ADD COLUMN IF NOT EXISTS uploader_workspace TEXT,
  ADD COLUMN IF NOT EXISTS message_id TEXT,
  ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_roosync_attachments_message
  ON roosync_attachments (message_id);

COMMIT;
