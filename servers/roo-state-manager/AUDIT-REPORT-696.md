# Audit Report #696 - Task/Search/Indexing Regression Audit

**Date:** 2026-03-14
**Auditor:** myia-po-2023 (Claude Code)
**Scope:** `src/tools/task/` + `src/tools/search/` + `src/tools/indexing/` (18 source files, ~26 test files)
**Methodology:** Search for "code mort jamais intégré = FONCTIONNALITÉ PERDUE à déterrer"

---

## Executive Summary

**RESULT: NO REGRESSION FOUND**

All three directories show proper consolidations with preserved functionality:
- **task/**: CONS-9 consolidation (4 → 2 tools) with all legacy handlers imported
- **search/**: CONS-11 consolidation (unified roosync_search) with semantic/text/diagnose actions
- **indexing/**: CONS-11 consolidation (unified roosync_indexing) with 6 actions

The deleted files (task-summarizer.ts, task-details-extractor.ts) were in `src/services/`, not in these directories, and were entirely commented-out GPT-4 prototypes with no functionality wired.

---

## Consolidations Analyzed

### 1. CONS-9: Task Tools Consolidation (4 → 2)

**Documentation:** Explicitly documented in `src/tools/task/index.ts` (lines 4-7)
```typescript
/**
 * CONS-9: Consolidation 4→2 outils
 * - task_browse (actions: tree, current) remplace get_task_tree + get_current_task
 * - task_export (actions: markdown, debug) remplace export_task_tree_markdown + debug_task_parsing
 */
```

**Tools consolidated:**
- `get_task_tree` → `task_browse` (action="tree")
- `get_current_task` → `task_browse` (action="current")
- `export_task_tree_markdown` → `task_export` (action="markdown")
- `debug_task_parsing` → `task_export` (action="debug")

**Verification:** ✅ All legacy handlers imported and called
- Line 13-14 in `browse.ts`: `import { handleGetTaskTree, GetTaskTreeArgs } from './get-tree.tool.js'`
- Line 14 in `browse.ts`: `import { getCurrentTaskTool } from './get-current-task.tool.js'`
- All parameters preserved for each action (lines 24-47)

**Legacy Implementation Engines (4 files) - KEEP as internal:**
1. `get-tree.tool.ts` - Used by browse.ts (action='tree')
2. `get-current-task.tool.ts` - Used by browse.ts (action='current')
3. `debug-parsing.tool.ts` - Used by export.ts (action='debug')
4. `export-tree-md.tool.ts` - Used by export.ts (action='markdown')

**Utility Files (3) - ACTIVE:**
- `format-hierarchical-tree.ts` - Tree formatting
- `format-ascii-tree.ts` - ASCII tree output
- `disk-scanner.ts` - Disk scanning utilities

---

### 2. CONS-11: Search Tools Consolidation

**Documentation:** Explicitly documented in `src/tools/search/roosync-search.tool.ts` (lines 1-10)
```typescript
/**
 * CONS-11: Consolidation Search/Indexing
 * - Remplace: search_tasks_by_content (semantic + text fallback + diagnose mode)
 * - Approche: Action-based dispatcher
 */
```

**Consolidated tool:**
- `roosync_search` (actions: semantic, text, diagnose)

**Verification:** ✅ Legacy handlers imported (lines 16-18 in roosync-search.tool.ts)
```typescript
import { searchTasksByContentTool, SearchTasksByContentArgs } from './search-semantic.tool.js';
import { handleSearchTasksSemanticFallback, SearchFallbackArgs } from './search-fallback.tool.js';
```

**All parameters preserved:**
- Lines 23-68: Complete parameter interface with #604 and #636 extensions
- `search_query`, `conversation_id`, `max_results`, `workspace` (original)
- `source`, `chunk_type`, `role`, `tool_name`, `has_errors`, `model` (#636 Phase 1)
- `start_date`, `end_date` (#636 Phase 2)
- `exclude_tool_results` (#636 Phase 3)

**Supporting Tools - ACTIVE:**
- `search-semantic.tool.ts` - Semantic search handler
- `search-fallback.tool.ts` - Fallback handler
- `search-codebase.tool.ts` - Codebase search (#452)

---

### 3. CONS-11: Indexing Tools Consolidation

**Documentation:** Explicitly documented in `src/tools/indexing/roosync-indexing.tool.ts` (lines 1-10)
```typescript
/**
 * CONS-11: Consolidation Search/Indexing
 * - Remplace: index_task_semantic, reset_qdrant_collection, rebuild_task_index, diagnose_semantic_index
 * - Approche: Action-based dispatcher
 */
```

**Consolidated tool:**
- `roosync_indexing` (actions: index, reset, rebuild, diagnose, archive, status)

**Verification:** ✅ Legacy handlers imported (lines 17-20 in roosync-indexing.tool.ts)
```typescript
import { indexTaskSemanticTool } from './index-task.tool.js';
import { resetQdrantCollectionTool } from './reset-collection.tool.js';
import { handleDiagnoseSemanticIndex } from './diagnose-index.tool.js';
```

**Actions mapping:**
- `index` → `indexTaskSemanticTool` (index a task in Qdrant)
- `reset` → `resetQdrantCollectionTool` (reset Qdrant collection)
- `rebuild` → Rebuild SQLite VS Code index
- `diagnose` → `handleDiagnoseSemanticIndex` (diagnostic of index)
- `archive` → Archive Roo tasks or Claude Code sessions to GDrive (#604)
- `status` → Background indexer status and metrics (#685)

**All parameters preserved:**
- Lines 25-55: Complete parameter interface
- `task_id`, `confirm`, `workspace_filter`, `max_tasks`, `dry_run` (original)
- `machine_id`, `claude_code_sessions`, `max_sessions`, `source` (#604 extensions)

---

## Deleted Files Analyzed

### commit `b087dd7` (2026-02-10) - Dead code removal

**Files deleted:**
1. `src/services/task-details-extractor.ts` (59 lines)
2. `src/services/task-summarizer.ts` (57 lines)

**Reason:** These files were entirely commented out (OpenAI GPT-4 prototypes) and never wired to any MCP tool. Summarization is handled by `roosync_summarize` (CONS-12).

**Location:** ⚠️ **IMPORTANT:** These files were in `src/services/`, NOT in the audited directories (task/, search/, indexing/).

**Functionality preserved:** ✅ Summarization is handled by `roosync_summarize` in `src/tools/summary/` (CONS-12 consolidation verified in #694).

---

## Consolidation Summary

| Directory | Tools Before | Tools After | Consolidation | Status |
|-----------|--------------|-------------|---------------|--------|
| task/ | 6 | 6 | CONS-9 (4→2) | ✅ Active |
| search/ | 5 | 5 | CONS-11 unified | ✅ Active |
| indexing/ | 5 | 5 | CONS-11 unified | ✅ Active |

**Net tool count:** No reduction in exposed MCP tools (all legacy tools still exported). The consolidation is internal (unified entry points with action-based dispatch).

---

## Verification Method

1. **File inventory** - Listed all `.ts` files in the three directories
2. **Code reading** - Verified consolidation documentation in each index.ts
3. **Handler verification** - Confirmed all legacy handlers imported by consolidated tools
4. **Git history analysis** - Found commit `b087dd7` deleting GPT-4 prototypes (outside scope)

---

## Conclusion

**NO REGRESSION** - All deleted code was either:
1. Properly consolidated into unified tools with action-based dispatch (CONS-9, CONS-11)
2. Entirely commented-out prototypes in a different directory (`src/services/`)

All functionality is preserved through the delegation pattern: consolidated MCP tools → legacy handlers → actual implementation.

---

## Recommendation

**CLOSE ISSUE #696** - No action required. The audit confirms proper consolidation with no lost functionality.

---

**Next:** Proceed to #697 (services/) or other remaining audits (#698-#701)
