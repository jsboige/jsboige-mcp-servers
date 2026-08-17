-- Migration: 002_roosync_channel.sql
-- Issue: #3151 (RooSync canal sous PostgreSQL, Epic #2191) — Phase A schema
-- Author: claude on myia-ai-01, GO user 2026-08-17
--
-- Decisions traced:
--   D1: scope messagerie + dashboards + journal intercom (user 17/08) ;
--       heartbeats/claims/inventory/baselines restent GDrive (hors scope).
--   D2: attachments en bytea PG (user 17/08) — pas de seuil hybride.
--   D3: id message = TEXT compatible msg-YYYYMMDDTHHMMSS-xxxxxx (stabilité IDs existants).
--   D4: statut unread/read/archived transactionnel (élimine les courses 174 ms
--       et la quarantaine #2306 des écritures fichier).
--   D5: indexes orientés lecture mailbox (to machine:workspace + status + date) —
--       les opérations deviennent des requêtes, plus des scans d'arbre (21,8 K fichiers).
--
-- Additif et idempotent : peut s'appliquer sur le store existant sans toucher
-- conversations/messages.

BEGIN;

CREATE TABLE IF NOT EXISTS roosync_messages (
  id              TEXT PRIMARY KEY,          -- msg-YYYYMMDDTHHMMSS-xxxxxx
  thread_id       TEXT,
  from_machine    TEXT NOT NULL,
  from_workspace  TEXT NOT NULL,
  to_machine      TEXT NOT NULL,
  to_workspace    TEXT NOT NULL,
  subject         TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  priority        TEXT NOT NULL DEFAULT 'MEDIUM',
  status          TEXT NOT NULL DEFAULT 'unread',  -- unread | read | archived
  tags            JSONB NOT NULL DEFAULT '[]',
  attachment_refs JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at         TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_roosync_messages_mailbox
  ON roosync_messages (to_machine, to_workspace, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_roosync_messages_from
  ON roosync_messages (from_machine, from_workspace, created_at DESC);

CREATE TABLE IF NOT EXISTS roosync_attachments (
  id         TEXT PRIMARY KEY,               -- uuid
  filename   TEXT NOT NULL,
  mime       TEXT,
  size       BIGINT NOT NULL,
  sha256     TEXT,
  payload    BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roosync_dashboards (
  key         TEXT PRIMARY KEY,              -- 'workspace-roo-extensions' | 'machine-myia-ai-01' | 'global'
  type        TEXT NOT NULL,                 -- global | machine | workspace
  machine_id  TEXT,
  workspace   TEXT,
  content     TEXT NOT NULL DEFAULT '',
  status_json JSONB,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version     BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS roosync_dashboard_messages (
  id             BIGSERIAL PRIMARY KEY,
  dashboard_key  TEXT NOT NULL REFERENCES roosync_dashboards(key) ON DELETE CASCADE,
  author_machine TEXT NOT NULL,
  author_workspace TEXT NOT NULL,
  content        TEXT NOT NULL,
  tags           JSONB NOT NULL DEFAULT '[]',
  team_stage     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_roosync_dash_msgs
  ON roosync_dashboard_messages (dashboard_key, created_at DESC);

COMMIT;
