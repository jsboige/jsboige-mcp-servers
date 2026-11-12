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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildArchiveMessagesMarkdown } from '../dashboard.js';
import type { IntercomMessage } from '../dashboard-schemas.js';

// #4643 — le chemin temp→rename est le CONTRAT de writeArchiveAtomically
// (l'écriture directe laisse une coque de 0 octet si l'hôte meurt
// mi-écriture). Un namespace ESM n'est pas spyOn-able : vi.mock + vi.hoisted
// (patron ms#1737 — jamais de `let` module-level capturé par le factory,
// TDZ), pass-through réel vers l'implémentation native.
const { renameCalls } = vi.hoisted(() => ({
  renameCalls: [] as Array<[string, string]>,
}));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    rename: (async (from: string, to: string) => {
      renameCalls.push([from, to]);
      return actual.rename(from, to);
    }) as typeof actual.rename,
  };
});

beforeEach(() => {
  renameCalls.length = 0;
});

function msg(id: string, ts = '2026-10-07T23-05-18.000Z', content = 'corps du message'): IntercomMessage {
  return {
    id,
    timestamp: ts,
    author: { machineId: 'myia-po-2025', workspace: 'Maintenance' },
    content,
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

  it('#4344 — échappe un « ### [ » cité en début de ligne du corps (même règle que le writer vivant #1123)', () => {
    // Un rapport d'incident qui CITE une ligne de dashboard embarque un faux
    // header. Non échappé, il serait re-parsé comme activité réelle par la
    // lecture d'archives élargie (#4344) — fantôme de liveness.
    const quoted =
      'constat ce cycle :\n' +
      '### [2026-10-26T20:30:00.000Z] myia-po-2026|CoursIA\n' +
      'message cité tel quel.';
    const out = buildArchiveMessagesMarkdown([msg('id-quote', '2026-10-27T10:00:00.000Z', quoted)]);
    // Le VRAI header du message reste intact (première ligne)…
    expect(out.split('\n')[0]).toBe('### [2026-10-27T10:00:00.000Z] myia-po-2025|Maintenance');
    // …et la citation est échappée : plus aucune ligne ne commence par « ### [ »
    // en dehors du header du bloc.
    const bodyLines = out.split('\n').slice(1);
    expect(bodyLines.some(l => /^### \[/.test(l))).toBe(false);
    expect(out).toContain('\\#\\#\\# [2026-10-26T20:30:00.000Z] myia-po-2026|CoursIA');
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
      // #4643 — pas de ligne [tags:] dans cette archive : tableau vide.
      tags: [],
    });
  });

  it('#4643 — round-trip tags : la ligne [tags:] portée par le writer remonte en champ, pas dans le contenu', async () => {
    const { parseArchiveIdBearingMessages } = await import(
      '../../../services/unified-store/roosync-dashboard-reconcile.js'
    );
    const tagged: IntercomMessage = {
      ...msg('id-tagged'),
      tags: ['REPAIRED', 'claude-interactive'],
    };
    const out = buildArchiveMessagesMarkdown([tagged]);
    const parsed = parseArchiveIdBearingMessages(
      `---\ntype: archive\n---\n\n# Archive\n\n${out}\n`
    );
    expect(parsed.idless).toBe(0);
    expect(parsed.messages[0].tags).toEqual(['REPAIRED', 'claude-interactive']);
    // La ligne est ÉPURÉE du contenu servi : le tag vit dans le champ.
    expect(parsed.messages[0].content).toBe('corps du message');
    expect(parsed.messages[0].content).not.toContain('[tags:');
  });

  it('#4643 — la séquence [msg:]→[reply-to:]→[ack:]→[tags:] traverse comme le lecteur canonique', async () => {
    // Ordre d'émission #4003 : le reconcile doit traverser reply-to et ack
    // pour ATTEINDRE la ligne [tags:] — et aucune ligne méta ne fuite dans le
    // contenu de la ligne guérie.
    const { parseArchiveIdBearingMessages } = await import(
      '../../../services/unified-store/roosync-dashboard-reconcile.js'
    );
    const block =
      '### [2026-10-07T23-05-18.000Z] myia-po-2025|Maintenance\n' +
      '[msg: id-meta]\n' +
      '[reply-to: id-parent]\n' +
      '[ack: id-acked]\n' +
      '[tags: DONE, claude-interactive]\n\n' +
      'corps réel du message';
    const parsed = parseArchiveIdBearingMessages(block);
    expect(parsed.idless).toBe(0);
    expect(parsed.messages[0]).toEqual({
      id: 'id-meta',
      timestamp: '2026-10-07T23-05-18.000Z',
      machineId: 'myia-po-2025',
      workspace: 'Maintenance',
      content: 'corps réel du message',
      tags: ['DONE', 'claude-interactive'],
    });
  });

  it('#4643 — [tags:] vide ou absente : tags [] sans perte de contenu', async () => {
    const { parseArchiveIdBearingMessages } = await import(
      '../../../services/unified-store/roosync-dashboard-reconcile.js'
    );
    const empty =
      '### [2026-10-07T23-05-18.000Z] m|w\n[msg: id-e]\n[tags: ]\n\ncorps';
    const absent =
      '### [2026-10-07T23-05-18.000Z] m|w\n[msg: id-a]\n\ncorps';
    expect(parseArchiveIdBearingMessages(empty).messages[0]).toEqual({
      id: 'id-e', timestamp: '2026-10-07T23-05-18.000Z',
      machineId: 'm', workspace: 'w', content: 'corps', tags: [],
    });
    expect(parseArchiveIdBearingMessages(absent).messages[0]).toEqual({
      id: 'id-a', timestamp: '2026-10-07T23-05-18.000Z',
      machineId: 'm', workspace: 'w', content: 'corps', tags: [],
    });
  });
});

describe('writeArchiveAtomically (#4643 — jamais de coque de 0 octet)', () => {
  it('pose le fichier final complet et ne laisse aucun .tmp', async () => {
    const { writeArchiveAtomically } = await import('../dashboard.js');
    const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'rsm4643-atomic-'));
    try {
      const target = join(dir, 'workspace-x-2026-11-12T04-00-00.md');
      const content = '---\ntype: workspace\n---\n\ncorps complet';
      await writeArchiveAtomically(target, content);
      // Le rename a bien servi le chemin temporaire vers le final…
      expect(renameCalls).toEqual([[`${target}.tmp`, target]]);
      // Le fichier final existe avec TOUT le contenu…
      expect(await readFile(target, 'utf8')).toBe(content);
      // …et aucun temporaire ne survit au rename.
      expect(await readdir(dir)).toEqual(['workspace-x-2026-11-12T04-00-00.md']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('échec du rename : le temporaire est retiré, le final n’apparaît pas', async () => {
    const { writeArchiveAtomically } = await import('../dashboard.js');
    const { mkdtemp, mkdir, readdir, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'rsm4643-atomic-fail-'));
    try {
      // Un RÉPERTOIRE sur le chemin final fait échouer le rename APRÈS
      // l'écriture du temporaire (fichier → répertoire) : c'est le chemin de
      // nettoyage du helper qui est exercé, pas un échec d'écriture.
      const blockedTarget = join(dir, 'target.md');
      await mkdir(blockedTarget);
      await expect(
        writeArchiveAtomically(blockedTarget, 'contenu')
      ).rejects.toThrow();
      // Aucun temporaire .md.tmp ne survit à l'échec du rename.
      expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
