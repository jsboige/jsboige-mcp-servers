/**
 * #4643 grain writer — l'archive doit écrire `msg.tags`, et `read_archive`
 * (listing) doit distinguer « aucune archive » d'un listing en échec.
 *
 * Côté writer : le lecteur read_archive parse la ligne `[tags: …]` depuis
 * #4003, mais seul l'écrivain VIVANT l'émettait — une déclaration
 * `[DEGRADED]`/`[REPAIRED]` posée par l'API (tags sans jeton dans le corps)
 * devenait invisible une fois archivée, et l'organe check-degraded-escalations
 * ne pouvait plus fermer une escalade sur un `[REPAIRED]` consommé par la
 * condensation (cas mesuré 10/11 : sonnerie 6 h 22 après la réparation).
 *
 * Côté listing : un `readdir` en échec était servi `success:true, archives:[]`
 * — indistinguable d'une absence légitime. Le consommateur fail-closed de
 * #4643 ne peut pas voir sa « fenêtre d'archives AVEUGLE » sur cette réponse.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.mock('../heartbeat-activity.js', () => ({
  recordRooSyncActivityAsync: vi.fn(),
  recordSchedulerRunAsync: vi.fn(),
}));

// readdir seul est mocké (pass-through par défaut via importActual au
// beforeEach) : le test de listing en échec force UN rejet ; tout le reste du
// fs reste réel. Pas de `let` module-level capturé par le factory — vi.mock
// est hoisté au-dessus du corps du module (TDZ mesuré au premier run).
const { mockReaddir } = vi.hoisted(() => ({ mockReaddir: vi.fn() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, readdir: (...args: Parameters<typeof actual.readdir>) => mockReaddir(...args) };
});

import { roosyncDashboard, buildArchiveMessagesMarkdown } from '../dashboard.js';
import type { IntercomMessage } from '../dashboard-schemas.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-archive-tags-');

function msg(overrides: Partial<IntercomMessage> = {}): IntercomMessage {
  return {
    id: 'myia-po-2027:roo-extensions:ic-repaired-1',
    timestamp: '2026-11-10T17:32:50.585Z',
    author: { machineId: 'myia-po-2027', workspace: 'roo-extensions' },
    content: 'escalade transport close par cette meme lane',
    ...overrides,
  };
}

describe('buildArchiveMessagesMarkdown (#4643 grain writer — [tags:] survit à l\'archivage)', () => {
  it('émet la ligne [tags:] entre [msg:] et le corps, même forme que le writer vivant (#4003)', () => {
    const out = buildArchiveMessagesMarkdown([
      msg({ tags: ['REPAIRED', 'claude-interactive'] }),
    ]);
    expect(out).toBe(
      '### [2026-11-10T17:32:50.585Z] myia-po-2027|roo-extensions\n' +
        '[msg: myia-po-2027:roo-extensions:ic-repaired-1]\n' +
        '[tags: REPAIRED, claude-interactive]\n\n' +
        'escalade transport close par cette meme lane'
    );
  });

  it('sans tags : format legacy exact, aucune ligne [tags:] ajoutée', () => {
    const out = buildArchiveMessagesMarkdown([msg()]);
    expect(out).toBe(
      '### [2026-11-10T17:32:50.585Z] myia-po-2027|roo-extensions\n' +
        '[msg: myia-po-2027:roo-extensions:ic-repaired-1]\n\n' +
        'escalade transport close par cette meme lane'
    );
    expect(out).not.toContain('[tags:');
  });

  it('la ligne [tags:] matche l\'ancre ^ du parseur read_archive, juste après [msg:]', () => {
    // Le parseur enchaîne les regex ancrés ^ : [msg:] puis [tags:] collés au
    // header. La ligne doit être à cette position exacte pour être consommée.
    const out = buildArchiveMessagesMarkdown([msg({ tags: ['DEGRADED'] })]);
    const afterHeader = out.split('\n').slice(1).join('\n');
    expect(afterHeader.match(/^\[msg: ([^\]]+)\]\n\[tags: ([^\]]+)\]\n/)).toEqual(
      expect.arrayContaining(['myia-po-2027:roo-extensions:ic-repaired-1', 'DEGRADED'])
    );
  });
});

describe('read_archive #4643 — round-trip tags + listing fail-closed', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    mockReaddir.mockImplementation((...args: Parameters<typeof actual.readdir>) =>
      actual.readdir(...args));
  });

  afterEach(async () => {
    mockReaddir.mockReset();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trip : les tags écrits par l\'archive writer reviennent dans archiveData.messages[].tags', async () => {
    const key = 'workspace-test-workspace';
    const archiveFile = `${key}-20261110T2100.md`;
    // L'archive est écrite PAR le writer de cette PR (pas un fixture à la main)
    // — c'est le round-trip complet qui est éprouvé.
    const body = buildArchiveMessagesMarkdown([
      msg({
        id: 'test-machine:test-workspace:ic-1',
        timestamp: '2026-11-10T17:32:50.585Z',
        author: { machineId: 'test-machine', workspace: 'test-workspace' },
        tags: ['REPAIRED'],
      }),
    ]);
    const archiveDir = path.join(tmpDir, 'dashboards', 'archive');
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      path.join(archiveDir, archiveFile),
      [
        '---',
        'type: workspace',
        `originalKey: ${key}`,
        'archivedAt: 2026-11-10T21:00:47.000Z',
        'messageCount: 1',
        '---',
        '',
        body,
        '',
      ].join('\n'),
      'utf8'
    );

    const res = await roosyncDashboard({ action: 'read_archive', type: 'workspace', archiveFile });
    expect(res.success).toBe(true);
    const messages = (res as any).archiveData.messages as IntercomMessage[];
    expect(messages).toHaveLength(1);
    expect(messages[0].tags).toEqual(['REPAIRED']);
    expect(messages[0].content).toBe('escalade transport close par cette meme lane');
  });

  it('listing vide légitime : success:true et 0 archive(s) — PAS une erreur', async () => {
    const res = await roosyncDashboard({ action: 'read_archive', type: 'workspace' });
    expect(res.success).toBe(true);
    expect((res as any).archives).toEqual([]);
    expect((res as any).message).toContain('0 archive(s)');
  });

  it('readdir en échec : success:false qui nomme l\'échec — jamais « aucune archive »', async () => {
    const eperm = Object.assign(new Error('EACCES: permission denied, scandir'), {
      code: 'EACCES',
    });
    mockReaddir.mockRejectedValueOnce(eperm);
    const res = await roosyncDashboard({ action: 'read_archive', type: 'workspace' });
    expect(res.success).toBe(false);
    expect((res as any).message).toContain('Impossible de lister');
    expect((res as any).message).toContain('EACCES');
    // La liste vide légitime (test précédent) et l'échec ne se distinguent
    // PLUS par le seul message : c'est success qui tranche, pour qu'un
    // consommateur fail-closed voie sa fenêtre aveugle.
  });
});
