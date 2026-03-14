# Audit Report #694 - Conversation Tools Regression Audit

**Date:** 2026-03-14
**Auditor:** myia-po-2023 (Claude Code)
**Scope:** `src/tools/conversation/` (8 source files, ~20 test files)
**Methodology:** Search for "code mort jamais intégré = FONCTIONNALITÉ PERDUE à déterrer"

---

## Executive Summary

**RESULT: NO REGRESSION FOUND**

All consolidated tools properly preserve functionality through delegation to original handlers. The consolidation pattern is:
1. New unified MCP tool exposes single entry point
2. Legacy handlers are kept and called internally
3. All functionality preserved through action/type-based dispatch

---

## Consolidations Analyzed

### 1. CONS-X: conversation_browser (3 tools → 1)

**Created:** During consolidation cycle (exact commit TBD)
**Tools consolidated:**
- `list_conversations` → action="list"
- `task_browse` (tree/current) → action="tree", action="current"
- `view_conversation_tree` → action="view"
- `roosync_summarize` → action="summarize"

**Verification:** ✅ All handlers delegated properly
- Line 19: `import { handleTaskBrowse } from '../task/browse.js'`
- Line 20: `import { viewConversationTree } from '../view-conversation-tree.js'`
- Line 21: `import { handleRooSyncSummarize } from '../summary/roosync-summarize.tool.js'`
- Lines 30-120+: All parameters preserved for each action

**File exists:** `src/tools/conversation/conversation-browser.ts` ✅

### 2. CONS-9: Task Tools (4 tools → 2)

**Commit:** `2f1101e` (2026-02-02)
**Tools consolidated:**
- `get_task_tree` → `task_browse` (action="tree")
- `get_current_task` → `task_browse` (action="current")
- `export_task_tree_markdown` → `task_export` (action="markdown")
- `debug_task_parsing` → `task_export` (action="debug")

**Verification:** ✅ All legacy handlers preserved
- `src/tools/task/get-tree.tool.ts` ✅ EXISTS
- `src/tools/task/get-current-task.tool.ts` ✅ EXISTS
- `src/tools/task/export-tree-md.tool.ts` ✅ EXISTS
- `src/tools/task/debug-parsing.tool.ts` ✅ EXISTS

**Index.ts comment (lines 4-7):**
```typescript
/**
 * CONS-9: Consolidation 4→2 outils
 * - task_browse (actions: tree, current) remplace get_task_tree + get_current_task
 * - task_export (actions: markdown, debug) remplace export_task_tree_markdown + debug_task_parsing
 */
```

### 3. CONS-12: Summary Tools (3 tools → 1)

**Commit:** `edf01c1` (2026-02-01)
**Tools consolidated:**
- `generate_trace_summary` → `roosync_summarize` (type="trace")
- `generate_cluster_summary` → `roosync_summarize` (type="cluster")
- `get_conversation_synthesis` → `roosync_summarize` (type="synthesis")

**Verification:** ✅ All legacy handlers preserved
- `src/tools/summary/generate-trace-summary.tool.ts` ✅ EXISTS
- `src/tools/summary/generate-cluster-summary.tool.ts` ✅ EXISTS
- `src/tools/summary/get-conversation-synthesis.tool.ts` ✅ EXISTS

**Index.ts comment (lines 6-10):**
```typescript
 * - roosync_summarize : Outil unifié consolidé (CONS-12)
 *
 * CLEANUP-2: Legacy tools retirés (generate_trace_summary, generate_cluster_summary, get_conversation_synthesis)
 * Ces outils ont été remplacés par roosync_summarize (CONS-12) qui offre une API unifiée
```

### 4. CLEANUP-2: MCP Registry Cleanup

**Commit:** `7156c29` (2026-02-06)
**Action:** Removed 3 legacy summary tools from ALLOWED_TOOLS in MCP wrapper

**Note:** This only removed the tools from MCP exposure, NOT from the codebase. The handlers still exist and are called internally by `roosync_summarize`.

---

## Consolidation Summary

| Before (Consolidated) | After (Unified) | Status |
|----------------------|-----------------|--------|
| list_conversations | conversation_browser (action=list) | ✅ Delegated |
| task_browse (tree/current) | conversation_browser (action=tree/current) | ✅ Delegated |
| view_conversation_tree | conversation_browser (action=view) | ✅ Delegated |
| roosync_summarize | conversation_browser (action=summarize) | ✅ Delegated |
| get_task_tree | task_browse (action=tree) | ✅ Handler exists |
| get_current_task | task_browse (action=current) | ✅ Handler exists |
| export_task_tree_markdown | task_export (action=markdown) | ✅ Handler exists |
| debug_task_parsing | task_export (action=debug) | ✅ Handler exists |
| generate_trace_summary | roosync_summarize (type=trace) | ✅ Handler exists |
| generate_cluster_summary | roosync_summarize (type=cluster) | ✅ Handler exists |
| get_conversation_synthesis | roosync_summarize (type=synthesis) | ✅ Handler exists |

**Net tool count reduction:** 11 → 4 MCP tools exposed (all functionality preserved)

---

## Verification Method

1. **File inventory** - Listed all `.ts` files in `src/tools/conversation/`
2. **Git history analysis** - Found consolidation commits (CONS-9, CONS-12, CLEANUP-2)
3. **Code reading** - Verified consolidation pattern in each file
4. **Handler verification** - Confirmed all original handlers still exist

---

## Conclusion

**NO REGRESSION** - All deleted MCP tool registrations were part of intentional consolidations:
- **CONS-X** (conversation_browser): Multiple tools → 1 with action dispatch
- **CONS-9** (task tools): 4 tools → 2 with action dispatch
- **CONS-12** (summary): 3 tools → 1 with type dispatch

All functionality is preserved in the original handler files, which are called internally by the consolidated tools. The original tools were removed from MCP registry exposure but not from the codebase.

This is **proper consolidation**, not lost functionality.

---

## Recommendation

**CLOSE ISSUE #694** - No action required. The audit confirms proper consolidation with no lost functionality.

---

**Next:** Proceed to #695 (export/) or other remaining audits (#696-#701)
