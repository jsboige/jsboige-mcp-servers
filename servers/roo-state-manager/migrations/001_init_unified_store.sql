-- Migration: 001_init_unified_store.sql
-- Issue: #2426 (Postgres prototype, Epic #2191 unified store)
-- Author: claude on myia-po-2023, arbitrage ai-01 2026-05-30T05:11Z
-- Spec: ai-01 dispatch 2026-05-29 17:46Z + GO 2026-05-29 (Q1-Q7 user decisions)
--
-- Decisions traced:
--   Q1 OVERRIDE: single DB on ai-01, no replication
--   Q2: Docker Postgres 16 on ai-01 (DEV docker-compose for local validation)
--   Q3: 30-day backup retention (handled by ops, not in schema)
--   Q4: simplified failover (manual restart, no clustering)
--   Q5: message_id nullable (progressive: present for newer sources, NULL for legacy)
--   Q6: content duplicated Postgres + Qdrant (Q tradeoff: storage cost vs JOIN simplicity)
--   Q7: 30s throttle on GDrive replication
--
-- Architecture: hybrid permanent (ADR 010 v2.0 Scenario B)
--   - Qdrant: semantic ANN over content embeddings (existing)
--   - Postgres: relational truth (this migration) for tool_calls filters + 2-step read
--   - Read path: Qdrant ANN -> top-K task_id -> JOIN Postgres
--
-- CRITICAL: first_ts/last_ts MUST come from internal message ts, NOT mtime.
--   Mtime catastrophe context: 2026-05-28/29 Roo->Zoo destroyed globalStorage on
--   po-2023/po-2024 with stale mtimes that misled the prior ingestion. Use ts
--   from message payload only.

BEGIN;

CREATE TABLE IF NOT EXISTS conversations (
  task_id         TEXT PRIMARY KEY,
  machine_id      TEXT NOT NULL,
  harness         TEXT NOT NULL,
  workspace       TEXT,
  parent_task_id  TEXT,
  title           TEXT,
  first_ts        TIMESTAMPTZ,
  last_ts         TIMESTAMPTZ,
  msg_count       INTEGER NOT NULL DEFAULT 0,
  metadata        JSONB,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN conversations.harness IS 'Origin: roo | zoo | claude';
COMMENT ON COLUMN conversations.first_ts IS 'ts of first message (internal payload, NOT mtime)';
COMMENT ON COLUMN conversations.last_ts  IS 'ts of last  message (internal payload, NOT mtime)';
COMMENT ON COLUMN conversations.metadata IS 'Opaque source-specific fields (mode, model, etc.)';

CREATE TABLE IF NOT EXISTS messages (
  id           BIGSERIAL PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES conversations(task_id) ON DELETE CASCADE,
  message_id   TEXT,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT,
  tool_calls   JSONB,
  ts           TIMESTAMPTZ NOT NULL,
  CONSTRAINT messages_task_seq_unique UNIQUE (task_id, seq)
);

COMMENT ON COLUMN messages.message_id IS 'Optional stable id from source (nullable Q5 progressive adoption)';
COMMENT ON COLUMN messages.role       IS 'user | assistant | system | tool';
COMMENT ON COLUMN messages.content    IS 'Duplicated Postgres + Qdrant (Q6 decision)';
COMMENT ON COLUMN messages.tool_calls IS 'JSONB tool invocations (restores roosync_search #636 filters via GIN)';
COMMENT ON COLUMN messages.ts         IS 'Internal message ts (NOT mtime)';

CREATE INDEX IF NOT EXISTS idx_msg_task
  ON messages (task_id);

CREATE INDEX IF NOT EXISTS idx_msg_toolcalls
  ON messages USING GIN (tool_calls);

CREATE INDEX IF NOT EXISTS idx_conv_machine_harness
  ON conversations (machine_id, harness);

COMMIT;
