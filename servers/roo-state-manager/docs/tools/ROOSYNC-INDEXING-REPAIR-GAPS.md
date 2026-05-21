# roosync_indexing — action: repair_gaps

**Tool:** `roosync_indexing`  
**Action:** `repair_gaps`  
**Issue:** [#2246](https://github.com/jsboige/roo-extensions/issues/2246)  
**Implemented:** 2026-05-20 (PR #467 submodule, PR #2292 parent)

---

## Purpose

One-shot forensic repair for the semantic index. Detects and re-indexes tasks that are:

1. **Missing from Qdrant** — task has content but `points_count == 0` in the vector store
2. **Stale** — `lastActivity > lastIndexedAt + 60s` (new content since last index run)

This is a diagnostic tool, not a recurring background process. Run it manually after incidents (Qdrant wipe, VHDX remount, MCP downtime) or on a rare cron.

---

## Usage

```typescript
// Dry-run (default) — shows what would be repaired without doing it
roosync_indexing({ action: "repair_gaps" })

// Dry-run with custom task limit
roosync_indexing({ action: "repair_gaps", max_repair_tasks: 100 })

// Execute repairs (actual re-indexing)
roosync_indexing({ action: "repair_gaps", dry_run: false, max_repair_tasks: 50 })
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `action` | `"repair_gaps"` | required | Must be `"repair_gaps"` |
| `dry_run` | `boolean` | `true` | If true, reports gaps without re-indexing |
| `max_repair_tasks` | `number` | `50` | Max tasks to scan per call (throttle) |

### Output (JSON)

```json
{
  "mode": "dry_run",
  "tasks_scanned": 50,
  "gaps_found": 3,
  "tasks_repaired": 0,
  "gaps": [
    {
      "task_id": "abc-123",
      "reason": "never_indexed",
      "lastActivity": "2026-05-19T10:00:00Z",
      "lastIndexedAt": null
    },
    {
      "task_id": "def-456",
      "reason": "stale",
      "lastActivity": "2026-05-20T09:00:00Z",
      "lastIndexedAt": "2026-05-19T08:00:00Z"
    }
  ]
}
```

---

## How it works

1. Lists tasks in the local skeleton cache (up to `max_repair_tasks`)
2. For each task, checks `points_count` via Qdrant filter `task_id == X`
3. Detects gaps: `points_count == 0` (never indexed) or `lastActivity > lastIndexedAt + 60s` (stale)
4. In `dry_run: false` mode, triggers re-embedding and upsert for detected gaps
5. Reports a JSON summary with gap count and repaired count

**No startup overhead** — event-driven design. The background indexer already handles the `lastActivity > lastIndexedAt` hook continuously; `repair_gaps` is the manual override for incidents.

---

## When to use

| Scenario | Action |
|----------|--------|
| After Qdrant collection wipe | `repair_gaps(dry_run: false, max_repair_tasks: 200)` × N until gaps_found = 0 |
| After VHDX remount (workspace down) | `repair_gaps(dry_run: true)` first, then execute |
| After MCP downtime (3+ days) | `repair_gaps(dry_run: false)` paginated |
| Routine audit | `repair_gaps(dry_run: true)` — report gaps without repairing |

---

## Related tools

- `roosync_indexing(action: "status")` — shows current indexing queue metrics
- `roosync_indexing(action: "diagnose")` — health check for Qdrant + cache coherence
- `roosync_indexing(action: "rebuild")` — rebuilds SQLite skeleton cache (not Qdrant vectors)
