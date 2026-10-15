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
 * post-decommission ai-01/web1, and po-2024 itself where Roo is uninstalled)
 * when no `ROO_EXTENSION_ID` override is set. This probe handles that case by
 * discovering the installed extension on disk.
 *
 * Preference when BOTH exist: Roo (preserves pre-fix behavior on dual-install
 * hosts — activity-based "which is running" detection is a follow-up, not
 * needed to fix the ENOENT). Only the Zoo-only case changes behavior.
 *
 * #3006 — The probe targets the `settings/mcp_settings.json` FILE, not the
 * extension directory. On a migrated host the roo-cline globalStorage survives
 * as an empty shell (leftover conversations, no settings file), and a
 * directory-based probe picked Roo → ENOENT on the missing file even though
 * Zoo was the live config. Probing the file makes the shell invisible: Zoo
 * (which carries the file) wins. A genuine dual-install (both files present)
 * still prefers Roo — back-compat preserved. The caller reads the file the
 * probe already confirmed exists, so there is no new ENOENT path.
 *
 * @returns The discovered extension ID, or `null` when neither settings file
 * exists (clean machine with no Roo/Zoo config, or a test APPDATA).
 */
export function probeInstalledExtensionId(): string | null {
	try {
		const root = resolveGlobalStorageRoot();
		const rooSettings = path.join(root, DEFAULT_EXTENSION_ID, 'settings', 'mcp_settings.json');
		if (fs.existsSync(rooSettings)) return DEFAULT_EXTENSION_ID;
		const zooSettings = path.join(root, ZOO_CODE_EXTENSION_ID, 'settings', 'mcp_settings.json');
		if (fs.existsSync(zooSettings)) return ZOO_CODE_EXTENSION_ID;
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
 * #3006 — When `targetExtension` is explicitly provided ('roo' or 'zoo'), it
 * overrides the filesystem probe. This fixes dual-install machines where the
 * probe picks Roo (preference) but the caller needs the Zoo config — the exact
 * condition on migrated hosts where the roo-cline globalStorage still exists
 * (with leftover data) but is no longer the active extension.
 *
 * Path: `...globalStorage/<extensionId>/settings/mcp_settings.json`
 */
export function getActiveMcpSettingsPath(targetExtension?: 'roo' | 'zoo'): string {
	const extensionId = targetExtension === 'zoo' ? ZOO_CODE_EXTENSION_ID
		: targetExtension === 'roo' ? DEFAULT_EXTENSION_ID
		: resolveActiveExtensionId();
	return path.join(resolveGlobalStorageRoot(), extensionId, 'settings', 'mcp_settings.json');
}

// ── Tasks/vscdb filesystem-aware resolution (#2766 étape 2) ────────

/**
 * #2766 étape 2 — Probe which extension's `tasks/` directory exists on disk.
 *
 * Companion to `probeInstalledExtensionId()` with a probe target matched to
 * what the caller reads (#3006 rationale applied to the tasks touchpoint):
 * mcp-management reads the settings FILE so it probes that file;
 * rebuild-task-index reads the tasks DIRECTORY so it probes that directory.
 * On a host mid-migration the two probes can legitimately diverge (stale
 * roo-cline tasks shell with no settings, or Zoo settings with no tasks yet).
 *
 * Preference when BOTH tasks directories exist: Roo (preserves pre-fix
 * behavior on dual-install hosts, same rationale as #2766 S2).
 *
 * @returns The discovered extension ID, or `null` when neither tasks
 * directory exists (no task history yet, or a test APPDATA).
 */
export function probeTaskExtensionId(): string | null {
	try {
		const root = resolveGlobalStorageRoot();
		if (fs.existsSync(path.join(root, DEFAULT_EXTENSION_ID, 'tasks'))) return DEFAULT_EXTENSION_ID;
		if (fs.existsSync(path.join(root, ZOO_CODE_EXTENSION_ID, 'tasks'))) return ZOO_CODE_EXTENSION_ID;
		return null;
	} catch {
		return null;
	}
}

/**
 * Resolve the extension that owns the task history. Priority: `ROO_EXTENSION_ID`
 * env (explicit operator intent) > tasks-dir probe > the #3006 settings probe
 * (better-than-default guess when no tasks directory exists yet). Shared by
 * `getActiveTasksPath()` and `resolveActiveVscdbKey()` so one rebuild
 * invocation addresses the SAME extension on both touchpoints (tasks dir and
 * SQLite key).
 */
function resolveTaskExtensionId(): string {
	return process.env.ROO_EXTENSION_ID || probeTaskExtensionId() || resolveActiveExtensionId();
}

/**
 * #2766 étape 2 — Path to the active extension's `tasks/` directory, resolved
 * via filesystem probe. `getTasksPath()` stays env-only (back-compat contract
 * with its tests); this is the variant rebuild-task-index must use so it
 * finds Zoo tasks on Zoo-only hosts instead of ENOENTing on the roo-cline
 * default.
 *
 * Path: `...globalStorage/<extensionId>/tasks`
 */
export function getActiveTasksPath(): string {
	return path.join(resolveGlobalStorageRoot(), resolveTaskExtensionId(), 'tasks');
}

/**
 * #2766 étape 2 — The SQLite ItemTable key matching the task-history owner,
 * with the same probe chain as `getActiveTasksPath()`. `getVscdbKey()` stays
 * env-only; rebuild-task-index uses this so the Zoo key is read (and written
 * back) on Zoo hosts instead of silently addressing the roo-cline key.
 */
export function resolveActiveVscdbKey(): string {
	if (process.env.ROO_VSCDB_KEY) return process.env.ROO_VSCDB_KEY;
	return resolveTaskExtensionId() === ZOO_CODE_EXTENSION_ID ? ZOO_CODE_VSCDB_KEY : DEFAULT_VSCDB_KEY;
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


