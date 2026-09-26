/**
 * #3782 — journal-level fork retirement (arbitration ai-01, comment 5844675985).
 *
 * `deleteSource` governs ONLY the file. The journal retires the merged-away
 * source key by a MARK (`roosync_dashboard_retirements`), never a DELETE —
 * the dashboard/journal rows stay in base (gel des purges). These tests
 * verify the four arbitration properties, which FAIL on the pre-#3782 code:
 *
 *   (a) after a merge `deleteSource:false`, the source is absent from `list`
 *       and from `forks`, and NO journal delete is issued (rows stay);
 *   (b) an `append` addressed to the retired key lands on the target, with a
 *       WARN naming the writing host, and nothing new under the source;
 *   (c) lifting the mark restores the key readable with its original content;
 *   (d) `deleteSource:true` keeps its current FILE behaviour (atomic archive
 *       rename) and the journal goes through the same mark, not the delete.
 *
 * Harness: same as dashboard-merge.test.ts — per-test tmpdir store, env
 * saved/restored, PG gates closed, store module spied at the boundary. The
 * retirement spies simulate what PG would return to a host with a live mark.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';

const {
  dualWriteSyncSpy,
  dualWriteDeleteSpy,
  pgReadSpy,
  pgSyncCheckedSpy,
  pgDeleteCheckedSpy,
  retireCheckedSpy,
  getRetirementSpy,
  listRetiredSpy,
} = vi.hoisted(() => ({
  dualWriteSyncSpy: vi.fn(),
  dualWriteDeleteSpy: vi.fn(),
  pgReadSpy: vi.fn(),
  pgSyncCheckedSpy: vi.fn(),
  pgDeleteCheckedSpy: vi.fn(),
  retireCheckedSpy: vi.fn(),
  getRetirementSpy: vi.fn(),
  listRetiredSpy: vi.fn(),
}));

vi.mock('../../../services/unified-store/roosync-dashboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dualWriteDashboardSync: dualWriteSyncSpy,
    dualWriteDashboardDelete: dualWriteDeleteSpy,
    dualWriteDashboardSyncChecked: pgSyncCheckedSpy,
    dualWriteDashboardDeleteChecked: pgDeleteCheckedSpy,
    readDashboardFromPg: pgReadSpy,
    retireDashboardKeyChecked: retireCheckedSpy,
    getDashboardRetirement: getRetirementSpy,
    listRetiredDashboardKeys: listRetiredSpy,
  };
});

// #858 / #864: client LLM (condensation) inert — aucune condensation attendue.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard } from '../dashboard.js';

// --- Isolation : un store unique par test --------------------------------
let testDir = '';
let dashboardsDir = '';

const WATCHED_ENV = [
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'UNIFIED_STORE_DASHBOARD_READ_PG',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_PG_URL',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'APPEND_LOCK_ACQUIRE_BUDGET_MS',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_API_BASE_URL',
] as const;
let savedEnv: Partial<Record<typeof WATCHED_ENV[number], string | undefined>> = {};

let testSerial = 0;

interface SeedMessage {
  id: string;
  timestamp: string;
  machine?: string;
  content: string;
}

/** Fixture : écrire un dashboard .md complet sur disque (format store réel). */
function seedDashboard(
  filename: string,
  type: 'machine' | 'workspace',
  lastModified: string,
  messages: SeedMessage[]
): void {
  mkdirSync(dashboardsDir, { recursive: true });
  const fm = [
    '---',
    `type: ${type}`,
    `lastModified: ${lastModified}`,
    'lastModifiedBy:',
    '  machineId: seeder',
    '  workspace: test',
    '---',
    '',
    '## Status',
    '',
    `*Statut de ${filename} (lastModified ${lastModified}).*`,
    '',
    `## Intercom (${messages.length} messages)`,
    ''
  ].join('\n');
  const body = messages
    .map(m => `### [${m.timestamp}] ${m.machine ?? 'myia-po-2025'}|CoursIA\n[msg: ${m.id}]\n\n${m.content}`)
    .join('\n\n---\n\n');
  writeFileSync(path.join(dashboardsDir, filename), `${fm}\n${messages.length ? body : '*Aucun message.*'}\n`, 'utf8');
}

const fileExists = (name: string) => existsSync(path.join(dashboardsDir, name));
const fileText = (name: string) => readFileSync(path.join(dashboardsDir, name), 'utf8');

const FORK_KEY = 'machine-myia-po-2025 (1)';
const CANONICAL_KEY = 'machine-myia-po-2025';
const CHAIN_MID_KEY = 'machine-myia-po-2025 (1) (1)';
const CHAIN_FINAL_KEY = 'machine-myia-po-2025'; // même cible finale après chaîne

const markOf = (sourceKey: string, targetKey: string) => ({
  sourceKey,
  targetKey,
  retiredBy: 'myia-ai-01:roo-extensions',
  retiredAt: '2026-09-26T09:00:00.000Z',
});

beforeEach(() => {
  testDir = path.join(os.tmpdir(), `roosync-retirement-${Date.now()}-${process.pid}-${++testSerial}`);
  dashboardsDir = path.join(testDir, 'shared-state', 'dashboards');
  mkdirSync(path.join(testDir, 'shared-state'), { recursive: true });

  savedEnv = {};
  for (const key of WATCHED_ENV) savedEnv[key] = process.env[key];
  process.env.ROOSYNC_SHARED_PATH = path.join(testDir, 'shared-state');
  process.env.ROOSYNC_MACHINE_ID = 'myia-po-2026';
  process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
  delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
  delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
  delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
  delete process.env.APPEND_LOCK_ACQUIRE_BUDGET_MS;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_API_BASE_URL;

  dualWriteSyncSpy.mockClear();
  dualWriteDeleteSpy.mockClear();
  pgSyncCheckedSpy.mockReset();
  pgSyncCheckedSpy.mockResolvedValue({ ok: true, reason: 'written' });
  pgDeleteCheckedSpy.mockReset();
  pgDeleteCheckedSpy.mockResolvedValue({ ok: true, reason: 'written' });
  pgReadSpy.mockReset();
  pgReadSpy.mockResolvedValue(null);
  retireCheckedSpy.mockReset();
  retireCheckedSpy.mockResolvedValue({ ok: true, reason: 'written' });
  // Défaut : aucune marque (clé non retirée) — fail-open.
  getRetirementSpy.mockReset();
  getRetirementSpy.mockResolvedValue(null);
  listRetiredSpy.mockReset();
  listRetiredSpy.mockResolvedValue(new Set<string>());
});

afterEach(() => {
  for (const key of WATCHED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testDir, { recursive: true, force: true });
});

// ─── (a) merge deleteSource:false — le journal retire, le fichier reste ────

describe('#3782 (a) — merge deleteSource=false retire la source au niveau journal', () => {
  it('marque posée, AUCUN delete PG, fichier source préservé', async () => {
    seedDashboard(CANONICAL_KEY + '.md', 'machine', '2026-09-20T10:00:00.000Z', [
      { id: 'm2', timestamp: '2026-09-20T10:00:00.000Z', content: 'm2 — cible seule' },
    ]);
    seedDashboard(FORK_KEY + '.md', 'machine', '2026-09-24T12:00:00.000Z', [
      { id: 'm3', timestamp: '2026-09-24T12:00:00.000Z', content: 'm3 — fork seul' },
    ]);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: FORK_KEY, deleteSource: false
    }) as any;

    expect(result.success).toBe(true);
    // La marque — pas le DELETE (les lignes restent en base, gel des purges).
    expect(retireCheckedSpy).toHaveBeenCalledTimes(1);
    expect(retireCheckedSpy).toHaveBeenCalledWith(FORK_KEY, CANONICAL_KEY, 'myia-po-2025:roo-extensions');
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
    expect(dualWriteDeleteSpy).not.toHaveBeenCalled();
    // deleteSource gouverne le fichier : la source SURVIT sur disque.
    expect(fileExists(FORK_KEY + '.md')).toBe(true);
    expect(String(result.message)).toContain('marque #3782');
  });

  it('après merge, list ne montre plus la clé retirée ni sa famille de forks', async () => {
    seedDashboard(CANONICAL_KEY + '.md', 'machine', '2026-09-20T10:00:00.000Z', [
      { id: 'm2', timestamp: '2026-09-20T10:00:00.000Z', content: 'm2 — cible seule' },
    ]);
    seedDashboard(FORK_KEY + '.md', 'machine', '2026-09-24T12:00:00.000Z', [
      { id: 'm3', timestamp: '2026-09-24T12:00:00.000Z', content: 'm3 — fork seul' },
    ]);

    await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: FORK_KEY, deleteSource: false
    }) as any;

    // Ce que PG répondrait à un hôte avec la marque active.
    listRetiredSpy.mockResolvedValue(new Set([FORK_KEY]));
    getRetirementSpy.mockImplementation(async (k: string) =>
      k === FORK_KEY ? markOf(FORK_KEY, CANONICAL_KEY) : null);

    const list = await roosyncDashboard({ action: 'list' }) as any;
    expect(list.success).toBe(true);
    const listedKeys: string[] = list.dashboards.map((d: any) => d.key);
    expect(listedKeys).toContain(CANONICAL_KEY);
    expect(listedKeys).not.toContain(FORK_KEY);
    // Le détecteur de forks ignore la clé retirée : plus de famille signalée.
    expect(list.forks ?? []).toEqual([]);

    // read sur la clé retirée : absente (les lignes PG restent, la visibilité change).
    const readFork = await roosyncDashboard({
      action: 'read', type: 'machine', machineId: 'myia-po-2025 (1)'
    }) as any;
    expect(readFork.success).toBe(false);
    expect(String(readFork.message)).toContain('introuvable');
  });
});

// ─── (suite, review ai-01 26/09) — merge refuse source ET cible retirées ───

describe('#3782 suite — merge refuse une clé retirée (source comme cible)', () => {
  it('source retirée → REFUS nommant la marque, AUCUN merge exécuté', async () => {
    seedDashboard(CANONICAL_KEY + '.md', 'machine', '2026-09-20T10:00:00.000Z', [
      { id: 'm2', timestamp: '2026-09-20T10:00:00.000Z', content: 'm2 — cible seule' },
    ]);
    seedDashboard(FORK_KEY + '.md', 'machine', '2026-09-24T12:00:00.000Z', [
      { id: 'm3', timestamp: '2026-09-24T12:00:00.000Z', content: 'm3 — fork seul' },
    ]);
    const forkBefore = fileText(FORK_KEY + '.md');
    getRetirementSpy.mockImplementation(async (k: string) =>
      k === FORK_KEY ? markOf(FORK_KEY, CANONICAL_KEY) : null);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: FORK_KEY, deleteSource: false
    }) as any;

    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('retirée');
    expect(String(result.message)).toContain(CANONICAL_KEY);
    // Aucun merge exécuté : pas de nouvelle marque, pas de delete, fichier intact.
    expect(retireCheckedSpy).not.toHaveBeenCalled();
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
    expect(fileText(FORK_KEY + '.md')).toBe(forkBefore);
  });

  it('cible retirée → REFUS pointant vers la cible finale de la marque', async () => {
    seedDashboard(FORK_KEY + '.md', 'machine', '2026-09-24T12:00:00.000Z', [
      { id: 'm3', timestamp: '2026-09-24T12:00:00.000Z', content: 'm3 — fork seul' },
    ]);
    seedDashboard(CHAIN_MID_KEY + '.md', 'machine', '2026-09-24T13:00:00.000Z', [
      { id: 'm4', timestamp: '2026-09-24T13:00:00.000Z', content: 'm4 — mid' },
    ]);
    // La CIBLE du merge demandé porte elle-même une marque.
    getRetirementSpy.mockImplementation(async (k: string) =>
      k === CHAIN_MID_KEY ? markOf(CHAIN_MID_KEY, CANONICAL_KEY) : null);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025 (1) (1)',
      sourceKey: FORK_KEY
    }) as any;

    expect(result.success).toBe(false);
    expect(String(result.message)).toContain(CHAIN_MID_KEY);
    expect(String(result.message)).toContain(CANONICAL_KEY);
    expect(retireCheckedSpy).not.toHaveBeenCalled();
  });
});

// ─── (b) append sur clé retirée → redirigé vers la cible ───────────────────

describe('#3782 (b) — append sur une clé retirée atterrit sur la cible', () => {
  it("message lisible sous la cible, WARN nommant l'hôte écrivain, rien sous la source", async () => {
    seedDashboard(CANONICAL_KEY + '.md', 'machine', '2026-09-20T10:00:00.000Z', [
      { id: 'm2', timestamp: '2026-09-20T10:00:00.000Z', content: 'm2 — cible seule' },
    ]);
    seedDashboard(FORK_KEY + '.md', 'machine', '2026-09-24T12:00:00.000Z', [
      { id: 'm3', timestamp: '2026-09-24T12:00:00.000Z', content: 'm3 — fork seul' },
    ]);
    const forkBefore = fileText(FORK_KEY + '.md');
    getRetirementSpy.mockImplementation(async (k: string) =>
      k === FORK_KEY ? markOf(FORK_KEY, CANONICAL_KEY) : null);

    const result = await roosyncDashboard({
      action: 'append', type: 'machine', machineId: 'myia-po-2025 (1)',
      content: 'APPEND VIA CLE RETIREE'
    }) as any;

    expect(result.success).toBe(true);
    // La réponse porte la clé FINALE…
    expect(result.key).toBe(CANONICAL_KEY);
    // …et le WARN nommant l'hôte écrivain.
    expect(String(result.message)).toContain('[retirement #3782]');
    expect(String(result.message)).toContain('myia-po-2025 (1):roo-extensions');
    // Le message vit sous la cible…
    expect(fileText(CANONICAL_KEY + '.md')).toContain('APPEND VIA CLE RETIREE');
    // …et RIEN de neuf sous la source (octet pour octet).
    expect(fileText(FORK_KEY + '.md')).toBe(forkBefore);
  });

  it('chaîne A→B puis B→C : un append sur A atterrit sur la cible finale', async () => {
    seedDashboard(CHAIN_FINAL_KEY + '.md', 'machine', '2026-09-20T10:00:00.000Z', [
      { id: 'm2', timestamp: '2026-09-20T10:00:00.000Z', content: 'm2 — cible finale' },
    ]);
    const marks = new Map<string, ReturnType<typeof markOf>>([
      [FORK_KEY, markOf(FORK_KEY, CHAIN_MID_KEY)],
      [CHAIN_MID_KEY, markOf(CHAIN_MID_KEY, CHAIN_FINAL_KEY)],
    ]);
    getRetirementSpy.mockImplementation(async (k: string) => marks.get(k) ?? null);

    const result = await roosyncDashboard({
      action: 'append', type: 'machine', machineId: 'myia-po-2025 (1)',
      content: 'APPEND A TRAVERS LA CHAINE'
    }) as any;

    expect(result.success).toBe(true);
    expect(result.key).toBe(CHAIN_FINAL_KEY);
    expect(fileText(CHAIN_FINAL_KEY + '.md')).toContain('APPEND A TRAVERS LA CHAINE');
  });
});

// ─── (c) lever la marque restaure la clé ───────────────────────────────────

describe('#3782 (c) — lever la marque rend la clé lisible avec son contenu d\'origine', () => {
  it('retirée : introuvable ; marque levée : contenu original servi', async () => {
    seedDashboard(FORK_KEY + '.md', 'machine', '2026-09-24T12:00:00.000Z', [
      { id: 'm3', timestamp: '2026-09-24T12:00:00.000Z', content: 'm3 — contenu original du fork' },
    ]);

    getRetirementSpy.mockResolvedValue(markOf(FORK_KEY, CANONICAL_KEY));
    const retired = await roosyncDashboard({
      action: 'read', type: 'machine', machineId: 'myia-po-2025 (1)'
    }) as any;
    expect(retired.success).toBe(false);

    // Marque levée (lifted_at posé en base → lookup ne la rend plus).
    getRetirementSpy.mockResolvedValue(null);
    const restored = await roosyncDashboard({
      action: 'read', type: 'machine', machineId: 'myia-po-2025 (1)'
    }) as any;
    expect(restored.success).toBe(true);
    expect(restored.messageCount).toBe(1);
    expect(JSON.stringify(restored.data)).toContain('m3 — contenu original du fork');
  });
});

// ─── (d) merge deleteSource:true — fichier inchangé, journal par la marque ──

describe('#3782 (d) — merge deleteSource=true : comportement fichier conservé, journal par la marque', () => {
  it('archive par renommage atomique + marque, JAMAIS le DELETE cascade', async () => {
    seedDashboard(CANONICAL_KEY + '.md', 'machine', '2026-09-20T10:00:00.000Z', [
      { id: 'm2', timestamp: '2026-09-20T10:00:00.000Z', content: 'm2 — cible seule' },
    ]);
    seedDashboard(FORK_KEY + '.md', 'machine', '2026-09-24T12:00:00.000Z', [
      { id: 'm3', timestamp: '2026-09-24T12:00:00.000Z', content: 'm3 — fork seul' },
    ]);

    const result = await roosyncDashboard({
      action: 'merge', type: 'machine', machineId: 'myia-po-2025',
      sourceKey: FORK_KEY
    }) as any;

    expect(result.success).toBe(true);
    // Comportement FICHIER inchangé : source retirée du disque + archive pré-merge.
    expect(fileExists(FORK_KEY + '.md')).toBe(false);
    const archiveDir = path.join(dashboardsDir, 'archive');
    const archives = existsSync(archiveDir)
      ? readdirSync(archiveDir).filter((f: string) => f.startsWith(FORK_KEY + '-pre-merge-'))
      : [];
    expect(archives.length).toBe(1);
    // Le journal passe par la MÊME marque — pas par le DELETE cascade (:657),
    // qui aurait détruit les lignes du fork (gel des purges).
    expect(retireCheckedSpy).toHaveBeenCalledTimes(1);
    expect(retireCheckedSpy).toHaveBeenCalledWith(FORK_KEY, CANONICAL_KEY, 'myia-po-2025:roo-extensions');
    expect(pgDeleteCheckedSpy).not.toHaveBeenCalled();
    expect(dualWriteDeleteSpy).not.toHaveBeenCalled();
    expect(String(result.message)).toContain('marque #3782');
  });
});
