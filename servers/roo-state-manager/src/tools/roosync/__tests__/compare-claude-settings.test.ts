/**
 * Tests compare_config(granularity: "claude-settings") — #3545
 *
 * Vérifie les deux trous mesurés de l'issue :
 *  1. La cible est couverte : ~/.claude/settings.json comparé (live vs snapshot
 *     publié), secrets jamais exposés, exemptés de campagne honorés.
 *  2. Plus de diffs fantômes : un côté sans snapshot valide => statut
 *     « non couvert » (UN diff), jamais N diffs present_absent qui ne mesurent
 *     rien. Discrimination missing / valid-empty / invalid / stale.
 *
 * Mock minimal : RooSyncService (getConfig/loadDashboard). FS réel sur des
 * répertoires FAKE (tmpdir) — snapshots + settings factices, jamais les vrais.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { mockGetConfig, mockLoadDashboard } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockLoadDashboard: vi.fn(),
}));

vi.mock('../../../services/RooSyncService.js', () => ({
  getRooSyncService: vi.fn(async () => ({
    getConfig: mockGetConfig,
    loadDashboard: mockLoadDashboard,
  })),
  RooSyncServiceError: class extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'RooSyncServiceError';
      this.code = code;
    }
  },
}));

import { CompareConfigArgsSchema, roosyncCompareConfig } from '../compare-config.js';
import { redactValue } from '../../../services/ClaudeSettingsService.js';

let fakeShared: string;
let fakeHome: string;
let fakeSettings: string;
const LOCAL = 'local-machine';
const REMOTE = 'remote-machine';
const savedEnv: Record<string, string | undefined> = {};

function writeLocalSettings(content: unknown): void {
  mkdirSync(join(fakeSettings, '..'), { recursive: true });
  writeFileSync(fakeSettings, JSON.stringify(content, null, 2), 'utf-8');
}

/** Publie un snapshot claude-settings pour REMOTE dans le faux store partagé. */
function publishRemoteSnapshot(
  harmonization: Record<string, unknown>,
  opts: { collectedAt?: string; state?: string; error?: string } = {}
): void {
  const dir = join(fakeShared, 'configs', REMOTE, 'claude-settings');
  mkdirSync(dir, { recursive: true });
  const snapshot = {
    format: 1,
    state: opts.state ?? 'ok',
    collectedAt: opts.collectedAt ?? '2026-09-08T10:00:00Z',
    machineId: REMOTE,
    harmonization,
    maskedEnvKeys: {},
    otherTopLevelKeys: [],
    projectionHash: 'unused-by-compare',
    error: opts.error,
  };
  writeFileSync(join(dir, 'claude-settings.json'), JSON.stringify(snapshot), 'utf-8');
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  fakeShared = mkdtempSync(join(tmpdir(), 'cmp-claude-settings-shared-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'cmp-claude-settings-home-'));
  fakeSettings = join(fakeHome, 'settings.json');
  for (const k of ['ROOSYNC_SHARED_PATH', 'CLAUDE_SETTINGS_PATH', 'CLAUDE_SETTINGS_STALE_WARN_DAYS', 'CLAUDE_SETTINGS_STALE_HARD_DAYS']) {
    savedEnv[k] = process.env[k];
  }
  process.env.ROOSYNC_SHARED_PATH = fakeShared;
  process.env.CLAUDE_SETTINGS_PATH = fakeSettings;
  delete process.env.CLAUDE_SETTINGS_STALE_WARN_DAYS;
  delete process.env.CLAUDE_SETTINGS_STALE_HARD_DAYS;
  mockGetConfig.mockReturnValue({ machineId: LOCAL, sharedStatePath: fakeShared });
  // Dashboard injoignable => checkRosterConsistency skip silencieux (catch interne)
  // => résultats déterministes, sans diffs roster parasites.
  mockLoadDashboard.mockRejectedValue(new Error('dashboard unavailable in test'));
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(fakeShared, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('Schema', () => {
  test('granularity claude-settings acceptée', () => {
    expect(CompareConfigArgsSchema.parse({ granularity: 'claude-settings' }).granularity).toBe('claude-settings');
  });
});

describe('Garde de couverture — jamais de diffs fantômes', () => {
  test('cible SANS snapshot => UN diff « non couvert », pas 80 present_absent (trou #1 de l issue)', async () => {
    writeLocalSettings({
      env: {
        ANTHROPIC_BASE_URL: 'https://relay.example',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: 280000,
      },
    });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });

    expect(result.granularity).toBe('claude-settings');
    const coverage = result.differences.filter(d => d.path.startsWith('claude-settings.coverage'));
    expect(coverage).toHaveLength(1);
    expect(coverage[0].severity).toBe('WARNING');
    expect(coverage[0].description).toMatch(/NON COUVERT/);
    // AUCUN diff de clé — le trou mesuré 08/09 (80/80 present_absent) est comblé
    expect(result.differences.filter(d => d.path.startsWith('claude-settings.env'))).toHaveLength(0);
    expect(result.summary.total).toBe(1);
  });

  test('les deux côtés non couverts => un seul statut', async () => {
    // source locale ILLISIBLE (couverture invalid) ; cible : pas de snapshot.
    // NB : un fichier local ABSENT est une observation couverte (état mesuré) —
    // pour le statut « both » il faut deux côtés réellement non couvrables.
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(fakeSettings, '{broken', 'utf-8');
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0].path).toBe('claude-settings.coverage.both');
  });

  test('snapshot cible collecté sur un fichier INVALIDE => CRITICAL, pas de diffs', async () => {
    writeLocalSettings({ env: { ANTHROPIC_BASE_URL: 'https://relay.example' } });
    publishRemoteSnapshot({}, { state: 'invalid', error: 'JSON invalide: ...' });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0].severity).toBe('CRITICAL');
    expect(result.differences[0].description).toMatch(/illisible/i);
  });

  test('snapshot STALE dur (>30j) => non couvert ; STALE soft (7-30j) => INFO + diffs', async () => {
    writeLocalSettings({ env: { ANTHROPIC_BASE_URL: 'https://relay.example' } });
    publishRemoteSnapshot({ 'env.ANTHROPIC_BASE_URL': 'https://other.example' }, { collectedAt: daysAgoIso(40) });
    const hard = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    expect(hard.differences).toHaveLength(1);
    expect(hard.differences[0].path).toBe('claude-settings.coverage.target');
    expect(hard.differences[0].description).toMatch(/seuil dur/);

    publishRemoteSnapshot({ 'env.ANTHROPIC_BASE_URL': 'https://other.example' }, { collectedAt: daysAgoIso(10) });
    const soft = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    const staleInfo = soft.differences.find(d => d.path === 'claude-settings.coverage.target.stale');
    expect(staleInfo?.severity).toBe('INFO');
    expect(soft.differences.some(d => d.path === 'claude-settings.env.ANTHROPIC_BASE_URL')).toBe(true);
  });

  test('source locale INVALIDE (live) => CRITICAL, pas de diffs', async () => {
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(fakeSettings, '{broken', 'utf-8');
    publishRemoteSnapshot({ 'env.ANTHROPIC_BASE_URL': 'https://other.example' });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0].severity).toBe('CRITICAL');
  });
});

describe('Côtés couverts — diffs véridiques', () => {
  test('divergent_value + present_absent avec valeurs formatées et sévérités', async () => {
    writeLocalSettings({
      env: {
        ANTHROPIC_BASE_URL: 'https://relay.example',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: 280000,
      },
      model: 'opus',
    });
    publishRemoteSnapshot({
      'env.ANTHROPIC_BASE_URL': 'https://other-relay.example',
      'env.CLAUDE_CODE_AUTO_COMPACT_WINDOW': 280000,
    });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });

    const urlDiff = result.differences.find(d => d.path === 'claude-settings.env.ANTHROPIC_BASE_URL');
    expect(urlDiff?.severity).toBe('CRITICAL');
    expect(urlDiff?.source_value).toContain('https://relay.example');
    expect(urlDiff?.target_value).toContain('https://other-relay.example');

    const modelDiff = result.differences.find(d => d.path === 'claude-settings.model');
    expect(modelDiff?.description).toMatch(/absent sur cible/);

    const cand = result.harmonization_candidates!;
    expect(cand.summary.divergent_value).toBeGreaterThanOrEqual(1);
    expect(cand.summary.present_absent).toBeGreaterThanOrEqual(1);
    expect(result.summary.total).toBe(result.differences.length);
  });

  test('états observés missing/empty = INFO explicite, diffs clé par clé quand même (vérité mesurée)', async () => {
    // settings local absent (missing) ; snapshot distant ok avec clés
    publishRemoteSnapshot({ 'env.ANTHROPIC_BASE_URL': 'https://relay.example' });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });

    const observed = result.differences.find(d => d.path === 'claude-settings.observed.source');
    expect(observed?.severity).toBe('INFO');
    expect(observed?.description).toMatch(/missing/);
    // la clé distante apparaît comme absente côté source — véridique
    const urlDiff = result.differences.find(d => d.path === 'claude-settings.env.ANTHROPIC_BASE_URL');
    expect(urlDiff?.description).toMatch(/absent sur source/);
  });

  test('identique des deux côtés => zéro diff de clé', async () => {
    writeLocalSettings({ env: { ANTHROPIC_BASE_URL: 'https://relay.example' } });
    publishRemoteSnapshot({ 'env.ANTHROPIC_BASE_URL': 'https://relay.example' });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    expect(result.differences.filter(d => d.path.startsWith('claude-settings.env'))).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });

  test('exemptés de campagne ACTIVE honorés ; campagne fermée ignorée', async () => {
    writeLocalSettings({ env: { ANTHROPIC_BASE_URL: 'https://relay.example' } });
    publishRemoteSnapshot({ 'env.ANTHROPIC_BASE_URL': 'https://other.example' });

    // Campagne active exemptant REMOTE sur BASE_URL
    const campDir = join(fakeShared, 'harmonization', 'campaigns');
    mkdirSync(campDir, { recursive: true });
    writeFileSync(join(campDir, 'hc-claude-settings-test-1.json'), JSON.stringify({
      id: 'hc-claude-settings-test-1',
      targetFile: 'claude-settings',
      createdAt: '2026-09-08T00:00:00Z',
      createdBy: LOCAL,
      canon: { version: 'test-1', mode: 'ensure-present', keys: {}, hash: 'x' },
      fleet: [REMOTE],
      exceptions: { [REMOTE]: ['env.ANTHROPIC_BASE_URL'] },
      dispatches: {}, confirmations: {}, failedAttempts: [], reminders: {},
      status: 'active',
    }));

    let result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    expect(result.differences.find(d => d.path === 'claude-settings.env.ANTHROPIC_BASE_URL')).toBeUndefined();

    // Campagne fermée => l'exemption ne s'applique plus
    const rec = JSON.parse(readFileSync(join(campDir, 'hc-claude-settings-test-1.json'), 'utf-8'));
    rec.status = 'closed';
    writeFileSync(join(campDir, 'hc-claude-settings-test-1.json'), JSON.stringify(rec));
    result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    expect(result.differences.find(d => d.path === 'claude-settings.env.ANTHROPIC_BASE_URL')).toBeDefined();
  });

  test('secrets jamais exposés : clés env sensibles n entrent jamais dans le diff', async () => {
    writeLocalSettings({
      env: {
        ANTHROPIC_BASE_URL: 'https://relay.example',
        ANTHROPIC_API_KEY: 'sk-ant-secret-DO-NOT-LEAK',
        ANTHROPIC_AUTH_TOKEN: 'tok-secret-DO-NOT-LEAK',
      },
    });
    publishRemoteSnapshot({
      'env.ANTHROPIC_BASE_URL': 'https://other.example',
    });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk-ant-secret');
    expect(serialized).not.toContain('tok-secret');
    expect(serialized).not.toContain('ANTHROPIC_API_KEY');
  });

  test('detail=paths : rendu léger sans valeurs ni candidats', async () => {
    writeLocalSettings({ env: { ANTHROPIC_BASE_URL: 'https://relay.example' } });
    publishRemoteSnapshot({ 'env.ANTHROPIC_BASE_URL': 'https://other.example' });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE, detail: 'paths' });
    expect(result.differences.every(d => d.source_value === undefined && d.target_value === undefined)).toBe(true);
    expect(result.harmonization_candidates).toBeUndefined();
  });

  test('filter réduit les diffs', async () => {
    writeLocalSettings({
      env: { ANTHROPIC_BASE_URL: 'https://relay.example', CLAUDE_CODE_AUTO_COMPACT_WINDOW: 280000 },
    });
    publishRemoteSnapshot({});
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE, filter: 'AUTO_COMPACT' });
    const keyDiffs = result.differences.filter(d => d.path.startsWith('claude-settings.env'));
    expect(keyDiffs).toHaveLength(1);
    expect(keyDiffs[0].path).toBe('claude-settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });
});

describe('Défaut review — non-divulgation des credentials de BASE_URL (défaut #1)', () => {
  test('source_value d une BASE_URL à credentials est masquée, jamais le raw', async () => {
    writeLocalSettings({
      env: { ANTHROPIC_BASE_URL: 'https://admin:topsecret@relay.example' },
    });
    publishRemoteSnapshot({ 'env.ANTHROPIC_BASE_URL': 'https://other-relay.example' });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    const urlDiff = result.differences.find(d => d.path === 'claude-settings.env.ANTHROPIC_BASE_URL');
    expect(urlDiff?.source_value).toContain('<credentials:sha256=');
    expect(urlDiff?.target_value).toContain('https://other-relay.example');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('topsecret');
    expect(serialized).not.toContain('admin');
  });

  test('userinfo DIFFÉRENTS sur le même host/path => un diff est produit (pas de faux alignement, défaut review #1)', async () => {
    // Deux BASE_URL qui ne diffèrent QUE par les credentials. Le snapshot
    // publié est déjà redacté (comme en production, via buildSnapshot) : sans
    // discrimination non réversible, les deux côtés collapseaient sur le même
    // marqueur et compare_config fabriquait un alignement que confirm() dément.
    writeLocalSettings({
      env: { ANTHROPIC_BASE_URL: 'https://user1:pw1@relay.example/v1' },
    });
    publishRemoteSnapshot({
      'env.ANTHROPIC_BASE_URL': redactValue('env.ANTHROPIC_BASE_URL', 'https://user2:pw2@relay.example/v1'),
    });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    const urlDiff = result.differences.find(d => d.path === 'claude-settings.env.ANTHROPIC_BASE_URL');
    expect(urlDiff).toBeDefined(); // le diff EXISTE — pas de conformité fabriquée
    expect(String(urlDiff?.source_value)).not.toBe(String(urlDiff?.target_value));
    // et les credentials ne fuient pas dans la sortie
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('user1');
    expect(serialized).not.toContain('pw1');
    expect(serialized).not.toContain('user2');
    expect(serialized).not.toContain('pw2');
  });

  test('userinfo IDENTIQUES sur le même host/path => pas de faux diff (empreinte déterministe)', async () => {
    writeLocalSettings({
      env: { ANTHROPIC_BASE_URL: 'https://user1:pw1@relay.example/v1' },
    });
    publishRemoteSnapshot({
      'env.ANTHROPIC_BASE_URL': redactValue('env.ANTHROPIC_BASE_URL', 'https://user1:pw1@relay.example/v1'),
    });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    expect(result.differences.filter(d => d.path.startsWith('claude-settings.env'))).toHaveLength(0);
  });

  test('BASE_URL propre identique des deux côtés => pas de faux diff malgré redaction', async () => {
    writeLocalSettings({ env: { ANTHROPIC_BASE_URL: 'https://relay.example' } });
    publishRemoteSnapshot({ 'env.ANTHROPIC_BASE_URL': 'https://relay.example' });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    expect(result.differences.filter(d => d.path.startsWith('claude-settings.env'))).toHaveLength(0);
  });
});

describe('Défaut review — conflit d exemptions entre campagnes (défaut #5)', () => {
  test('chemin exempté par une campagne mais requis par une autre => conflit exposé, diff conservé', async () => {
    writeLocalSettings({ env: { ANTHROPIC_BASE_URL: 'https://relay.example' } });
    publishRemoteSnapshot({ 'env.ANTHROPIC_BASE_URL': 'https://other.example' });

    const campDir = join(fakeShared, 'harmonization', 'campaigns');
    mkdirSync(campDir, { recursive: true });
    // Campagne A REQUIERT BASE_URL (dans le canon) pour REMOTE
    writeFileSync(join(campDir, 'hc-claude-settings-c1.json'), JSON.stringify({
      id: 'hc-claude-settings-c1', targetFile: 'claude-settings', createdAt: '2026-09-08T00:00:00Z',
      createdBy: LOCAL, canon: { version: 'c1', mode: 'ensure-present', keys: { 'env.ANTHROPIC_BASE_URL': 'https://other.example' }, hash: 'x' },
      fleet: [REMOTE], exceptions: {}, dispatches: {}, confirmations: {}, failedAttempts: [], reminders: {},
      status: 'active',
    }));
    // Campagne B EXEMPTE BASE_URL pour REMOTE
    writeFileSync(join(campDir, 'hc-claude-settings-c2.json'), JSON.stringify({
      id: 'hc-claude-settings-c2', targetFile: 'claude-settings', createdAt: '2026-09-08T00:00:00Z',
      createdBy: LOCAL, canon: { version: 'c2', mode: 'ensure-present', keys: {}, hash: 'y' },
      fleet: [REMOTE], exceptions: { [REMOTE]: ['env.ANTHROPIC_BASE_URL'] }, dispatches: {}, confirmations: {}, failedAttempts: [], reminders: {},
      status: 'active',
    }));

    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    // Le conflit est exposé (INFO), et le diff clé BASE_URL N EST PAS supprimé.
    const conflict = result.differences.find(d => d.path.includes('exemption-conflict'));
    expect(conflict).toBeDefined();
    expect(conflict?.severity).toBe('WARNING');
    expect(conflict?.description).toMatch(/REQUIS/);
    const keyDiff = result.differences.find(d => d.path === 'claude-settings.env.ANTHROPIC_BASE_URL');
    expect(keyDiff).toBeDefined();
  });

  test('exemption sans conflit (aucun canon ne requiert le chemin) => diff supprimé', async () => {
    writeLocalSettings({ env: { ANTHROPIC_BASE_URL: 'https://relay.example' } });
    publishRemoteSnapshot({ 'env.ANTHROPIC_BASE_URL': 'https://other.example' });
    const campDir = join(fakeShared, 'harmonization', 'campaigns');
    mkdirSync(campDir, { recursive: true });
    writeFileSync(join(campDir, 'hc-claude-settings-c1.json'), JSON.stringify({
      id: 'hc-claude-settings-c1', targetFile: 'claude-settings', createdAt: '2026-09-08T00:00:00Z',
      createdBy: LOCAL, canon: { version: 'c1', mode: 'ensure-present', keys: {}, hash: 'x' },
      fleet: [REMOTE], exceptions: { [REMOTE]: ['env.ANTHROPIC_BASE_URL'] }, dispatches: {}, confirmations: {}, failedAttempts: [], reminders: {},
      status: 'active',
    }));
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    expect(result.differences.find(d => d.path === 'claude-settings.env.ANTHROPIC_BASE_URL')).toBeUndefined();
    expect(result.differences.filter(d => d.path.includes('exemption-conflict'))).toHaveLength(0);
  });
});

describe('Défaut review — modelMap couvert par la comparaison (défaut #6)', () => {
  test('modelMap divergente par tier => diff claude-settings.modelMap.opus', async () => {
    writeLocalSettings({
      model: 'opus',
      modelMap: { opus: 'claude-opus-5[1m]', sonnet: 'claude-sonnet-5[1m]' },
    });
    publishRemoteSnapshot({ 'model': 'opus', 'modelMap.opus': 'claude-opus-4[1m]', 'modelMap.sonnet': 'claude-sonnet-5[1m]' });
    const result = await roosyncCompareConfig({ granularity: 'claude-settings', target: REMOTE });
    const opusDiff = result.differences.find(d => d.path === 'claude-settings.modelMap.opus');
    expect(opusDiff).toBeDefined();
    expect(opusDiff?.description).toMatch(/diffère/);
    // sonnet identique => pas de diff pour ce tier
    expect(result.differences.find(d => d.path === 'claude-settings.modelMap.sonnet')).toBeUndefined();
  });
});
