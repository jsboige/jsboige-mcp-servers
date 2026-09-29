/**
 * #3230 write-side — un append depuis une copie locale en retard devient une
 * réparation, pas une perte.
 *
 * Incident mesuré ai-01 28/09 (commentaire #3230 c.5880565657) : deux vagues
 * d'écrasement sur `workspace-roo-extensions`, 11 des 15 messages vivants omis
 * du fichier en ligne à 23:21Z. Cause : `appendDashboardIncremental` relit le
 * fichier LOCAL et y colle l'incrément — le fichier écrit vaut « copie locale,
 * même en retard, + mon message », et DriveFS pousse ce fichier au cloud.
 *
 * Ces tests verrouillent le correctif, à la lettre de la spécification d'ai-01 :
 * « un fichier local sans deux ids présents en PG, puis un ajout ; le fichier
 * doit contenir les deux ids et le nouveau message. »
 *
 *   - RÉPARATION (gate READ_PG=1) : le fichier local manque 2 ids vivants de
 *     la vue PG en main → l'append écrit le fichier COMPLET depuis la vue ;
 *     les ids manquants reviennent, le message neuf atterrit.
 *   - UNIDIRECTIONNEL (gate READ_PG=1) : le fichier porte un id que la vue
 *     n'a PAS (writer concurrent non-PG, condensation qui a archivé) →
 *     l'incrément reste le chemin — cet id survit, jamais réécrit depuis une
 *     vue plus pauvre.
 *   - GATE OFF (contrôle) : vue = fichier (sémantique réelle de
 *     readDashboardFromPg porte fermée) → incrément inchangé, service intact.
 *
 * Contre-épreuve : sans la garde dans `appendDashboardIncremental`, le test
 * « réparation » rougit (les deux ids manquants restent absents du fichier),
 * tandis que les deux autres restent verts avant ET après — la compatibilité
 * de l'incrément n'est pas renégociée par le correctif.
 *
 * Isolation : store tmpdir unique par test, env sauvegardé/restauré à
 * l'identique, LLM inert (#858/#864), `dualWriteDashboardSync` espionné,
 * `readDashboardFromPg` piloté par le test. Zéro PG réel, zéro G:.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';

// Vue PG pilotée par le test + preuve « chemin full-write » : espion sur le
// dual-write (seul writeDashboardFile — pas l'incrément — l'appelle avec la
// vue complète). Le reste du module store reste RÉEL (retirement fail-open,
// reader gate-off => null).
const { readDashboardFromPgFake, dualWriteSyncSpy } = vi.hoisted(() => ({
  readDashboardFromPgFake: vi.fn(),
  dualWriteSyncSpy: vi.fn(),
}));
vi.mock('../../../services/unified-store/roosync-dashboard-store.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    readDashboardFromPg: readDashboardFromPgFake,
    dualWriteDashboardSync: dualWriteSyncSpy,
  };
});

// #858 / #864: LLM (condensation) inert — aucune condensation ne doit partir.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => { throw new Error('No chat API key configured'); },
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackChatModelId: () => 'test-fallback-model',
}));

import { roosyncDashboard } from '../dashboard.js';

// --- Isolation : un store unique par test, purgé en afterEach -------------
let testDir = '';
let dashboardsDir = '';
let testSerial = 0;

const WATCHED_ENV = [
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE_ID',
  'UNIFIED_STORE_DASHBOARD_READ_PG',
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_PG_URL',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_API_BASE_URL',
] as const;
let savedEnv: Partial<Record<typeof WATCHED_ENV[number], string | undefined>> = {};

const KEY = 'stale-copy-test';
const FILE = 'workspace-stale-copy-test.md';
const author = { machineId: 'test-machine', workspace: 'test-workspace' };

/** Bloc message au format exact de sérialisation (cf. buildDashboardMarkdown). */
function messageBlock(id: string, content: string): string {
  return `### [2026-09-28T20:00:00.000Z] test-machine|test-workspace\n[msg: ${id}]\n\n${content}`;
}

/** Fichier dashboard local bien formé (frontmatter + status + intercom). */
function seedLocalFile(messageBlocks: string[]): void {
  const body = messageBlocks.join('\n\n---\n\n');
  writeFileSync(path.join(dashboardsDir, FILE), `---
type: workspace
lastModified: '2026-09-28T20:00:00.000Z'
lastModifiedBy:
  machineId: test-machine
  workspace: test-workspace
totalMessages: ${messageBlocks.length}
---

## Status

# Statut seed

## Intercom (${messageBlocks.length} messages)

${body}
`, 'utf8');
}

/** Message IntercomMessage minimal pour la vue PG en main. */
function pgMessage(id: string, content: string) {
  return {
    id,
    timestamp: '2026-09-28T21:00:00.000Z',
    author,
    content,
  };
}

beforeEach(() => {
  testDir = path.join(os.tmpdir(), `roosync-stalecopy-${Date.now()}-${process.pid}-${++testSerial}`);
  dashboardsDir = path.join(testDir, 'shared-state', 'dashboards');
  // Le store doit exister : fail-closed #3459 sinon (assertSharedStoreAccessible).
  mkdirSync(path.join(testDir, 'shared-state', 'dashboards'), { recursive: true });

  savedEnv = {};
  for (const key of WATCHED_ENV) savedEnv[key] = process.env[key];
  process.env.ROOSYNC_SHARED_PATH = path.join(testDir, 'shared-state');
  process.env.ROOSYNC_MACHINE_ID = 'test-machine';
  process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
  delete process.env.UNIFIED_STORE_DASHBOARD_READ_PG;
  delete process.env.UNIFIED_STORE_DUAL_WRITE;
  delete process.env.UNIFIED_STORE_PG_URL;
  delete process.env.UNIFIED_STORE_CHANNEL_READ_PG;
  delete process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.EMBEDDING_API_KEY;
  delete process.env.EMBEDDING_API_BASE_URL;

  readDashboardFromPgFake.mockReset();
  dualWriteSyncSpy.mockClear();
});

afterEach(() => {
  for (const key of WATCHED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testDir, { recursive: true, force: true });
});

describe('#3230 write-side — append depuis copie locale en retard', () => {
  it('RÉPARATION : le fichier local manque 2 ids vivants de la vue PG → écriture complète, ids restaurés + message neuf', async () => {
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    // Vue PG en main : 3 messages vivants (a, b, c).
    readDashboardFromPgFake.mockResolvedValue({
      type: 'workspace',
      key: `workspace-${KEY}`,
      lastModified: '2026-09-28T22:00:00.000Z',
      lastModifiedBy: author,
      status: { markdown: '# Statut PG\n' },
      intercom: {
        messages: [pgMessage('ic-stale-a', 'contenu A'), pgMessage('ic-stale-b', 'contenu B'), pgMessage('ic-stale-c', 'contenu C')],
        totalMessages: 3,
      },
    });
    // Copie locale EN RETARD : n'a reçu que « a » — b et c jamais livrés par DriveFS.
    seedLocalFile([messageBlock('ic-stale-a', 'contenu A')]);

    const result = await roosyncDashboard({
      action: 'append', type: 'workspace', workspace: KEY, content: 'message neuf',
    }) as any;

    expect(result.success).toBe(true);
    const onDisk = readFileSync(path.join(dashboardsDir, FILE), 'utf8');
    // Spéc ai-01 : les DEUX ids manquants + le nouveau message.
    expect(onDisk).toContain('[msg: ic-stale-b]');
    expect(onDisk).toContain('[msg: ic-stale-c]');
    expect(onDisk).toContain('message neuf');
    // Le full-write est bien le chemin pris : dual-write appelé avec la vue complète.
    expect(dualWriteSyncSpy).toHaveBeenCalled();
  });

  it('UNIDIRECTIONNEL : un id présent au fichier mais absent de la vue survit à l’incrément', async () => {
    process.env.UNIFIED_STORE_DASHBOARD_READ_PG = '1';
    // Vue PG : a, b, c — le writer concurrent non-PG « x » n'y est pas encore.
    readDashboardFromPgFake.mockResolvedValue({
      type: 'workspace',
      key: `workspace-${KEY}`,
      lastModified: '2026-09-28T22:00:00.000Z',
      lastModifiedBy: author,
      status: { markdown: '# Statut PG\n' },
      intercom: {
        messages: [pgMessage('ic-stale-a', 'contenu A'), pgMessage('ic-stale-b', 'contenu B'), pgMessage('ic-stale-c', 'contenu C')],
        totalMessages: 3,
      },
    });
    // Fichier local : les 3 ids de la vue PLUS « x » (append concurrent livré,
    // pas encore miroité en PG). La garde ne doit PAS réécrire depuis la vue.
    seedLocalFile([
      messageBlock('ic-stale-a', 'contenu A'),
      messageBlock('ic-stale-b', 'contenu B'),
      messageBlock('ic-stale-c', 'contenu C'),
      messageBlock('ic-fileonly-x', 'contenu X — concurrent non-PG'),
    ]);

    const result = await roosyncDashboard({
      action: 'append', type: 'workspace', workspace: KEY, content: 'message neuf',
    }) as any;

    expect(result.success).toBe(true);
    const onDisk = readFileSync(path.join(dashboardsDir, FILE), 'utf8');
    expect(onDisk).toContain('[msg: ic-fileonly-x]');
    expect(onDisk).toContain('message neuf');
  });

  it('GATE OFF (contrôle) : vue = fichier, incrément inchangé — service intact', async () => {
    // Porte fermée : le vrai readDashboardFromPg rend null — le mock imite.
    readDashboardFromPgFake.mockResolvedValue(null);
    seedLocalFile([
      messageBlock('ic-stale-a', 'contenu A'),
      messageBlock('ic-stale-b', 'contenu B'),
    ]);

    const result = await roosyncDashboard({
      action: 'append', type: 'workspace', workspace: KEY, content: 'message neuf',
    }) as any;

    expect(result.success).toBe(true);
    const onDisk = readFileSync(path.join(dashboardsDir, FILE), 'utf8');
    expect(onDisk).toContain('[msg: ic-stale-a]');
    expect(onDisk).toContain('[msg: ic-stale-b]');
    expect(onDisk).toContain('message neuf');
  });
});
