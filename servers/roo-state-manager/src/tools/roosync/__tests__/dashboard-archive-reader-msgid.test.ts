/**
 * #4643 suite — lecteur d'archive : l'id persisté doit revenir TEL QUEL.
 *
 * Signal `r1210-warn-scope-messageid-archived` (ai-01, 24/11 08:15Z) : un
 * `[REPAIRED]` portant `scope: <messageId>` ne ferme plus une escalade une fois
 * celle-ci archivée, et l'organe re-sonne une lane réparée.
 *
 * Cause (lecteur, pas le transport, pas l'organe) : la regex d'en-tête de
 * `handleReadArchive` portait un groupe optionnel de tags legacy `(\s+\[...\])?`
 * dont le `\s+` franchit le retour à la ligne. Quand la ligne `[msg: <id>]`
 * suit immédiatement l'en-tête — la forme exacte émise par
 * `buildArchiveMessagesMarkdown` — elle était absorbée par ce groupe.
 * `persistedId` restait undefined et l'id servi était régénéré à la lecture,
 * horodatage compris. Les tags et le contenu restaient intacts : c'est
 * exactement ce que les tests #4643 épinglaient, et pourquoi la suite était
 * verte. Le parseur principal (dashboard-markdown.ts) écrit ce groupe avec une
 * espace littérale et ne perd pas l'id ; seul le lecteur d'archive dérivait.
 *
 * Ces tests passent par le VRAI point d'entrée `roosyncDashboard read_archive`
 * — jamais un `afterHeader` reconstruit à la main, qui court-circuite la regex
 * fautive (test existant de dashboard-archive-msg-id.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.mock('../heartbeat-activity.js', () => ({
  recordRooSyncActivityAsync: vi.fn(),
  recordSchedulerRunAsync: vi.fn(),
}));

import { roosyncDashboard, buildArchiveMessagesMarkdown } from '../dashboard.js';
import type { IntercomMessage } from '../dashboard-schemas.js';

const testTmpBase = path.join(os.tmpdir(), 'dashboard-archive-reader-msgid-');

/** Bloc réel de l'incident (archive Epita du 24/11 06:05Z), raccourci au nécessaire. */
const ESCALATION_ID = 'r1208-degraded-codebase-search';
const REPAIR_ID = 'r1209-repaired-codebase-search';
const ESCALATION_TS = '2026-11-23T16:44:51.194Z';
const REPAIR_TS = '2026-11-23T23:50:48.405Z';

function msg(id: string, ts: string, content: string, tags?: string[]): IntercomMessage {
  return {
    id,
    timestamp: ts,
    author: { machineId: 'myia-ai-01', workspace: 'test-workspace' },
    content,
    ...(tags ? { tags } : {}),
  };
}

describe('read_archive — id persisté servi tel quel (signal r1210)', () => {
  let tmpDir: string;

  async function readArchiveOf(body: string): Promise<IntercomMessage[]> {
    const key = 'workspace-test-workspace';
    const archiveFile = `${key}-20261124T0605.md`;
    const archiveDir = path.join(tmpDir, 'dashboards', 'archive');
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      path.join(archiveDir, archiveFile),
      [
        '---',
        'type: workspace',
        `originalKey: ${key}`,
        'archivedAt: 2026-11-24T06:05:25.000Z',
        'messageCount: 2',
        '---',
        '',
        body,
        '',
      ].join('\n'),
      'utf8'
    );
    const res = await roosyncDashboard({ action: 'read_archive', type: 'workspace', archiveFile });
    expect(res.success).toBe(true);
    return (res as any).archiveData.messages as IntercomMessage[];
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(testTmpBase);
    process.env.ROOSYNC_SHARED_PATH = tmpDir;
    process.env.ROOSYNC_MACHINE_ID = 'test-machine';
    process.env.ROOSYNC_WORKSPACE_ID = 'test-workspace';
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_CHAT_MODEL_ID;
    delete process.env.EMBEDDING_API_KEY;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('escalade + réparation archivées : les DEUX ids reviennent inchangés (scope: <messageId> reste résoluble)', async () => {
    const body = buildArchiveMessagesMarkdown([
      msg(
        ESCALATION_ID,
        ESCALATION_TS,
        '[DEGRADED] codebase_search indisponible.\n' +
          `Seul un [REPAIRED] de cette lane fermera cette escalade : \`scope: ${ESCALATION_ID}\`.`,
        ['DEGRADED', 'R1208']
      ),
      msg(REPAIR_ID, REPAIR_TS, `[REPAIRED] deux lectures saines.\nscope: ${ESCALATION_ID}`, [
        'REPAIRED',
      ]),
    ]);
    const messages = await readArchiveOf(body);

    expect(messages.map((m) => m.id)).toEqual([ESCALATION_ID, REPAIR_ID]);
    expect(messages[0].timestamp).toBe(ESCALATION_TS);
    expect(messages[1].timestamp).toBe(REPAIR_TS);
    expect(messages[0].tags).toEqual(['DEGRADED', 'R1208']);
    expect(messages[1].tags).toEqual(['REPAIRED']);
    expect(messages[0].content).toContain('codebase_search indisponible');
    expect(messages[1].content).toContain(`scope: ${ESCALATION_ID}`);
  });

  it('sans tags : l\'id revient aussi (format #3151 minimal)', async () => {
    const body = buildArchiveMessagesMarkdown([
      msg('adjoint-6d0db3c1-19440', '2026-10-07T23:05:18.000Z', 'corps du message'),
    ]);
    const messages = await readArchiveOf(body);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('adjoint-6d0db3c1-19440');
    expect(messages[0].content).toBe('corps du message');
  });

  it('[reply-to:] juste sous [msg:] : l\'id ET le reply_to reviennent', async () => {
    const body =
      '### [2026-11-23T16:44:51.194Z] myia-ai-01|test-workspace\n' +
      `[msg: ${ESCALATION_ID}]\n` +
      '[reply-to: r1207-earlier-thread]\n' +
      '[tags: DEGRADED]\n\n' +
      'corps de la reponse';
    const messages = await readArchiveOf(body);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(ESCALATION_ID);
    expect(messages[0].reply_to).toBe('r1207-earlier-thread');
    expect(messages[0].tags).toEqual(['DEGRADED']);
    expect(messages[0].content).toBe('corps de la reponse');
  });

  it('header legacy avec tags en fin de ligne : toujours toléré, id lu quand même, tags du header ignorés', async () => {
    const body =
      '### [2026-11-23T16:44:51.194Z] myia-ai-01|test-workspace [LEGACY-TAG]\n' +
      `[msg: ${ESCALATION_ID}]\n\n` +
      'corps legacy';
    const messages = await readArchiveOf(body);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(ESCALATION_ID);
    expect(messages[0].content).toBe('corps legacy');
    expect(messages[0].tags).toBeUndefined();
  });

  it('archive ancienne sans [msg:] : la première ligne du corps, un crochet seul, n\'est pas absorbée', async () => {
    // Même défaut, autre victime : si le groupe de tags legacy franchit le
    // retour à la ligne, un corps qui commence par un jeton seul (`[DONE]`)
    // perd sa première ligne. Ici l'id est régénéré de toute façon (pas de
    // [msg:]) — c'est le contenu qui est éprouvé.
    const body =
      '### [2026-11-23T16:44:51.194Z] myia-ai-01|test-workspace\n' +
      '\n' +
      '[DONE]\n' +
      '\n' +
      'corps du message';
    const messages = await readArchiveOf(body);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('[DONE]\n\ncorps du message');
  });
});
