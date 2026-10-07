/**
 * #3151 Phase C residual — la ligne `[msg: id]` doit survivre à l'archivage.
 *
 * Incident fondateur (po-2025, 07/10) : le message « adjoint-6d0db3c1-19440 »
 * de workspace-CoursIA-2 a atterri dans le canon GDrive mais jamais dans le
 * miroir PG (dual-write en échec silencieux), puis a été condensé hors du
 * canon — l'archive .md étant écrite SANS la ligne [msg:], l'id a disparu de
 * toute surface, rendant la guérison par le reconcile impossible (l'id EST
 * l'empreinte). Ces tests verrouillent le format d'archive émis par
 * `buildArchiveMessagesMarkdown` : la ligne [msg:] immédiatement sous le
 * header, dans la forme exacte que le parseur read_archive (v3 #1363) et la
 * passe archive-scan du reconcile attendent.
 */
import { describe, it, expect } from 'vitest';
import { buildArchiveMessagesMarkdown } from '../dashboard.js';
import type { IntercomMessage } from '../dashboard-schemas.js';

function msg(id: string, ts = '2026-10-07T23-05-18.000Z'): IntercomMessage {
  return {
    id,
    timestamp: ts,
    author: { machineId: 'myia-po-2025', workspace: 'Maintenance' },
    content: 'corps du message',
  };
}

describe('buildArchiveMessagesMarkdown (#3151 Phase C — [msg:] dans les archives)', () => {
  it('émet la ligne [msg: id] immédiatement sous le header', () => {
    const out = buildArchiveMessagesMarkdown([msg('adjoint-6d0db3c1-19440')]);
    expect(out).toBe(
      '### [2026-10-07T23-05-18.000Z] myia-po-2025|Maintenance\n' +
        '[msg: adjoint-6d0db3c1-19440]\n\n' +
        'corps du message'
    );
  });

  it('la ligne [msg:] matche le regex du parseur read_archive (ancre ^)', () => {
    // Même forme que dashboard.ts l.7316 : `^\[msg: ([^\]]+)\]\n` — la ligne
    // doit être collée au header pour que l'ancre ^ fonctionne après split.
    const out = buildArchiveMessagesMarkdown([msg('id-un', '2026-10-07T10:00:00.000Z')]);
    const header = out.split('\n')[0];
    const afterHeader = out.slice(header.length + 1);
    expect(afterHeader.match(/^\[msg: ([^\]]+)\]\n/)?.[1]).toBe('id-un');
  });

  it('plusieurs messages : séparés par ---, un [msg:] chacun', () => {
    const out = buildArchiveMessagesMarkdown([msg('id-a'), msg('id-b')]);
    const blocks = out.split('\n\n---\n\n');
    expect(blocks).toHaveLength(2);
    for (const [i, id] of ['id-a', 'id-b'].entries()) {
      expect(blocks[i]).toContain(`[msg: ${id}]`);
    }
  });

  it('round-trip avec le parseur archive-scan du reconcile (parseArchiveIdBearingMessages)', async () => {
    // Import dynamique pour éviter un cycle statique tools ↔ services.
    const { parseArchiveIdBearingMessages } = await import(
      '../../../services/unified-store/roosync-dashboard-reconcile.js'
    );
    const out = buildArchiveMessagesMarkdown([msg('id-rt')]);
    const parsed = parseArchiveIdBearingMessages(
      `---\ntype: archive\n---\n\n# Archive\n\n${out}\n`
    );
    expect(parsed.idless).toBe(0);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]).toEqual({
      id: 'id-rt',
      timestamp: '2026-10-07T23-05-18.000Z',
      machineId: 'myia-po-2025',
      workspace: 'Maintenance',
      content: 'corps du message',
    });
  });
});
