-- Migration: 005_roosync_channel_read.sql
-- Issue: #3151 (RooSync canal sous PostgreSQL) — Phase B read path
--
-- Pourquoi cette migration existe
-- ------------------------------------------------------------------
-- La Phase B fait de PostgreSQL la source primaire de lecture de la
-- messagerie (inbox / message), GDrive restant le fallback. Deux champs
-- du Message GDrive n'avaient pas de colonne — les lectures PG ne
-- pouvaient donc pas restituer la pleine fidélité :
--
--   - `read_by` : tracking per-machine des lectures de broadcast (#629).
--     La Phase A.2 avait délibérément exclu les broadcasts du miroir
--     `status=read` précisément parce que cette colonne n'existait pas
--     (« Until Phase B models read_by »). La Phase B la modélise : un
--     broadcast reste `unread` en statut global et la lecture
--     per-machine se calcule depuis ce tableau, exactement comme GDrive.
--   - `reply_to` : cité par `getMessage` pour le threading.
--   - `options` : les champs de payload restants (auto_destruct,
--     destruct_after, destruct_after_read_by, expires_at,
--     acknowledged_at, metadata, reminder_sent) — jamais filtrés en SQL,
--     seulement restitués à la lecture du message complet.
--
-- Additif et idempotent : réexécutable sans effet de bord.

BEGIN;

ALTER TABLE roosync_messages
  ADD COLUMN IF NOT EXISTS reply_to TEXT,
  ADD COLUMN IF NOT EXISTS read_by  JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS options  JSONB NOT NULL DEFAULT '{}';

-- Accélère le filtre « ce broadcast a-t-il été lu par la machine M »
-- (contenance sur tableau JSONB) utilisé par la lecture mailbox.
CREATE INDEX IF NOT EXISTS idx_roosync_messages_read_by
  ON roosync_messages USING GIN (read_by);

COMMIT;
