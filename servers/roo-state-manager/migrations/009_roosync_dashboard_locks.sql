-- 009 — #3782 locks-off-Drive: consultative cross-process lock table.
--
-- The .condense.lock / .append.lock files used to live in dashboards/ on the
-- GDrive store; under contention Drive re-parents them to the drive root (58
-- orphans measured, po-2027 26/09), making the lock invisible to peers and
-- littering the store. This table replaces the GDrive half of the lock: one
-- row per held key, atomic INSERT acquisition, TTL steal on the single PG
-- clock (no cross-machine skew), ownership-checked release.
--
-- Rows are transient lock state, not journal data: a clean release DELETEs,
-- a TTL steal overwrites. Nothing here is purged by anything else.
-- Additive and idempotent; hosts without the table fail-open to a
-- machine-local tmpdir lock (pre-existing semantics).

CREATE TABLE IF NOT EXISTS roosync_dashboard_locks (
    lock_key   TEXT PRIMARY KEY,
    holder     JSONB NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
