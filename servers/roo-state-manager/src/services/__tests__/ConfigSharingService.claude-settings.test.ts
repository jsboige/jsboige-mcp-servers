/**
 * Tests ConfigSharingService — branche apply du target claude-settings (#3545)
 *
 * Contrats de sécurité :
 *  - un SNAPSHOT de comparaison n'est JAMAIS un payload d'apply (rejet explicite),
 *  - seul canon.json (clés allow-listées validées) est appliqué,
 *  - un canon invalide n'écrit rien.
 *
 * Tout sur répertoires FAKE : package publié factice dans tmpdir, settings
 * local pointé par CLAUDE_SETTINGS_PATH. Aucun chemin réel.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigSharingService } from '../ConfigSharingService';
import { IConfigService, IInventoryCollector } from '../../types/baseline';

vi.mock('../roosync/InventoryService', () => ({
  InventoryService: {
    getInstance: () => ({
      getMachineInventory: vi.fn().mockResolvedValue({
        paths: { rooExtensions: '/mock/roo-extensions', mcpSettings: '/mock/.claude.json' }
      })
    })
  }
}));

let fakeShared: string;
let fakeHome: string;
let fakeSettings: string;
let service: ConfigSharingService;
const savedSettingsEnv = process.env.CLAUDE_SETTINGS_PATH;

/** Construit un paquet publié factice {shared}/configs/test-machine/v1-… + latest.json. */
function publishPackage(files: Record<string, unknown>): { versionDir: string } {
  const versionDir = join(fakeShared, 'configs', 'test-machine', 'v1.0.0-2026-09-08T00-00-00Z');
  mkdirSync(versionDir, { recursive: true });
  const manifest = {
    version: '1.0.0',
    timestamp: '2026-09-08T00:00:00Z',
    author: 'test-machine',
    description: 'fixtures #3545',
    files: Object.keys(files).map(p => ({ path: p, hash: 'x', type: 'claude_settings', size: 10 })),
  };
  writeFileSync(join(versionDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  for (const [rel, content] of Object.entries(files)) {
    const p = join(versionDir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(content, null, 2), 'utf-8');
  }
  writeFileSync(join(fakeShared, 'configs', 'test-machine', 'latest.json'), JSON.stringify({
    version: '1.0.0', timestamp: '2026-09-08T00:00:00Z', path: versionDir, manifest,
  }), 'utf-8');
  return { versionDir };
}

beforeEach(() => {
  fakeShared = mkdtempSync(join(tmpdir(), 'css-apply-shared-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'css-apply-home-'));
  fakeSettings = join(fakeHome, 'settings.json');
  process.env.CLAUDE_SETTINGS_PATH = fakeSettings;

  const mockConfigService = {
    getSharedStatePath: vi.fn().mockReturnValue(fakeShared),
  } as any as IConfigService;
  const mockInventoryCollector = {
    collectInventory: vi.fn().mockResolvedValue({}),
  } as any as IInventoryCollector;
  service = new ConfigSharingService(mockConfigService, mockInventoryCollector);
});

afterEach(() => {
  if (savedSettingsEnv === undefined) delete process.env.CLAUDE_SETTINGS_PATH;
  else process.env.CLAUDE_SETTINGS_PATH = savedSettingsEnv;
  rmSync(fakeShared, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('applyConfig targets: ["claude-settings"]', () => {
  it('REJETTE un snapshot de comparaison comme payload d apply (#3545)', async () => {
    publishPackage({
      'claude-settings/claude-settings.json': {
        format: 1, state: 'ok', collectedAt: '2026-09-08T00:00:00Z', machineId: 'test-machine',
        harmonization: { 'env.ANTHROPIC_BASE_URL': 'https://relay.example' },
        maskedEnvKeys: {}, otherTopLevelKeys: [], projectionHash: 'x',
      },
    });
    const result = await service.applyConfig({
      version: 'latest',
      machineId: 'test-machine',
      targets: ['claude-settings'],
      backup: false,
    });

    expect(result.errors!.some(e => e.includes('SNAPSHOT de comparaison'))).toBe(true);
    expect(existsSync(fakeSettings)).toBe(false); // rien n'a été écrit
  });

  it('contrôle positif : canon.json valide appliqué (ensure-present) au settings local', async () => {
    publishPackage({
      'claude-settings/canon.json': {
        version: '2026.09.08-1',
        mode: 'ensure-present',
        keys: { 'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW': 280000 },
      },
    });
    // settings local existant : la clé absente est posée, l'existant préservé
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(fakeSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://local.example' }, permissions: { allow: [] } }), 'utf-8');

    const result = await service.applyConfig({
      version: 'latest',
      machineId: 'test-machine',
      targets: ['claude-settings'],
      backup: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.filesApplied).toBe(1);
    const after = JSON.parse(readFileSync(fakeSettings, 'utf-8'));
    expect(after.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe(280000);
    expect(after.env.ANTHROPIC_BASE_URL).toBe('https://local.example'); // préservé
    expect(after.permissions).toEqual({ allow: [] });                    // jamais touché
  });

  it('canon.json INVALIDE (chemin non allow-listé) : erreur, aucun write', async () => {
    publishPackage({
      'claude-settings/canon.json': {
        version: 'bad-1',
        mode: 'enforce-value',
        keys: { 'permissions.allow': ['Bash'] },
      },
    });
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(fakeSettings, JSON.stringify({ env: {} }), 'utf-8');

    const result = await service.applyConfig({
      version: 'latest',
      machineId: 'test-machine',
      targets: ['claude-settings'],
      backup: false,
    });

    expect(result.errors!.some(e => e.includes('canon.json invalide'))).toBe(true);
    expect(JSON.parse(readFileSync(fakeSettings, 'utf-8'))).toEqual({ env: {} });
  });

  it('dry-run avec canon valide : aucun write', async () => {
    publishPackage({
      'claude-settings/canon.json': {
        version: '2026.09.08-1',
        mode: 'ensure-present',
        keys: { 'env.ANTHROPIC_BASE_URL': 'https://relay.example' },
      },
    });
    const result = await service.applyConfig({
      version: 'latest',
      machineId: 'test-machine',
      targets: ['claude-settings'],
      dryRun: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.filesApplied).toBe(0);
    expect(existsSync(fakeSettings)).toBe(false);
  });

  it('collectConfig targets ["claude-settings"] produit un snapshot masqué dans le paquet', async () => {
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(fakeSettings, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://relay.example',
        ANTHROPIC_API_KEY: 'sk-ant-never-publish',
      },
      permissions: { allow: ['Bash'] },
    }), 'utf-8');

    const result = await service.collectConfig({ targets: ['claude-settings'] });
    expect(result.filesCount).toBe(1);
    const manifestFile = result.manifest.files[0];
    expect(manifestFile.path).toBe('claude-settings/claude-settings.json');
    expect(manifestFile.type).toBe('claude_settings');

    const snapshotRaw = readFileSync(join(result.packagePath, 'claude-settings', 'claude-settings.json'), 'utf-8');
    expect(snapshotRaw).not.toContain('sk-ant-never-publish');   // secret jamais publié
    expect(snapshotRaw).not.toContain('Bash');                    // permissions : nom seulement
    const snapshot = JSON.parse(snapshotRaw);
    expect(snapshot.state).toBe('ok');
    expect(snapshot.harmonization['env.ANTHROPIC_BASE_URL']).toBe('https://relay.example');
    expect(snapshot.maskedEnvKeys['ANTHROPIC_API_KEY']).toMatch(/^<set:len=\d+:sha256=[0-9a-f]{8}>$/);
    expect(snapshot.otherTopLevelKeys).toContain('permissions');

    rmSync(result.packagePath, { recursive: true, force: true });
  });
});
