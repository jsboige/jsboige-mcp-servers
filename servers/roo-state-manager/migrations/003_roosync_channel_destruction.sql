-- Migration: 003_roosync_channel_destruction.sql
-- Issue: #3151 (RooSync canal sous PostgreSQL) — Phase A.2
--
-- Pourquoi cette migration existe
-- ------------------------------------------------------------------
-- La Phase A copie le `body` d'un message et les octets d'une pièce jointe
-- dans PostgreSQL. Or `destroyMessage` — le mécanisme qui borne la durée de vie
-- d'un secret — n'écrivait que côté GDrive : il efface le body et supprime le
-- blob sur le partage, et laisse la copie PG intacte. Le commentaire de
-- `destroyMessage` avertissait déjà du motif exact (« le seul payload qui devait
-- être purgé était le seul à ne jamais l'être ») ; la Phase A le reconstruisait
-- une couche plus bas.
--
-- Les colonnes ci-dessous donnent à PG de quoi enregistrer la destruction avec
-- la même fidélité que le fichier GDrive : quand, et pour quelle raison.
-- La purge du contenu (body → '[DESTROYED]', suppression de la ligne
-- roosync_attachments) est portée par le code appelant.
--
-- D4 du schéma 002 prévoyait déjà `status`/`read_at`/`archived_at` — ils
-- existent, mais aucun chemin d'écriture ne les alimentait après l'INSERT.
-- Phase A.2 câble ces transitions ; aucune colonne supplémentaire n'est requise
-- pour elles.
--
-- Additif et idempotent : réexécutable sans effet de bord.

BEGIN;

ALTER TABLE roosync_messages
  ADD COLUMN IF NOT EXISTS destroyed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS destroyed_reason TEXT;

-- Balayage des messages détruits (audit « qu'est-ce qui a été purgé, et quand »).
-- Partiel : seules les lignes détruites sont indexées, le cas nominal ne paie rien.
CREATE INDEX IF NOT EXISTS idx_roosync_messages_destroyed
  ON roosync_messages (destroyed_at DESC)
  WHERE destroyed_at IS NOT NULL;

COMMIT;
