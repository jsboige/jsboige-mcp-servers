# Root Cause Analysis: Rogue RooSync Directory Creation

**Date:** 2026-03-12
**Issue:** Unit tests creating `C:\dev\roo-extensions\RooSync\shared\myia-po-2026\` instead of using temp paths
**Status:** FIXED

## Root Cause

A **user-level Windows environment variable** `ROOSYNC_SHARED_PATH` was set to:
```
C:\dev\roo-extensions\RooSync\shared\myia-po-2026
```

This environment variable was **taking precedence** over the `.env` file values because:
1. `mcp-wrapper.cjs` loads `.env` using `dotenv.config()`
2. By default, dotenv does **NOT override** existing environment variables (`override: false`)
3. The Windows environment variable is inherited by all Node.js processes

## Why This Happened

The MCP server and tests use the following loading order:
1. `tests/setup-env.ts` loads `.env.test` (temp paths)
2. `tests/setup-env.ts` loads `.env` with `override: false`
3. Windows environment variables are already set when Node.js starts
4. Result: Windows env var → `.env.test` → `.env` (first non-empty wins)

## The Fix

**Removed the Windows user-level environment variable:**
```powershell
[System.Environment]::SetEnvironmentVariable('ROOSYNC_SHARED_PATH', '', 'User')
```

After this change:
- `.env` file (`G:/Mon Drive/Synchronisation/RooSync/.shared-state`) is the single source of truth
- `.env.test` file (`C:/temp/test-roosync-shared-state`) is used for tests
- No more rogue directory creation in the repository

## Verification

To verify the fix:
1. Check Windows environment variable is removed: `[System.Environment]::GetEnvironmentVariable('ROOSYNC_SHARED_PATH', 'User')` → should be empty
2. Restart VS Code to pick up the new environment state
3. Run tests: `npx vitest run` should use temp paths only

## Files and Paths Involved

| Source | Path | Purpose |
|--------|------|---------|
| Windows ENV (removed) | `C:\dev\roo-extensions\RooSync\shared\myia-po-2026` | ❌ Wrong - was overriding |
| `.env` | `G:/Mon Drive/Synchronisation/RooSync/.shared-state` | ✅ Production GDrive path |
| `.env.test` | `C:/temp/test-roosync-shared-state` | ✅ Test temp path |

## Lessons Learned

1. **Environment variables trump .env files**: Always check for Windows/Unix environment variables when dotenv behavior is unexpected
2. **Single source of truth**: Use only `.env` files for configuration, never OS environment variables for app config
3. **Testing in isolation**: The test setup was correct - the issue was external to the code
4. **VS Code restart required**: Environment variable changes require VS Code restart to take effect

## Related Files

- `mcp-wrapper.cjs` - Loads `.env` at MCP server startup
- `tests/setup-env.ts` - Loads `.env.test` then `.env` for test runs
- `.env` - Production configuration (GDrive path)
- `.env.test` - Test configuration (temp path)
