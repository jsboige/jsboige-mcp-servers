-- 010_roosync_channel_read_by_workspace.sql
-- #3151 Phase B — per-workspace read state for machine-wide messages.
--
-- Machine-wide targets (`to: "myia-po-2024"`) track their read state per
-- workspace on GDrive (`read_by_workspace`, #3960: the global status stays
-- untouched so sibling workspaces of the machine keep seeing the message
-- unread). migrations/005 modeled only the per-machine broadcast tracking
-- (`read_by`), so a CHANNEL_READ_PG seat judged machine-wide rows by the raw
-- global `status` and re-surfaced every one of them as unread — the read-state
-- divergence observed on the ai-01 seat (02/10, #3151): inbox PG shows unread
-- forever, mark_read writes GDrive only, bulk reads the GDrive cache.
--
-- Same contract as `read_by`: whole-array replace, no per-reader append SQL.

ALTER TABLE roosync_messages
  ADD COLUMN IF NOT EXISTS read_by_workspace JSONB NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_roosync_messages_read_by_workspace
  ON roosync_messages USING GIN (read_by_workspace);
