# MCP Debugging Guide — Roo Framework

**Source:** Former `get_mcp_best_practices` tool, converted to static reference.
**Based on:** SDDD stabilization sessions for 3 critical MCPs.

---

## Proven Debugging Patterns

### 1. Progressive Isolation
Reduce code progressively until you isolate the exact problem.
Minimal version → progressive additions → identify blocking point.
Example: 60s timeout even with immediate `return {}` = infrastructure problem.

### 2. Exception Wrapping
Try/catch with graceful fallback and detailed diagnostics.
Prevents complete MCP crashes.

### 3. Environment Diagnostic First
Always diagnose the environment before looking for logic bugs.
Tools: `read_vscode_logs`, `roosync_mcp_management(action: "manage", subAction: "read")`.

---

## Systematic Debugging Workflow

```bash
# 1. Initial diagnostic
roosync_mcp_management(action: "manage", subAction: "read")

# 2. Force reload after modification
roosync_mcp_management(action: "touch")

# 3. Progressive isolation if problem persists
# Minimal version → progressive additions → identify blocking point

# 4. Diagnostic logs
read_vscode_logs(filter: "error", lines: 50)
```

---

## Urgent Debugging Checklist

When an MCP stops responding:

- [ ] Force reload: `roosync_mcp_management(action: "touch")`
- [ ] Test connectivity with a simple tool call
- [ ] Check logs: `read_vscode_logs`
- [ ] Progressive isolation if timeout persists

---

## Common Errors

### TypeScript/Node.js
- **ENOENT errors:** Hardcoded incorrect paths
- **Module resolution:** Build not reflected, needs rebuild + restart

### Python
- **Import timeouts:** Heavy imports blocking MCP context
- **Subprocess conda:** Recurring 60s timeout pattern

### MCP Infrastructure
- **Persistent cache:** Modified code invisible without force reload
- **Timeout -32001:** Standard MCP error signature

---

## Essential MCP Configuration

### `watchPaths` — The Pillar of Hot-Reload
Declares files/directories whose change should trigger automatic MCP restart.
Example: `"watchPaths": ["d:/roo-extensions/mcps/internal/servers/roo-state-manager/build/index.js"]`
Without this, the MCP runs stale code after modifications.

### `cwd` — Stable Relative Paths
Defines the working directory for the MCP.
Example: `"options": { "cwd": "d:/roo-extensions/mcps/internal/servers/roo-state-manager" }`
Essential for MCPs using relative paths for files (logs, templates, etc.).

---

## Essential roo-state-manager Tools

| Tool | Primary Usage | When to Use |
|------|---------------|-------------|
| `roosync_mcp_management(action: "touch")` | Force reload all MCPs | After each code modification |
| `roosync_mcp_management(action: "rebuild")` | Build TypeScript + restart | Modified TypeScript MCPs |
| `read_vscode_logs` | System error diagnostics | Advanced debugging |
| `roosync_mcp_management(action: "manage")` | Configuration verification | Setup and diagnostic |

---

## Grounding for External Agents

Complete procedure for debugging a defective MCP:

1. Identify the MCP via `roosync_mcp_management(action: "manage", subAction: "read")`
2. Check logs via `read_vscode_logs`
3. Test minimal with Progressive Isolation
4. Force reload via `roosync_mcp_management(action: "touch")`
5. Rebuild if TypeScript via `roosync_mcp_management(action: "rebuild")`
6. Validate the fix with functional tests
