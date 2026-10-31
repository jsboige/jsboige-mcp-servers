/**
 * #4439 — `read` résout la jumelle DriveFS quand le canonique manque (#4439).
 *
 * Mesure fondatrice (web1, 30-31/10, 5e récidive) : sur un montage dont la
 * moitié fichier ne connaît `workspace-claudish` QUE sous « workspace-claudish
 * (1).md », `read` rendait « introuvable » pendant que le trafic vivant
 * atterrissait sur la jumelle. Ces tests verrouillent le repli :
 *
 *   1. la mesure web1 — canonique absent, jumelle vivante → read SERT la
 *      jumelle sous étiquette `resolved_from_fork`, sans jamais écrire ;
 *   2. canonique présent → la jumelle est IGNORÉE (aucun changement de
 *      comportement nominal, pas de champ sur la réponse) ;
 *   3. jumelle retirée par merge (#3782) → PAS ressuscitée : introuvable ;
 *   4. canonique retiré par merge → la famille entière reste morte ;
 *   5. deux jumelles → la plus récente (max des horodatages, pas l'ordre du
 *      tableau — skew d'horloge cross-machine) est servie ;
 *   6. jumelle retirée mais RESSUSCITÉE par le trafic (messages plus récents
 *      que retiredAt) → servie, marque périmée signalée (6e facette, web1
 *      31/10 : marques des 26/09 et 19/10, trafic du jour) ;
 *   7. deux jumelles retirées, une morte une ressuscitée → seule la
 *      ressuscitée est servie (discriminateur par candidat).
 *
 * Harness : même passe-partout que dashboard-retirement.test.ts — store
 * temporaire par test, PG gates fermées, module store mocké à la frontière
 * (readDashboardFromPg → null = la moitié PG ne sert pas, exactement la
 * condition web1 DASHBOARD_READ_PG=0 ; getDashboardRetirement → null par
 * défaut, fail-open).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
// ms#1539 : mkdtemp est le patron obligatoire pour un répertoire temporaire
// unique — pas de jeton fait main (le harness retirement copié l'utilise,
// mais il est grandfatheré en baseline ; un NOUVEAU fichier doit être net).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';

const { pgReadSpy, getRetirementSpy } = vi.hoisted(() => ({
  pgReadSpy: vi.fn(),
  getRetirementSpy: vi.fn(),
}));

vi.mock('../../../services/unified-store/roosync-dashboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readDashboardFromPg: pgReadSpy,
    getDashboardRetirement: getRetirementSpy,
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
function seedDashboard(
  filename: string,
  lastModified: string,
  messages: SeedMessage[]
): void {
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
    `*Statut de ${filename} (lastModified ${lastModified}).*`,
    '',
    `## Intercom (${messages.length} messages)`,
    ''
  ].join('\n');
  const body = messages
    .map(m => `### [${m.timestamp}] myia-po-2024|CoursIA\n[msg: ${m.id}]\n\n${m.content}`)
    .join('\n\n---\n\n');
  writeFileSync(path.join(dashboardsDir, filename), `${fm}\n${messages.length ? body : '*Aucun message.*'}\n`, 'utf8');
}

const fileExists = (name: string) => existsSync(path.join(dashboardsDir, name));

const CANONICAL_FILE = 'workspace-claudish.md';
const FORK1_FILE = 'workspace-claudish (1).md';
const FORK2_FILE = 'workspace-claudish (2).md';

const markOf = (sourceKey: string, targetKey: string) => ({
  sourceKey,
  targetKey,
  retiredBy: 'myia-ai-01:roo-extensions',
  retiredAt: '2026-10-31T09:00:00.000Z',
});

const readCanonical = () =>
  roosyncDashboard({ action: 'read', type: 'workspace', workspace: 'claudish' }) as Promise<Record<string, unknown>>;

beforeEach(() => {
  testDir = mkdtempSync(path.join(os.tmpdir(), 'roosync-fork-twin-'));
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
  pgReadSpy.mockResolvedValue(null); // la moitié PG ne sert pas — condition web1
  getRetirementSpy.mockReset();
  getRetirementSpy.mockResolvedValue(null); // fail-open par défaut
});

afterEach(() => {
  for (const key of WATCHED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testDir, { recursive: true, force: true });
});

describe('#4439 — read sert la jumelle DriveFS quand le canonique manque (mesure web1)', () => {
  it('canonique absent, jumelle (1) vivante → servie SOUS ÉTIQUETTE, sans écriture', async () => {
    seedDashboard(FORK1_FILE, '2026-10-29T23:51:26.000Z', [
      { id: 'f1', timestamp: '2026-10-29T23:51:26.000Z', content: 'trafic vivant sur la jumelle — fork mesuré web1' },
    ]);

    const result = await readCanonical();

    // Avant le repli, ce read rendait success:false « introuvable » — c'est
    // le mensonge que #4439 documente (5e récidive).
    expect(result.success).toBe(true);
    expect(result.resolved_from_fork).toBe('workspace-claudish (1)');
    expect(String(result.message)).toContain("jumelle DriveFS 'workspace-claudish (1)'");
    expect(String(result.message)).toContain('PG fait référence');
    const data = result.data as { intercom?: { messages: Array<{ content: string }> } };
    expect(data.intercom?.messages?.[0]?.content).toContain('trafic vivant sur la jumelle');
    // Le read n'ÉCRIT jamais : le canonique ne doit pas exister après.
    expect(fileExists(CANONICAL_FILE)).toBe(false);
  });

  it('canonique présent → la jumelle est IGNORÉE, réponse canonique sans étiquette', async () => {
    seedDashboard(CANONICAL_FILE, '2026-10-31T05:46:55.000Z', [
      { id: 'c1', timestamp: '2026-10-31T05:46:55.000Z', content: 'canonique vivant — état ai-01' },
    ]);
    seedDashboard(FORK1_FILE, '2026-10-29T23:51:26.000Z', [
      { id: 'f1', timestamp: '2026-10-29T23:51:26.000Z', content: 'jumelle plus ancienne' },
    ]);

    const result = await readCanonical();

    expect(result.success).toBe(true);
    expect(result.resolved_from_fork).toBeUndefined();
    expect(result.message).toBeUndefined();
    const data = result.data as { intercom?: { messages: Array<{ content: string }> } };
    expect(data.intercom?.messages?.[0]?.content).toContain('canonique vivant');
  });

  it('jumelle retirée par merge (#3782) → PAS ressuscitée : introuvable', async () => {
    seedDashboard(FORK1_FILE, '2026-10-29T23:51:26.000Z', [
      { id: 'f1', timestamp: '2026-10-29T23:51:26.000Z', content: 'fork déjà mergé' },
    ]);
    getRetirementSpy.mockImplementation(async (k: string) =>
      k === 'workspace-claudish (1)' ? markOf('workspace-claudish (1)', 'workspace-claudish') : null);

    const result = await readCanonical();

    // La retraite est la dernière parole : un merge a refermé cette famille,
    // le repli ne rouvre pas le fork.
    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('introuvable');
  });

  it('jumelle retirée mais RESSUSCITÉE (messages plus récents que retiredAt) → servie, marque périmée signalée', async () => {
    // 6e facette (mesure web1 31/10 21:1xZ) : les merges des 26/09 et 19/10
    // ont marqué les jumelles, mais le trafic vivant les a RESSUSCITÉES —
    // workspace-CoursIA (1) portait un message de 20:40Z le 31/10 sous une
    // marque du 26/09. Refuser la jumelle rendait « introuvable » sur le
    // seul exemplaire vivant du dashboard : exactement le mensonge que le
    // repli devait fermer.
    seedDashboard(FORK1_FILE, '2026-10-31T20:40:00.000Z', [
      { id: 'f2', timestamp: '2026-10-31T20:40:00.000Z', content: 'trafic vivant APRÈS le merge — fork ressuscité' },
    ]);
    getRetirementSpy.mockImplementation(async (k: string) =>
      k === 'workspace-claudish (1)' ? markOf('workspace-claudish (1)', 'workspace-claudish') : null);

    const result = await readCanonical();

    // La marque (31/10 09:00Z fixe dans markOf) décrit un état mort : la
    // jumelle porte un message de 20:40Z. Servie — sous étiquette renforcée.
    expect(result.success).toBe(true);
    expect(result.resolved_from_fork).toBe('workspace-claudish (1)');
    expect(String(result.message)).toContain('PÉRIMÉE');
    expect(String(result.message)).toContain('2026-10-31T09:00:00.000Z');
    expect(String(result.message)).toContain('fork ressuscité');
    const data = result.data as { intercom?: { messages: Array<{ content: string }> } };
    expect(data.intercom?.messages?.[0]?.content).toContain('fork ressuscité');
    expect(fileExists(CANONICAL_FILE)).toBe(false);
  });

  it('deux jumelles retirées — une morte, une ressuscitée → seule la ressuscitée est servie', async () => {
    seedDashboard(FORK1_FILE, '2026-10-29T23:51:26.000Z', [
      { id: 'f1', timestamp: '2026-10-29T23:51:26.000Z', content: 'jumelle morte — rien après la marque' },
    ]);
    seedDashboard(FORK2_FILE, '2026-10-31T18:12:00.000Z', [
      { id: 'g1', timestamp: '2026-10-31T18:12:00.000Z', content: 'jumelle ressuscitée après la marque' },
    ]);
    getRetirementSpy.mockImplementation(async (k: string) =>
      k.startsWith('workspace-claudish (') ? markOf(k, 'workspace-claudish') : null);

    const result = await readCanonical();

    // Le discriminateur est PAR CANDIDAT : la marque ne tue que la jumelle
    // qu'elle décrit encore. (1) morte → refusée ; (2) ressuscitée → servie.
    expect(result.success).toBe(true);
    expect(result.resolved_from_fork).toBe('workspace-claudish (2)');
    expect(String(result.message)).toContain('PÉRIMÉE');
    const data = result.data as { intercom?: { messages: Array<{ content: string }> } };
    expect(data.intercom?.messages?.[0]?.content).toContain('ressuscitée');
  });

  it('canonique retiré par merge → la famille ENTIERE reste morte', async () => {
    seedDashboard(FORK1_FILE, '2026-10-29T23:51:26.000Z', [
      { id: 'f1', timestamp: '2026-10-29T23:51:26.000Z', content: 'residu de famille retirée' },
    ]);
    getRetirementSpy.mockImplementation(async (k: string) =>
      k === 'workspace-claudish' ? markOf('workspace-claudish', 'workspace-autre') : null);

    const result = await readCanonical();

    expect(result.success).toBe(false);
    expect(String(result.message)).toContain('introuvable');
  });

  it('deux jumelles → la plus récente est servie (max des horodatages)', async () => {
    seedDashboard(FORK1_FILE, '2026-10-29T23:51:26.000Z', [
      { id: 'f1', timestamp: '2026-10-29T23:51:26.000Z', content: 'jumelle 1 — plus ancienne' },
    ]);
    seedDashboard(FORK2_FILE, '2026-10-30T18:22:00.000Z', [
      { id: 'g1', timestamp: '2026-10-30T18:22:00.000Z', content: 'jumelle 2 — plus récente' },
    ]);

    const result = await readCanonical();

    expect(result.success).toBe(true);
    expect(result.resolved_from_fork).toBe('workspace-claudish (2)');
    const data = result.data as { intercom?: { messages: Array<{ content: string }> } };
    expect(data.intercom?.messages?.[0]?.content).toContain('jumelle 2');
  });
});
