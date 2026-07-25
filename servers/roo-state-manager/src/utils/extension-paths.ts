/**
 * Centralized extension identity and path resolution.
 *
 * Supports both Roo Code (`rooveterinaryinc.roo-cline`) and Zoo-Code
 * (`zoocodeorganization.zoo-code`) via the `ROO_EXTENSION_ID` env-var override,
 * plus a filesystem probe (#2766 S2) so resolution works on Zoo-only hosts
 * where no env override is set.
 *
 * #2134 — Zoo-Code migration compatibility.
 * #2429 — Zoo-Code storage detection + source attribution.
 * #2766 S2 — Filesystem-aware resolution (probe which extension is installed).
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ── Extension identity ──────────────────────────────────────────────

/** Default publisher.extension ID for Roo Code. */
const DEFAULT_EXTENSION_ID = 'rooveterinaryinc.roo-cline';

/** Zoo-Code publisher.extension ID. */
const ZOO_CODE_EXTENSION_ID = 'zoocodeorganization.zoo-code';

/**
 * The active extension directory name under VS Code `globalStorage/`.
 * Override via `ROO_EXTENSION_ID` env-var (set to `zoocodeorganization.zoo-code` for Zoo-Code).
 */
export function getExtensionId(): string {
	return process.env.ROO_EXTENSION_ID || DEFAULT_EXTENSION_ID;
}

/** Whether we're running under Zoo-Code instead of Roo Code. */
export function isZooCode(): boolean {
	return getExtensionId() === ZOO_CODE_EXTENSION_ID;
}

// ── SQLite key ──────────────────────────────────────────────────────

/** Default SQLite ItemTable key in `state.vscdb` (case-sensitive). */
const DEFAULT_VSCDB_KEY = 'RooVeterinaryInc.roo-cline';

/** Zoo-Code SQLite ItemTable key (case-sensitive). */
const ZOO_CODE_VSCDB_KEY = 'ZooCodeOrganization.zoo-code';

export { DEFAULT_VSCDB_KEY, ZOO_CODE_VSCDB_KEY };

/**
 * The SQLite ItemTable key for the active extension.
 * Override via `ROO_VSCDB_KEY` env-var, or derived from extension ID.
 */
export function getVscdbKey(): string {
	if (process.env.ROO_VSCDB_KEY) return process.env.ROO_VSCDB_KEY;
	return isZooCode() ? ZOO_CODE_VSCDB_KEY : DEFAULT_VSCDB_KEY;
}

// ── Path helpers ────────────────────────────────────────────────────

/** Base path: `%APPDATA%/Code/User/globalStorage/<extensionId>/` */
export function getGlobalStoragePath(): string {
	const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
	return path.join(appdata, 'Code', 'User', 'globalStorage', getExtensionId());
}

/** Path: `...globalStorage/<extensionId>/settings/mcp_settings.json` */
export function getMcpSettingsPath(): string {
	return path.join(getGlobalStoragePath(), 'settings', 'mcp_settings.json');
}

/** Path: `...globalStorage/<extensionId>/settings/custom_modes.yaml` */
export function getCustomModesPath(): string {
	return path.join(getGlobalStoragePath(), 'settings', 'custom_modes.yaml');
}

/** Path: `...globalStorage/<extensionId>/tasks/` */
export function getTasksPath(): string {
	return path.join(getGlobalStoragePath(), 'tasks');
}

/** Path: `...globalStorage/<extensionId>/settings/` */
export function getSettingsPath(): string {
	return path.join(getGlobalStoragePath(), 'settings');
}

// ── Filesystem-aware resolution (#2766 S2) ──────────────────────────

/**
 * Private: resolve the VS Code `globalStorage/` root directory.
 * Shared by the #2766 S2 filesystem-aware helpers below (kept separate from
 * getGlobalStoragePath() to avoid changing the env-only contract of the
 * existing path helpers and their tests).
 */
function resolveGlobalStorageRoot(): string {
	const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
	return path.join(appdata, 'Code', 'User', 'globalStorage');
}

/**
 * #2766 S2 — Probe the filesystem for which VS Code extension globalStorage
 * is actually installed.
 *
 * The fleet is mid-migration Roo→Zoo. `getExtensionId()` is env-driven and
 * defaults to `roo-cline`, which ENOENTs on Zoo-only hosts (po-2026 native,
 * post-decommission ai-01/web1, and po-204 itself where Roo is uninstalled)
 * when no `ROO_EXTENSION_ID` override is set. This probe handles that case by
 * discovering the installed extension on disk.
 *
 * Preference when BOTH exist: Roo (preserves pre-fix behavior on dual-install
 * hosts — activity-based "which is running" detection is a follow-up, not
 * needed to fix the ENOENT). Only the Zoo-only case changes behavior.
 *
 * @returns The discovered extension ID, or `null` when neither globalStorage
 * exists (clean machine with no Roo/Zoo, or a test APPDATA).
 */
export function probeInstalledExtensionId(): string | null {
	try {
		const root = resolveGlobalStorageRoot();
		const rooExists = fs.existsSync(path.join(root, DEFAULT_EXTENSION_ID));
		if (rooExists) return DEFAULT_EXTENSION_ID;
		const zooExists = fs.existsSync(path.join(root, ZOO_CODE_EXTENSION_ID));
		if (zooExists) return ZOO_CODE_EXTENSION_ID;
		return null;
	} catch {
		return null;
	}
}

/**
 * #2766 S2 — Resolve the active extension ID with filesystem awareness.
 *
 * Priority: `ROO_EXTENSION_ID` env (explicit operator intent) > filesystem
 * probe (which extension is actually installed) > default (`roo-cline`).
 *
 * Use this instead of `getExtensionId()` when resolving real on-disk paths
 * that must work on Zoo-only hosts. `getExtensionId()` stays env-only for
 * back-compat with callers/tests that expect deterministic env-driven output.
 */
export function resolveActiveExtensionId(): string {
	if (process.env.ROO_EXTENSION_ID) return process.env.ROO_EXTENSION_ID;
	return probeInstalledExtensionId() || DEFAULT_EXTENSION_ID;
}

/**
 * #2766 S2 — Path to the active extension's `mcp_settings.json`, resolved via
 * filesystem probe. This is the path `roosync_mcp_management` must use so it
 * finds the Zoo-Code config on Zoo-only hosts instead of ENOENTing on roo-cline.
 *
 * Path: `...globalStorage/<resolveActiveExtensionId()>/settings/mcp_settings.json`
 */
export function getActiveMcpSettingsPath(): string {
	return path.join(resolveGlobalStorageRoot(), resolveActiveExtensionId(), 'settings', 'mcp_settings.json');
}

// ── Source detection from storage path (#2429) ─────────────────────────

/**
 * Determine the task source ('roo', 'zoo-code', or 'claude-code') from a
 * storage path. Used when attributing tasks discovered by RooStorageDetector
 * or scanClaudeSessions to the correct source system.
 *
 * @param storagePath - The globalStorage directory path or dataSource field
 * @returns The source identifier
 */
export function detectSourceFromPath(storagePath: string | undefined): 'roo' | 'zoo-code' | 'claude-code' {
	if (!storagePath) return 'roo';
	const normalized = storagePath.replace(/\\/g, '/').toLowerCase();
	if (normalized.includes('zoocodeorganization.zoo-code')) return 'zoo-code';
	if (normalized.includes('.claude/projects') || normalized.startsWith('claude-')) return 'claude-code';
	return 'roo';
}


