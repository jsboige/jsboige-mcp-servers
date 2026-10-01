# Mock Parity Harness (#1320)

Adapted from claw-code's mock parity harness
(`rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs`): scripted
scenarios run against a deterministic in-memory filesystem, **diffed against
the same scenarios on the real filesystem**. The diff is the deliverable —
it proves the mock is a faithful stand-in, which is what lets CI script
GDrive-dependent storage behavior (dashboard read/write, message
send/receive) with zero external dependencies.

## Files

| File | Role |
|------|------|
| `in-memory-fs.ts` | In-memory fs: the exact `fs/promises`/`fs` surface the storage paths use, with Node-shaped errors (`ENOENT`, `EEXIST`...). Directories are implicit (a dir exists iff a file key lives under it) plus an explicit `dirs` set for `mkdir`'d roots. |
| `trace.ts` | Observable-effect snapshot (file tree under the shared root) + normalization (timestamps, generated ids, durations, pids, uuids) + comparison helpers. |
| `scenarios.ts` | The scripted scenarios. Add one by appending to `SCENARIOS`. |
| `../unit/tools/mock-parity.test.ts` | The runner: two runs (real → memory), deep-equal on trees + normalized outcomes, plus vacuity guards and semantic assertions. |

## Why parity, not just mocks

Mocking fs per-test verifies whatever the mock does. The parity runner
verifies the mock against **real Node fs behavior** on every CI run — when
the storage code changes semantics (e.g. tmp+copyFile instead of rename,
#3782), a stale mock fails loudly here instead of silently passing CI.

## Isolation rules (keep them when extending)

1. **Same logical `ROOSYNC_SHARED_PATH` for both runs** — only the transport
   differs. Never let the two backends see different paths.
2. **PG gates scrubbed** (`UNIFIED_STORE_*`, `PG_PRIMARY`, `DATABASE_URL`) —
   the GDrive file path is the parity surface; dual-write degrades to the
   Null writer by design.
3. **`vi.resetModules()` + dynamic re-import per run** — module singletons
   (MessageManager, circuit breakers) must not leak between runs.
4. The bridge state is `vi.hoisted` in the test file — it must stay OUTSIDE
   the resettable module graph.
5. **`promises` namespace override**: `buildSyncModule` overrides `fs.promises`
   too, because `import { promises as fs } from 'fs'` (MessageManager,
   cache-manager, server-helpers) bypasses a bare `fs/promises` mock. This
   was a real escape hatch found while building the harness.

## Known gaps (deliberate)

- **`.tmp` staging files are excluded from snapshots** — the writer unlinks
  them right after `copyFile`; a real-fs residue is Windows AV-lock noise,
  not mock drift.
- Exotic fs functions not in the enumerated surface (streams, `withFileTypes`
  readdir) still hit real fs in memory mode. If a scenario needs one,
  implement it in `in-memory-fs.ts` — the parity diff will validate it.
- `readdir` result order is sorted in memory mode (real NTFS also returns
  sorted; the storage code does regex scans and is order-insensitive).

## Normalization contract

`normalizeText` erases ONLY run-varying values: ISO timestamps, localized
timestamps (fr `dd/MM/yyyy HH:mm` — minute resolution, two runs can straddle
a boundary), generated message ids (`msg-*`, `ic-*`), snapshot-style ids,
uuids, pids, durations (`123ms` and `"totalMs": 123`). Anything semantic must
stay byte-identical across backends. If a new field drifts, decide first
whether it is run-varying (normalize it) or semantic (fix the mock).
