/**
 * #4434 — un corps de message commençant une ligne par `## ` ouvrait une FAUSSE
 * section de niveau 2 dans le fichier dashboard.
 *
 * Mesure fondatrice (myia-web1, 31/10) : `machine-myia-po-2023.md` porte DEUX
 * `## Résumé des N messages archivés` — chacun est le corps du message de
 * condensation (`generateLLMSummary` demande un titre `## `), pas une section.
 * `buildDashboardMarkdown` n'échappait que `### [` (le découpage en MESSAGES) ;
 * le découpage en SECTIONS (`^## `) restait exposé.
 *
 * Ces tests épinglent les deux moitiés ensemble : l'échappement à l'écriture et
 * le dés-échappement à la relecture. Une moitié seule passe le round-trip en
 * faisant fuiter des backslashes dans le contenu relu, ou en laissant la fausse
 * section. Le mutant qui les sépare doit rougir.
 */
import { describe, it, expect } from 'vitest';
import { buildDashboardMarkdown } from '../dashboard.js';
import { parseDashboardMarkdown } from '../dashboard-markdown.js';

const SUMMARY_BODY = [
  '**CONDENSATION-SUMMARY** - 2026-10-23T21:39:40.205Z',
  '',
  '## Résumé des 135 messages archivés',
  '',
  '### Thèmes principaux',
  '- merges et CI',
].join('\n');

function makeDashboard(content: string, statusMarkdown = 'État de la machine.') {
  return {
    type: 'machine' as const,
    lastModified: '2026-10-31T00:00:00.000Z',
    lastModifiedBy: { machineId: 'myia-web1', workspace: 'roo-extensions' },
    status: { markdown: statusMarkdown },
    intercom: {
      totalMessages: 1,
      lastCondensedAt: '2026-10-23T21:39:40.205Z',
      messages: [
        {
          id: 'condensation-summary-1',
          timestamp: '2026-10-23T21:39:40.205Z',
          author: { machineId: 'system', workspace: 'system' },
          content,
        },
      ],
    },
  };
}

/** Lignes qui, dans le fichier, seraient lues comme une section de niveau 2. */
const topLevelHeadings = (md: string): string[] =>
  md.split('\n').filter(l => /^## /.test(l));

describe('#4434 — a message body cannot open a fake level-2 section', () => {
  it('escapes a line starting with "## " and keeps exactly the two real sections', () => {
    const md = buildDashboardMarkdown(makeDashboard(SUMMARY_BODY) as never);

    // Les seules sections réelles d'un dashboard sérialisé.
    expect(topLevelHeadings(md)).toEqual(['## Status', '## Intercom (1 messages)']);
    // La forme mesurée sur machine-myia-po-2023 ne doit plus pouvoir apparaître.
    expect(md).not.toMatch(/^## Résumé des \d+ messages archivés/gm);
    // Échappée, pas supprimée : la ligne est toujours là, préfixée.
    expect(md).toContain('\\#\\# Résumé des 135 messages archivés');
  });

  it('round-trips: the parsed content is byte-identical to what was written', () => {
    const md = buildDashboardMarkdown(makeDashboard(SUMMARY_BODY) as never);
    const parsed = parseDashboardMarkdown(md, 'machine-myia-web1');

    expect(parsed.intercom.messages).toHaveLength(1);
    expect(parsed.intercom.messages[0].content).toBe(SUMMARY_BODY);
  });

  it('still escapes the message-header form "### [" (no regression, #1123)', () => {
    const body = '### [2026-01-01T00:00:00.000Z] fake|workspace\n\nshould not split';
    const md = buildDashboardMarkdown(makeDashboard(body) as never);
    const parsed = parseDashboardMarkdown(md, 'machine-myia-web1');

    expect(parsed.intercom.messages).toHaveLength(1);
    expect(parsed.intercom.messages[0].content).toBe(body);
  });

  it('leaves a mid-line "## " untouched (the rule is anchored at line start)', () => {
    const body = 'la commande ## foo n’ouvre rien';
    const md = buildDashboardMarkdown(makeDashboard(body) as never);

    expect(md).toContain(body);
    expect(parseDashboardMarkdown(md, 'machine-myia-web1').intercom.messages[0].content).toBe(body);
  });

  it('does NOT escape the status markdown (real sections live there)', () => {
    const md = buildDashboardMarkdown(
      makeDashboard('body', '## Blocages structurels\n- rien') as never
    );

    // Le statut EST la zone des vraies sections : son titre reste brut, et il est
    // le seul titre ajouté en plus des deux sections structurelles.
    expect(topLevelHeadings(md)).toEqual([
      '## Status',
      '## Blocages structurels',
      '## Intercom (1 messages)',
    ]);
    expect(md).toContain('\n## Blocages structurels\n');
  });
});
