/**
 * Tests pour extension-paths.ts
 * WS5 #2642 — Couverture des utilitaires non testés (Epic #2639)
 *
 * extension-paths centralise l'identité d'extension (Roo vs Zoo-Code) et la
 * résolution des chemins globalStorage. Avant ce fichier, seule getVscdbKey
 * était couverte — indirectement, via RooSettingsService-zoo.test. Les 8
 * autres exports (notamment detectSourceFromPath, classification 3-branches)
 * n'avaient aucun test direct. pertinent pour la migration Zoo (#2134/#2429).
 *
 * @module utils/__tests__/extension-paths
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
	getExtensionId,
	isZooCode,
	getVscdbKey,
	getGlobalStoragePath,
	getMcpSettingsPath,
	getCustomModesPath,
	getTasksPath,
	getSettingsPath,
	detectSourceFromPath,
	probeInstalledExtensionId,
	resolveActiveExtensionId,
	getActiveMcpSettingsPath,
	probeTaskExtensionId,
	getActiveTasksPath,
	resolveActiveVscdbKey,
	DEFAULT_VSCDB_KEY,
	ZOO_CODE_VSCDB_KEY,
} from '../extension-paths.js';

const ENV_KEYS = ['ROO_EXTENSION_ID', 'ROO_VSCDB_KEY', 'APPDATA'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

// ============================================================
// detectSourceFromPath — pure 3-way classification (#2429)
// ============================================================
describe('detectSourceFromPath', () => {
	test('returns "roo" for undefined', () => {
		expect(detectSourceFromPath(undefined)).toBe('roo');
	});

	test('returns "roo" for empty string', () => {
		expect(detectSourceFromPath('')).toBe('roo');
	});

	test('detects zoo-code from a forward-slash path', () => {
		expect(
			detectSourceFromPath('/home/u/.vscode/extensions/globalStorage/zoocodeorganization.zoo-code/tasks'),
		).toBe('zoo-code');
	});

	test('detects zoo-code from a backslash path (Windows)', () => {
		expect(
			detectSourceFromPath('C:\\Users\\u\\globalStorage\\zoocodeorganization.zoo-code\\tasks'),
		).toBe('zoo-code');
	});

	test('detects zoo-code case-insensitively', () => {
		expect(detectSourceFromPath('C:\\GlobalStorage\\ZooCodeOrganization.Zoo-Code')).toBe('zoo-code');
	});

	test('detects claude-code from a .claude/projects path', () => {
		expect(detectSourceFromPath('/home/u/.claude/projects/abc-123')).toBe('claude-code');
	});

	test('detects claude-code from a claude- prefix', () => {
		expect(detectSourceFromPath('claude-task-store')).toBe('claude-code');
	});

	test('returns "roo" for a plain roo globalStorage path', () => {
		expect(
			detectSourceFromPath('C:\\Users\\u\\globalStorage\\rooveterinaryinc.roo-cline\\tasks'),
		).toBe('roo');
	});

	test('returns "roo" for an unrelated path', () => {
		expect(detectSourceFromPath('/some/random/directory')).toBe('roo');
	});
});

// ============================================================
// Extension identity — getExtensionId / isZooCode (env-driven)
// ============================================================
describe('extension identity (getExtensionId / isZooCode)', () => {
	beforeEach(() => {
		delete process.env.ROO_EXTENSION_ID;
	});

	test('defaults to the Roo Code extension id', () => {
		expect(getExtensionId()).toBe('rooveterinaryinc.roo-cline');
		expect(isZooCode()).toBe(false);
	});

	test('ROO_EXTENSION_ID override switches to Zoo-Code', () => {
		process.env.ROO_EXTENSION_ID = 'zoocodeorganization.zoo-code';
		expect(getExtensionId()).toBe('zoocodeorganization.zoo-code');
		expect(isZooCode()).toBe(true);
	});

	test('ROO_EXTENSION_ID override with an unrelated value is neither Zoo nor default-id-gated', () => {
		process.env.ROO_EXTENSION_ID = 'some.other.extension';
		expect(getExtensionId()).toBe('some.other.extension');
		expect(isZooCode()).toBe(false);
	});
});

// ============================================================
// getVscdbKey — precedence: ROO_VSCDB_KEY > extension-derived
// ============================================================
describe('getVscdbKey', () => {
	beforeEach(() => {
		delete process.env.ROO_VSCDB_KEY;
		delete process.env.ROO_EXTENSION_ID;
	});

	test('defaults to the Roo SQLite key', () => {
		expect(getVscdbKey()).toBe(DEFAULT_VSCDB_KEY);
	});

	test('derives the Zoo SQLite key when the extension is Zoo-Code', () => {
		process.env.ROO_EXTENSION_ID = 'zoocodeorganization.zoo-code';
		expect(getVscdbKey()).toBe(ZOO_CODE_VSCDB_KEY);
	});

	test('ROO_VSCDB_KEY override takes precedence over extension derivation', () => {
		process.env.ROO_EXTENSION_ID = 'zoocodeorganization.zoo-code';
		process.env.ROO_VSCDB_KEY = 'Custom.Override.Key';
		expect(getVscdbKey()).toBe('Custom.Override.Key');
	});
});

// ============================================================
// Path helpers — globalStorage-relative resolution
// ============================================================
describe('path helpers', () => {
	beforeEach(() => {
		process.env.APPDATA = path.sep === '\\' ? 'C:\\fake-appdata' : '/tmp/fake-appdata';
		delete process.env.ROO_EXTENSION_ID;
	});

	test('getGlobalStoragePath ends with globalStorage/<extensionId>', () => {
		expect(getGlobalStoragePath().endsWith(path.join('globalStorage', 'rooveterinaryinc.roo-cline'))).toBe(true);
	});

	test('getMcpSettingsPath points to settings/mcp_settings.json', () => {
		expect(getMcpSettingsPath().endsWith(path.join('settings', 'mcp_settings.json'))).toBe(true);
	});

	test('getCustomModesPath points to settings/custom_modes.yaml', () => {
		expect(getCustomModesPath().endsWith(path.join('settings', 'custom_modes.yaml'))).toBe(true);
	});

	test('getTasksPath ends with tasks', () => {
		expect(getTasksPath().endsWith(path.join('globalStorage', 'rooveterinaryinc.roo-cline', 'tasks'))).toBe(true);
	});

	test('getSettingsPath ends with settings', () => {
		expect(getSettingsPath().endsWith(path.join('globalStorage', 'rooveterinaryinc.roo-cline', 'settings'))).toBe(true);
	});

	test('paths reflect the Zoo-Code extension id when overridden', () => {
		process.env.ROO_EXTENSION_ID = 'zoocodeorganization.zoo-code';
		expect(getGlobalStoragePath().endsWith(path.join('globalStorage', 'zoocodeorganization.zoo-code'))).toBe(true);
	});
});

// ============================================================
// #2766 S2 — Filesystem-aware resolution (probe / resolveActive / getActiveMcpSettingsPath)
// Covers the ENOENT regression on Zoo-only hosts (no Roo installed, no env override).
// ============================================================
describe('#2766 S2 — filesystem-aware resolution', () => {
	const ROO = 'rooveterinaryinc.roo-cline';
	const ZOO = 'zoocodeorganization.zoo-code';
	let tmpAppData: string;
	let globalStorageRoot: string;

	beforeEach(() => {
		delete process.env.ROO_EXTENSION_ID;
		// Real temp APPDATA so the probe's fs.existsSync is exercised against
		// controlled dir presence (not the host machine's real globalStorage).
		tmpAppData = path.join(os.tmpdir(), `ext-paths-probe-${process.pid}`);
		globalStorageRoot = path.join(tmpAppData, 'Code', 'User', 'globalStorage');
		fs.rmSync(tmpAppData, { recursive: true, force: true });
		fs.mkdirSync(globalStorageRoot, { recursive: true });
		process.env.APPDATA = tmpAppData;
	});

	afterEach(() => {
		fs.rmSync(tmpAppData, { recursive: true, force: true });
	});

	// #3006: the probe targets the settings/mcp_settings.json FILE. Helper writes
	// a real (empty-JSON) settings file so the probe's fs.existsSync matches a
	// genuine install, not just an orphaned globalStorage directory.
	function writeMcpSettings(extId: string): void {
		const settingsDir = path.join(globalStorageRoot, extId, 'settings');
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(path.join(settingsDir, 'mcp_settings.json'), '{}');
	}

	test('probeInstalledExtensionId returns null when neither is installed', () => {
		expect(probeInstalledExtensionId()).toBeNull();
	});

	test('probeInstalledExtensionId returns roo-cline when only roo-cline has settings', () => {
		writeMcpSettings(ROO);
		expect(probeInstalledExtensionId()).toBe(ROO);
	});

	test('probeInstalledExtensionId returns zoo-code when only zoo-code has settings (the ENOENT regression)', () => {
		writeMcpSettings(ZOO);
		expect(probeInstalledExtensionId()).toBe(ZOO);
	});

	test('probeInstalledExtensionId prefers roo-cline when both genuinely have settings (back-compat)', () => {
		writeMcpSettings(ROO);
		writeMcpSettings(ZOO);
		expect(probeInstalledExtensionId()).toBe(ROO);
	});

	// #3006 bite-test (the residual): a migrated host leaves the roo-cline
	// globalStorage as an EMPTY SHELL (orphaned dir, no settings file) while Zoo
	// carries the live config. A directory-based probe picked Roo and ENOENTed;
	// the file-based probe must skip the shell and resolve Zoo. RED on pre-fix
	// code (probe checked the directory → returned ROO).
	test('#3006 prefers zoo-code when roo-cline is an empty shell (dir present, no settings file)', () => {
		// Roo: orphaned directory only — no settings/mcp_settings.json inside.
		fs.mkdirSync(path.join(globalStorageRoot, ROO), { recursive: true });
		// Zoo: live config with the settings file.
		writeMcpSettings(ZOO);
		expect(probeInstalledExtensionId()).toBe(ZOO);
	});

	test('resolveActiveExtensionId: env override wins over filesystem probe', () => {
		fs.mkdirSync(path.join(globalStorageRoot, ZOO), { recursive: true });
		process.env.ROO_EXTENSION_ID = 'custom.override.ext';
		expect(resolveActiveExtensionId()).toBe('custom.override.ext');
	});

	test('resolveActiveExtensionId: probe wins over default on a zoo-only host', () => {
		writeMcpSettings(ZOO);
		expect(resolveActiveExtensionId()).toBe(ZOO);
	});

	test('resolveActiveExtensionId: falls back to default when neither installed', () => {
		expect(resolveActiveExtensionId()).toBe(ROO);
	});

	test('getActiveMcpSettingsPath resolves to zoo-code on a zoo-only host', () => {
		writeMcpSettings(ZOO);
		const resolved = getActiveMcpSettingsPath();
		expect(resolved).toContain(ZOO);
		expect(resolved.endsWith(path.join('settings', 'mcp_settings.json'))).toBe(true);
	});

	test('getActiveMcpSettingsPath does NOT resolve to roo-cline on a zoo-only host (regression guard)', () => {
		writeMcpSettings(ZOO);
		expect(getActiveMcpSettingsPath()).not.toContain(ROO);
	});
});

// ============================================================
// #2766 étape 2 — tasks/vscdb filesystem-aware resolution.
// Covers the rebuild-task-index ENOENT on Zoo-only hosts: the tool's
// tasks-dir + vscdb-key touchpoints must follow the tasks DIRECTORY probe
// (not the #3006 settings-file probe, not the env-only default).
// ============================================================
describe('#2766 étape 2 — tasks/vscdb filesystem-aware resolution', () => {
	const ROO = 'rooveterinaryinc.roo-cline';
	const ZOO = 'zoocodeorganization.zoo-code';
	let tmpAppData: string;
	let globalStorageRoot: string;

	beforeEach(() => {
		delete process.env.ROO_EXTENSION_ID;
		delete process.env.ROO_VSCDB_KEY;
		tmpAppData = path.join(os.tmpdir(), `ext-paths-tasks-${process.pid}`);
		globalStorageRoot = path.join(tmpAppData, 'Code', 'User', 'globalStorage');
		fs.rmSync(tmpAppData, { recursive: true, force: true });
		fs.mkdirSync(globalStorageRoot, { recursive: true });
		process.env.APPDATA = tmpAppData;
	});

	afterEach(() => {
		fs.rmSync(tmpAppData, { recursive: true, force: true });
	});

	function writeTasksDir(extId: string): void {
		fs.mkdirSync(path.join(globalStorageRoot, extId, 'tasks'), { recursive: true });
	}

	function writeMcpSettings(extId: string): void {
		const settingsDir = path.join(globalStorageRoot, extId, 'settings');
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(path.join(settingsDir, 'mcp_settings.json'), '{}');
	}

	test('probeTaskExtensionId returns null when neither tasks dir exists', () => {
		expect(probeTaskExtensionId()).toBeNull();
	});

	test('probeTaskExtensionId returns zoo-code on a zoo-only host (the ENOENT regression)', () => {
		writeTasksDir(ZOO);
		expect(probeTaskExtensionId()).toBe(ZOO);
	});

	test('probeTaskExtensionId returns roo-cline when only roo-cline has tasks', () => {
		writeTasksDir(ROO);
		expect(probeTaskExtensionId()).toBe(ROO);
	});

	test('probeTaskExtensionId prefers roo-cline when both have tasks (back-compat)', () => {
		writeTasksDir(ROO);
		writeTasksDir(ZOO);
		expect(probeTaskExtensionId()).toBe(ROO);
	});

	test('probeTaskExtensionId can diverge from the settings probe (stale roo tasks shell, live zoo settings)', () => {
		// Migrated host: roo-cline keeps a leftover tasks dir, Zoo carries the
		// live config. Each probe answers for its own touchpoint — documented,
		// intentional divergence (#3006 rationale applied to tasks).
		writeTasksDir(ROO);
		writeMcpSettings(ZOO);
		expect(probeTaskExtensionId()).toBe(ROO);
		expect(probeInstalledExtensionId()).toBe(ZOO);
	});

	test('getActiveTasksPath resolves to zoo-code tasks on a zoo-only host', () => {
		writeTasksDir(ZOO);
		const resolved = getActiveTasksPath();
		expect(resolved).toContain(ZOO);
		expect(resolved.endsWith(path.join('globalStorage', ZOO, 'tasks'))).toBe(true);
	});

	test('getActiveTasksPath: ROO_EXTENSION_ID env wins over the filesystem probe', () => {
		writeTasksDir(ROO);
		process.env.ROO_EXTENSION_ID = 'custom.override.ext';
		expect(getActiveTasksPath()).toContain('custom.override.ext');
	});

	test('getActiveTasksPath falls back to the settings probe when no tasks dir exists', () => {
		// No tasks anywhere yet, but Zoo settings exist → resolve Zoo (its
		// tasks path will ENOENT truthfully) instead of the roo-cline default.
		writeMcpSettings(ZOO);
		expect(getActiveTasksPath()).toContain(ZOO);
	});

	test('resolveActiveVscdbKey derives the Zoo key on a zoo-only host', () => {
		writeTasksDir(ZOO);
		expect(resolveActiveVscdbKey()).toBe(ZOO_CODE_VSCDB_KEY);
	});

	test('resolveActiveVscdbKey keeps the Roo key when roo tasks exist', () => {
		writeTasksDir(ROO);
		expect(resolveActiveVscdbKey()).toBe(DEFAULT_VSCDB_KEY);
	});

	test('resolveActiveVscdbKey: ROO_VSCDB_KEY env wins over the probe', () => {
		writeTasksDir(ZOO);
		process.env.ROO_VSCDB_KEY = 'Custom.Override.Key';
		expect(resolveActiveVscdbKey()).toBe('Custom.Override.Key');
	});

	test('resolveActiveVscdbKey stays consistent with getActiveTasksPath (same probe chain)', () => {
		writeTasksDir(ZOO);
		const isZooPath = getActiveTasksPath().includes(ZOO);
		const isZooKey = resolveActiveVscdbKey() === ZOO_CODE_VSCDB_KEY;
		expect(isZooPath).toBe(isZooKey);
	});
});
