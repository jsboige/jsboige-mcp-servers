/**
 * Centralized extension identity and path resolution.
 *
 * Supports both Roo Code (`rooveterinaryinc.roo-cline`) and Zoo-Code
 * (`zoocodeorganization.zoo-code`) via the `ROO_EXTENSION_ID` env-var override.
 *
 * #2134 — Zoo-Code migration compatibility.
 */

import * as path from 'path';
import * as os from 'os';

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


