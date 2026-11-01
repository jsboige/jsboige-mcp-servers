/**
 * #4439 — 7e facette : `list` doit voir ce que `read` voit.
 *
 * Mesure fondatrice (web1, 01/11 ~00:0xZ, code de ms#1609 déployé en process
 * frais sur le montage réel) :
 *
 *   read workspace-claudish  -> success:true, resolved_from_fork 'workspace-claudish (1)'
 *   read workspace-CoursIA   -> success:true, resolved_from_fork 'workspace-CoursIA (1)'
 *   list                     -> 69 dashboards, AUCUNE clé de la famille (ni le
 *                               canonique ni la jumelle), 0 famille forkée
 *
 * Les jumelles portent des marques de retraite #3782 périmées (19/10, 26/09)
 * alors que du trafic y écrit encore : la marque décrit un état mort, le
 * contenu le démentit. `read` tranche par la fraîcheur depuis ms#1609 ; `list`
 * ne tranchait pas du tout — il masquait la clé sur la seule existence d'une
 * marque, rendant la famille indécouvrable sur un siège dont la moitié fichier
 * ne connaît que la jumelle. C'est exactement ce qui pousse un agent à croire
 * le dashboard absent, puis à en recréer un canonique VIDE (`createIfNotExists`)
 * à côté du trafic vivant : le dommage que #4439 documente.
 *
 * Ces tests verrouillent le discriminateur, sur le même instrument que `read`
 * (`freshestTimestamp` = max des messages, jamais le mtime fichier — skew DFS) :
 *
 *   1. jumelle retirée mais RESSUSCITÉE → listée, et la famille forkée est
 *      signalée avec son canonique ABSENT (la découverte que l'opérateur
 *      répare ; le canonique absent est la vérité mesurée sur web1) ;
 *   2. jumelle retirée et MORTE (rien après la marque) → toujours invisible,
 *      aucune famille signalée : la retraite reste la dernière parole ;
 *   3. contrôle : une clé non retirée se liste comme avant, sans étiquette ;
 *   4. fail-closed : `retiredAt` illisible → la marque tient (invisible).
 *
 * Harness : même passe-partout que dashboard-read-fork-twin.test.ts — store
 * temporaire par test (mkdtemp, ratchet ms#1539), gates PG fermées, module
 * store mocké à la frontière. `listRooSyncDashboardKeysFromPg` rend null (gate
 * off) : la vue PG n'a pas d'histoire, le chemin mesuré est le readdir GDrive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';

const { pgReadSpy, getRetirementSpy, listRetiredSpy, pgListKeysSpy } = vi.hoisted(() => ({
  pgReadSpy: vi.fn(),
  getRetirementSpy: vi.fn(),
  listRetiredSpy: vi.fn(),
  pgListKeysSpy: vi.fn(),
}));

vi.mock('../../../services/unified-store/roosync-dashboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readDashboardFromPg: pgReadSpy,
    getDashboardRetirement: getRetirementSpy,
    listRetiredDashboardKeys: listRetiredSpy,
    listRooSyncDashboardKeysFromPg: pgListKeysSpy,
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

let testDir = '';
let dashboardsDir = '';

const WATCHED_ENV = [
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'ROOSYNC_TRUSTED_CALLER_IDS',
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

interface SeedMessage {
  id: string;
  timestamp: string;
  content: string;
}

/** Fixture : écrire un dashboard .md complet sur disque (format store réel). */
function seedDashboard(filename: string, lastModified: string, messages: SeedMessage[]): void {
  mkdirSync(dashboardsDir, { recursive: true });
  const fm = [
    '---',
    'type: workspace',
    `lastModified: ${lastModified}`,
    'lastModifiedBy:',
    '  machineId: seeder',
    '  workspace: test',
    '---',
    '',
    '## Status',
    '',
    `*Statut de ${filename}.*`,
    '',
    `## Intercom (${messages.length} messages)`,
    ''
  ].join('\n');
  const body = messages
    .map(m => `### [${m.timestamp}] myia-po-2024|CoursIA\n[msg: ${m.id}]\n\n${m.content}`)
    .join('\n\n---\n\n');
  writeFileSync(path.join(dashboardsDir, filename), `${fm}\n${messages.length ? body : '*Aucun message.*'}\n`, 'utf8');
}

const FORK1_FILE = 'workspace-claudish (1).md';
const CANONICAL_FILE = 'workspace-claudish.md';
const FORK1_KEY = 'workspace-claudish (1)';

/** Marque RÉELLE mesurée sur web1 (merge du 19/10). */
const markOf = (retiredAt = '2026-10-19T23:07:58.877Z') => ({
  sourceKey: FORK1_KEY,
  targetKey: 'workspace-claudish',
  retiredBy: 'myia-ai-01:roo-extensions',
  retiredAt,
});

const listAll = () =>
  roosyncDashboard({ action: 'list' }) as Promise<Record<string, unknown>>;

const keysOf = (result: Record<string, unknown>) =>
  ((result.dashboards as Array<{ key: string }>) ?? []).map(d => d.key);

beforeEach(() => {
  testDir = mkdtempSync(path.join(os.tmpdir(), 'roosync-list-resurrected-'));
  dashboardsDir = path.join(testDir, 'shared-state', 'dashboards');
  mkdirSync(path.join(testDir, 'shared-state'), { recursive: true });

  savedEnv = {};
  for (const key of WATCHED_ENV) savedEnv[key] = process.env[key];
  process.env.ROOSYNC_SHARED_PATH = path.join(testDir, 'shared-state');
  process.env.ROOSYNC_MACHINE_ID = 'myia-po-2024';
  process.env.ROOSYNC_WORKSPACE_ID = 'roo-extensions';
  process.env.ROOSYNC_TRUSTED_CALLER_IDS = '';
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

  pgReadSpy.mockReset();
  pgReadSpy.mockResolvedValue(null);
  pgListKeysSpy.mockReset();
  pgListKeysSpy.mockResolvedValue(null); // gate off : pas de vue PG, readdir GDrive
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

describe('#4439 7e facette — `list` voit la jumelle ressuscitée que `read` sert', () => {
  it('jumelle retirée mais RESSUSCITÉE → listée, famille signalée avec canonique ABSENT', async () => {
    // Mesure web1 : message le plus récent 2026-10-31T20:56Z, marque du 19/10.
    seedDashboard(FORK1_FILE, '2026-10-31T20:56:54.712Z', [
      { id: 'f1', timestamp: '2026-10-31T20:56:54.712Z', content: 'trafic vivant après la marque' },
    ]);
    listRetiredSpy.mockResolvedValue(new Set([FORK1_KEY]));
    getRetirementSpy.mockImplementation(async (k: string) => (k === FORK1_KEY ? markOf() : null));

    const result = await listAll();

    expect(result.success).toBe(true);
    // Avant ce correctif : 0 clé de la famille — l'instrument de découverte
    // était muet là où `read` servait la jumelle.
    expect(keysOf(result)).toContain(FORK1_KEY);
    const forks = result.forks as Array<{ canonical: string; canonicalPresent: boolean; forks: string[] }>;
    expect(forks).toHaveLength(1);
    expect(forks[0].canonical).toBe('workspace-claudish');
    expect(forks[0].canonicalPresent).toBe(false); // vérité mesurée sur web1
    expect(forks[0].forks).toContain(FORK1_KEY);
    expect(String(result.message)).toContain('famille(s) forkée(s)');
    expect(String(result.message)).toContain('(canonique ABSENT)');
    // Le fichier n'est ni déplacé ni renommé : `list` n'écrit jamais.
    expect(existsSync(path.join(dashboardsDir, FORK1_FILE))).toBe(true);
  });

  it('jumelle retirée et MORTE (rien après la marque) → invisible, aucune famille signalée', async () => {
    seedDashboard(FORK1_FILE, '2026-10-19T10:00:00.000Z', [
      { id: 'f1', timestamp: '2026-10-19T10:00:00.000Z', content: 'rien depuis la marque' },
    ]);
    listRetiredSpy.mockResolvedValue(new Set([FORK1_KEY]));
    getRetirementSpy.mockImplementation(async (k: string) => (k === FORK1_KEY ? markOf() : null));

    const result = await listAll();

    expect(result.success).toBe(true);
    expect(keysOf(result)).not.toContain(FORK1_KEY);
    expect(result.forks).toBeUndefined();
    expect(String(result.message)).not.toContain('famille(s) forkée(s)');
  });

  it('contrôle : clé non retirée → listée comme avant, sans étiquette', async () => {
    seedDashboard(CANONICAL_FILE, '2026-10-31T05:46:55.000Z', [
      { id: 'c1', timestamp: '2026-10-31T05:46:55.000Z', content: 'canonique vivant' },
    ]);

    const result = await listAll();

    expect(result.success).toBe(true);
    expect(keysOf(result)).toEqual(['workspace-claudish']);
    expect(result.forks).toBeUndefined();
  });

  it('fail-closed : `retiredAt` illisible → la marque tient, la clé reste invisible', async () => {
    seedDashboard(FORK1_FILE, '2026-10-31T20:56:54.712Z', [
      { id: 'f1', timestamp: '2026-10-31T20:56:54.712Z', content: 'trafic vivant' },
    ]);
    listRetiredSpy.mockResolvedValue(new Set([FORK1_KEY]));
    getRetirementSpy.mockImplementation(async (k: string) =>
      (k === FORK1_KEY ? markOf('date-inconnue') : null));

    const result = await listAll();

    // Une date illisible ne prouve aucune résurrection : on ne sert pas.
    expect(keysOf(result)).not.toContain(FORK1_KEY);
    expect(result.forks).toBeUndefined();
  });
});
