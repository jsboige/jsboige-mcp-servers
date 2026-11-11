/**
 * #4434 (09/11) — passe de budget de statut déterministe (sans LLM).
 *
 * Mesure ai-01 09/11 (commentaire c.6739556626) : le générateur dépasse le
 * budget par section du prompt dans CHAQUE section (×1,4 à ×6,8), et 7 passes
 * sur 8 finissaient au plancher d'octets avec perte. Cette suite épingle la
 * passe qui court ENTRE generateStatusUpdate et condenseTextIfTooLarge :
 *
 *   P.  no-op — un statut déjà sous budget partout ressort OCTET POUR OCTET
 *       identique (la passe ne touche jamais ce qu'elle n'a pas à toucher).
 *   B.  budget par section — les puces ENTIÈRES partent (jamais coupées au
 *       milieu), verbatim, jusqu'à revenir sous le budget en mots ; l'ordre de
 *       sortie : le marqueur de date le plus ancien d'abord (`JJ/MM`,
 *       `[vérifié …]`, à égalité la plus haute), puis les non datées par la
 *       QUEUE de la section ; une section n'est jamais vidée.
 *   R.  Blocages — les lignes RÉSOLU/REFUTE de plus de 24 h partent (règle
 *       #4082) ; tout le reste reste : marqueur frais, marqueur sans date
 *       lisible, « NON/PAS RÉSOLU » (blocage ACTIF), blocage non marqué. La
 *       section porte un plafond de mots DEPUIS #4434 résiduel C1 (mesuré
 *       833 mots / 57 puces actives : le fallback ne convergeait plus) :
 *       l'excédent part en puces ENTIÈRES verbatim vers l'archive #4434,
 *       les plus anciennement vérifiées d'abord — jamais supprimé, jamais
 *       la section vidée.
 *   A.  archive — les puces déplacées et les lignes retirées atterrissent
 *       VERBATIM sous leur section d'origine ; null quand la passe est no-op.
 *   C.  contrats de comptage — le marqueur de puce ne compte pas comme mot ;
 *       une ligne de prose ne compte pas et ne se déplace pas ; l'année
 *       glissante des tampons sans année suit l'heurétique du plancher.
 *
 * Hors d'atteinte unitaire (comme pour le plancher, cf.
 * dashboard.truncation-fixtures.test.ts) : la composition au call-site — la
 * télémétrie logger et l'insertion dans l'archive de la passe vivent dans le
 * pipeline de condensation complet.
 *
 * Témoins de mutation (exécutés au cycle, consignés dans la PR) :
 *   M1 retrait >24h → >=24h                                 → R1 rouge (frontière 24 h pile)
 *   M2 marqueur sans date retrait quand même                → R3 rouge
 *   M3 négateur NON/PAS ignoré                              → R4 rouge
 *   M4 ordre datées/non-datées inversé                      → B3 rouge
 *   M5 non datées prises par la tête                        → B3 rouge
 *   M6 stop « sous budget » retiré (tout part)              → B2 rouge (sur B1,
 *       le stop coïncide avec la garde « jamais vider » :
 *       4 puces → 3 départs dans les deux cas)
 *   M7 garde « jamais vider » (en boucle) retirée           → B4 rouge (la
 *       garde d'entrée masque le cas mono-puce : il faut une
 *       section à 2 puces où le stop ne suffit jamais)
 *   M8 marqueur de puce compté comme mot                    → C1 rouge
 *   M9 tampon hors calendrier lu comme une date             → C3 rouge
 *   M10 année glissante retirée                             → C4 rouge
 *   M11 archive : puces reformulées au lieu de verbatim     → A2 rouge
 *   M12 archive : section écrite même sans action           → A3 rouge
 *   M13 puce déjà retirée comptée/re-déplacée (budget
 *       Blocages + retraite 24 h composées)                 → R8 rouge
 *   M14 topLevelBlocks retiré (parent daté parti seul,
 *       sous-puces orphelines dans le statut vivant)        → R9 rouge
 *
 * @module tools/roosync/__tests__/dashboard.status-budget
 */

import { describe, it, expect, vi } from 'vitest';
import {
  enforceStatusBudget,
  buildStatusBudgetArchiveSection,
  STATUS_SECTION_WORD_BUDGETS,
  statusBudgetPromptLines
} from '../dashboard.js';

// Miroir du mock minimal de dashboard.truncation-fixtures.test.ts : l'import
// du module dashboard tire @/services/openai au niveau module.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => null,
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/**
 * Puce de n mots EXACTEMENT (marqueur `- ` non compris, comme la passe),
 * marquée par un identifiant unique : l'id et le suffixe (tampon de date)
 * comptent dans les n. Les tests font leur arithmétique sur ce total.
 */
const bullet = (id: string, words: number, suffix = ''): string => {
  const extra = 1 + (suffix.trim() ? suffix.trim().split(/\s+/).length : 0);
  const bodyWords = words - extra;
  if (bodyWords < 0) throw new Error(`bullet(${id}): ${words} mots < ${extra} (id + suffixe)`);
  const body = Array.from({ length: bodyWords }, (_, i) => `w${i}`).join(' ');
  return `- [${id}]${bodyWords > 0 ? ` ${body}` : ''}${suffix ? suffix : ''}`;
};

/** Mots comptés par la passe (contrat C) : sans le marqueur de puce. */
const countWords = (line: string) =>
  line.replace(/^\s*[-*]\s+/, '').split(/\s+/).filter(Boolean).length;

/** Mots de la section `heading` dans un statut rendu (frontière accent-safe). */
const sectionWords = (status: string, heading: string): number => {
  const ls = status.split('\n');
  const start = ls.findIndex((l) => new RegExp(`^#{1,6}\\s*${heading}(?![A-Za-zÀ-ÿ])`, 'i').test(l));
  expect(start, `section ${heading} présente`).not.toBe(-1);
  let end = ls.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
  if (end === -1) end = ls.length;
  return ls
    .slice(start + 1, end)
    .filter((l) => /^\s*[-*]\s+\S/.test(l))
    .reduce((a, l) => a + countWords(l), 0);
};

describe('#4434 (09/11) — passe de budget de statut déterministe', () => {
  describe('P — no-op : sous budget partout, sortie identique', () => {
    it('P1 — statut conforme : octet pour octet identique, rien déplacé, rien retiré', () => {
      const status = [
        '## [workspace] — État au 2026-11-09T12:00Z',
        '### Résumé',
        bullet('r1', 20),
        '### État des systèmes',
        bullet('s1', 60),
        '### Blocages structurels',
        bullet('b1', 20, ' [vérifié 08/11 10:00Z]'),
        bullet('b2', 20, ' REFUTE 09/11 05:00Z'), // 7 h : gardé
        '### Patterns appris',
        bullet('p1', 30),
      ].join('\n');
      const out = enforceStatusBudget(status, new Date('2026-11-09T12:00:00Z'));
      expect(out.status).toBe(status);
      expect(out.bytesAfter).toBe(out.bytesBefore);
      expect(out.moved).toEqual([]);
      expect(out.retiredBlockerLines).toEqual([]);
    });

    it('P2 — idempotence : la passe sur sa propre sortie ne déplace plus rien', () => {
      const status = [
        '## [workspace] — État au 2026-11-09T12:00Z',
        '### Patterns appris',
        bullet('p1', 40, ' [vérifié 07/11 09:00Z]'),
        bullet('p2', 40),
        bullet('p3', 40, ' [vérifié 05/11 09:00Z]'),
        bullet('p4', 40),
      ].join('\n');
      const first = enforceStatusBudget(status, new Date('2026-11-09T12:00:00Z'));
      expect(first.moved.length).toBe(1); // la passe a bien travaillé…
      const second = enforceStatusBudget(first.status, new Date('2026-11-09T12:00:00Z'));
      expect(second.status).toBe(first.status); // …et ne retravaille pas
      expect(second.moved).toEqual([]);
    });
  });

  describe('B — budget par section : puces entières, ordre, stop, jamais vide', () => {
    // 4 puces de 30 mots = 120 mots pour un budget Patterns appris de 55 :
    // 3 départs ramènent à 30 (120→90→60→30 ; 60 > 55 force le 3e).
    const now = new Date('2026-11-09T12:00:00Z');

    it('B1 — section sur budget : revenu sous 55 mots, titre gardé, puces entières', () => {
      const status = [
        '## [workspace] — État au 2026-11-09T12:00Z',
        '### Patterns appris',
        bullet('p-frais', 30, ' [vérifié 09/11 08:00Z]'),
        bullet('p-moyen', 30, ' [vérifié 06/11 08:00Z]'),
        bullet('p-vieux', 30, ' [vérifié 02/11 08:00Z]'),
        bullet('p-nodate', 30),
      ].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(sectionWords(out.status, 'Patterns appris')).toBeLessThanOrEqual(55);
      expect(out.status).toContain('### Patterns appris');
      expect(out.status).toContain('- [p-nodate]'); // la non datée reste (le stop tombe avant elle)
      // Chaque ligne rendue est une ligne ENTIÈRE de l'entrée, jamais coupée.
      const kept = out.status.split('\n');
      for (const line of kept) {
        if (line.startsWith('- [')) expect(status.split('\n')).toContain(line);
      }
      expect(out.moved).toHaveLength(1);
      expect(out.moved[0].section).toBe('Patterns appris');
      expect(out.moved[0].moved).toBe(3); // vieux, moyen, frais — dans cet ordre
      expect(out.moved[0].bullets).toEqual([
        bullet('p-vieux', 30, ' [vérifié 02/11 08:00Z]'),
        bullet('p-moyen', 30, ' [vérifié 06/11 08:00Z]'),
        bullet('p-frais', 30, ' [vérifié 09/11 08:00Z]')
      ]);
    });

    it('B2 — stop dès le retour sous budget : UN seul départ quand il suffit', () => {
      // 5 puces de 12 mots = 60 pour un budget de 55 : un seul départ (le plus
      // ancien) ramène à 48. Un mutant sans stop (M6) viderait jusqu'à la
      // garde « jamais vider » (4 départs) — les formes où le stop et la garde
      // coïncident (B1 : 4 puces) ne les distinguent pas.
      const status = [
        '### Patterns appris',
        bullet('p1', 12, ' [vérifié 01/11 08:00Z]'),
        bullet('p2', 12),
        bullet('p3', 12),
        bullet('p4', 12),
        bullet('p5', 12),
      ].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(out.moved[0].moved).toBe(1);
      expect(out.moved[0].bullets).toEqual([bullet('p1', 12, ' [vérifié 01/11 08:00Z]')]);
      expect(sectionWords(out.status, 'Patterns appris')).toBe(48);
    });

    it('B3 — ordre : daté le plus ancien d\'abord (à égalité la plus haute), puis non daté par la queue', () => {
      const status = [
        '### Patterns appris',
        bullet('n1', 30),
        bullet('old-a', 30, ' [vérifié 02/11 08:00Z]'),
        bullet('old-b', 30, ' [vérifié 02/11 08:00Z]'), // même date, plus bas
        bullet('mid', 30, ' [vérifié 05/11 08:00Z]'),
        bullet('n2', 30),
      ].join('\n');
      const out = enforceStatusBudget(status, now);
      // 150 mots, budget 55 : 4 départs — old-a (ancienne, la plus haute des
      // deux ex æquo), old-b, mid, puis n2 la non datée par la QUEUE (pas n1).
      expect(out.moved[0].bullets).toEqual([
        bullet('old-a', 30, ' [vérifié 02/11 08:00Z]'),
        bullet('old-b', 30, ' [vérifié 02/11 08:00Z]'),
        bullet('mid', 30, ' [vérifié 05/11 08:00Z]'),
        bullet('n2', 30),
      ]);
      expect(out.status).toContain('- [n1]'); // tête non datée : ne part qu'après la queue
      expect(sectionWords(out.status, 'Patterns appris')).toBe(30);
    });

    it('B4 — jamais vider : la garde d\'entrée garde une puce seule, la garde en boucle s\'arrête à la dernière', () => {
      // Deux puces de 80 mots (160, budget En cours 60) : le stop ne suffit
      // jamais (80 > 60 après un départ), seule la garde « jamais vider »
      // arrête — UNE puce part, l'autre reste (sur le budget : la garde est
      // dure). Un mutant sans garde en boucle (M7) viderait la section ; la
      // garde d'entrée (bullets.length <= 1) masque le cas mono-puce.
      const b1 = bullet('b1', 80, ' [vérifié 01/11 08:00Z]');
      const b2 = bullet('b2', 80);
      const status = ['### En cours', b1, b2].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(out.moved).toHaveLength(1);
      expect(out.moved[0].bullets).toEqual([b1]); // la datée part, la queue reste
      expect(out.status).toContain('- [b2]');
      expect(out.status).toContain('### En cours'); // et la section survit, habitée
    });

    it('B5 — tampon nu JJ/MM (hors [vérifié …]) compte comme marqueur de date', () => {
      const status = [
        '### Décisions actées',
        bullet('d-frais', 50, ' (le 08/11)'),
        bullet('d-vieux', 50, ' (le 02/11)'),
      ].join('\n');
      const out = enforceStatusBudget(status, now);
      // 100 mots, budget 90 : un départ — le tampon nu le plus ancien.
      expect(out.moved[0].bullets).toEqual([bullet('d-vieux', 50, ' (le 02/11)')]);
      expect(out.status).toContain('- [d-frais]');
    });

    it('B6 — libellé hors contrat : une section « Leçons » (même contenu) n\'est pas touchée', () => {
      const status = [
        '### Leçons',
        bullet('l1', 200),
        bullet('l2', 200),
      ].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(out.status).toBe(status);
      expect(out.moved).toEqual([]);
    });

    it('BM1 — puce multi-lignes : le BLOC part entier, la suite n\'est pas orpheline (suite ms#1712)', () => {
      // Sans le groupement en blocs, seule la ligne « - » partait : sa suite
      // restait dans la section, tête coupée — et son décompte de mots aussi.
      // Arithmétique : bloc m-old = 20 (marquée) + 8 (suite) = 28 ; +20 +20 = 68
      // pour un budget de 55 → UN départ (le bloc daté le plus ancien) → 40.
      const multi = [bullet('m-old', 20, ' [vérifié 02/11 08:00Z]'), '  suite de la puce sur une deuxième ligne'].join('\n');
      const status = [
        '### Patterns appris',
        multi,
        bullet('m-frais', 20, ' [vérifié 09/11 08:00Z]'),
        bullet('m-trois', 20),
      ].join('\n');
      const out = enforceStatusBudget(status, now);
      // Le bloc multi-lignes compte ses DEUX lignes (20 + 8 mots de suite).
      expect(out.moved[0].bullets).toEqual([multi]);
      // Aucune orpheline : la suite a suivi la ligne marquée.
      expect(out.status).not.toContain('suite de la puce');
      expect(out.status).toContain('- [m-frais]');
      expect(out.status).toContain('- [m-trois]');
    });

    it('BM2 — rang daté lu sur la SUITE du bloc, pas seulement sur la ligne marquée', () => {
      // La date vit sur la continuation : un rang calculé sur la seule ligne
      // « - » verrait la puce comme non datée — et la sortirait par la queue.
      // Bloc = 20 + 10 = 30 ; +20 +20 = 70 pour 55 → UN départ, et ce départ
      // doit être le BLOC (daté 02/11 par sa suite), pas b-frais (09/11).
      const head = bullet('b-head', 20);
      const cont = '  détail vérifié le 02/11 08:00Z sur la ligne de suite';
      const status = [
        '### Patterns appris',
        [head, cont].join('\n'),
        bullet('b-frais', 20, ' [vérifié 09/11 08:00Z]'),
        bullet('b-nodate', 20),
      ].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(out.moved[0].bullets).toEqual([[head, cont].join('\n')]); // la datée (par sa suite) part avant la non datée
      expect(out.status).toContain('- [b-nodate]');
    });

    it('BM3 — frontière du bloc : ligne vide, puce suivante et titre ferment la suite', () => {
      // Bloc p-old = 20 + 7 = 27 ; +20 +20 = 67 pour 55 → UN départ (p-old).
      const status = [
        '### Patterns appris',
        bullet('p-old', 20, ' [vérifié 02/11 08:00Z]'),
        '  suite absorbée par le bloc de p-old',
        '',
        'prose libre entre deux puces — ni puce ni suite : reste',
        bullet('p-frais', 20, ' [vérifié 09/11 08:00Z]'),
        bullet('p-trois', 20),
      ].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(out.moved[0].bullets).toEqual([[bullet('p-old', 20, ' [vérifié 02/11 08:00Z]'), '  suite absorbée par le bloc de p-old'].join('\n')]);
      expect(out.status).toContain('prose libre entre deux puces'); // hors bloc : jamais déplacée
      expect(out.status).toContain('- [p-frais]');
    });

    it('B7 — les 8 sections canoniques survivent à une passe lourde', () => {
      const mk = (h: string, n: number, stamp?: string) =>
        [`### ${h}`, ...Array.from({ length: n }, (_, i) => bullet(`${h}-${i}`, 25, stamp))].join('\n');
      const status = [
        '## [workspace-roo-extensions] — État au 2026-11-09T12:00Z',
        mk('Résumé', 4),
        mk('État des systèmes', 8, ' [vérifié 08/11 09:00Z]'),
        mk('Décisions actées', 8),
        mk('Blocages structurels', 6, ' [vérifié 08/11 09:00Z]'),
        mk('Livrables récents', 5),
        mk('En cours', 6),
        mk('Métriques de référence', 8),
        mk('Patterns appris', 8),
      ].join('\n');
      const out = enforceStatusBudget(status, now);
      for (const h of [
        'Résumé', 'État des systèmes', 'Décisions actées', 'Blocages structurels',
        'Livrables récents', 'En cours', 'Métriques de référence', 'Patterns appris'
      ]) {
        expect(out.status).toContain(`### ${h}`);
      }
      // Et chaque section budgétée revient sous son budget — budgets lus dans
      // la TABLE (source unique #4434, suite ms#1712) : ce test ne peut plus
      // rester vert si la table et la passe divergent.
      const budgets: Record<string, number> = Object.fromEntries(
        STATUS_SECTION_WORD_BUDGETS.map((d) => [d.name, d.budget])
      );
      for (const [h, b] of Object.entries(budgets)) {
        expect(sectionWords(out.status, h)).toBeLessThanOrEqual(b);
      }
    });
  });

  describe('R — Blocages : retraite RÉSOLU/REFUTE > 24 h, rien d\'autre', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    const blocker = (id: string, suffix: string) => `- **${id}** : blocage actif détaillé sur quelques mots ${suffix}`;

    it('R1 — RÉSOLU > 24 h part ; REFUTE > 24 h part ; exactement 24 h garde (frontière stricte)', () => {
      const old1 = blocker('resolu', 'RÉSOLU 07/11 10:00Z [vérifié 07/11 10:00Z]');
      const old2 = blocker('refute', 'REFUTE 07/11 11:00Z');
      const fresh = blocker('frais', 'REFUTE 09/11 11:00Z');
      const boundary = blocker('limite', 'RÉSOLU 08/11 12:00:00Z'); // exactement 24 h : gardé
      const active = blocker('actif', '[vérifié 08/11 09:00Z]');
      const status = ['### Blocages structurels', old1, old2, fresh, boundary, active].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(out.status).not.toContain('RÉSOLU 07/11');
      expect(out.status).not.toContain('REFUTE 07/11');
      expect(out.status).toContain('REFUTE 09/11 11:00Z'); // < 24 h : gardé
      expect(out.status).toContain('RÉSOLU 08/11 12:00:00Z'); // = 24 h pile : gardé (frontière stricte)
      expect(out.status).toContain('- **actif**');
      expect(out.retiredBlockerLines).toEqual([old1, old2]);
    });

    it('R2 — ISO daté : RÉSOLU 2026-11-07T10:00Z part aussi', () => {
      const old1 = blocker('iso', 'RÉSOLU 2026-11-07T10:00Z');
      const status = ['### Blocages structurels', old1].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(out.retiredBlockerLines).toEqual([old1]);
    });

    it('R3 — marqueur sans date lisible : gardé (on ne retire que ce qu\'on sait âgé)', () => {
      const undated = blocker('nodate', 'RÉSOLU (voir la passe précédente)');
      const status = ['### Blocages structurels', undated].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(out.status).toContain('- **nodate**');
      expect(out.retiredBlockerLines).toEqual([]);
    });

    it('R4 — « NON RÉSOLU » / « PAS RÉSOLU » : blocage ACTIF, jamais retiré, même ancien', () => {
      for (const neg of ['NON RÉSOLU 07/11 10:00Z', 'PAS RESOLU 07/11 10:00Z', 'NON-RÉSOLU 07/11 10:00Z', 'non résolu 07/11 10:00Z']) {
        const line = blocker('neg', neg);
        const status = ['### Blocages structurels', line].join('\n');
        const out = enforceStatusBudget(status, now);
        expect(out.status).toContain('- **neg**');
        expect(out.retiredBlockerLines).toEqual([]);
      }
    });

    it('R5 — plafond de mots (#4434 C1) : 500 mots de blocages actifs → ≤ 300, l\'excédent part verbatim, jamais vide', () => {
      // Avant #4434 résiduel C1, cette section n'avait AUCUN plafond : 833
      // mots mesurés sur workspace-CoursIA, le fallback ne convergeait plus
      // sous le plafond d'octets. Le plafond est 300 (table, source unique).
      const bullets = Array.from({ length: 10 }, (_, i) => bullet(`b${i}`, 50, ` [vérifié 0${(i % 8) + 1}/11 09:00Z]`));
      const status = ['### Blocages structurels', ...bullets].join('\n');
      const out = enforceStatusBudget(status, now);
      // Revenu sous le plafond, section jamais vidée.
      expect(sectionWords(out.status, 'Blocages structurels')).toBeLessThanOrEqual(300);
      expect(out.status).toContain('### Blocages structurels');
      expect(sectionWords(out.status, 'Blocages structurels')).toBe(300); // 500 − 4×50 exactement
      // Tampons 01/11 (b0, b8) puis 02/11 (b1, b9) : les plus anciennement
      // vérifiés partent d'abord, à égalité la plus haute — 4 départs (500→300).
      expect(out.moved).toHaveLength(1);
      expect(out.moved[0].section).toBe('Blocages structurels');
      expect(out.moved[0].bullets).toEqual([bullets[0], bullets[8], bullets[1], bullets[9]]);
      // Les récentes (03/11 → 08/11) restent dans le statut.
      for (const i of [2, 3, 4, 5, 6, 7]) expect(out.status).toContain(`- [b${i}]`);
      // Rien n'est retiré par la retraite : toutes ACTIVES.
      expect(out.retiredBlockerLines).toEqual([]);
    });

    it('R5b — sous le plafond : 250 mots de blocages actifs restent entiers (no-op)', () => {
      const status = [
        '### Blocages structurels',
        ...Array.from({ length: 5 }, (_, i) => bullet(`b${i}`, 50, ` [vérifié 0${i + 1}/11 09:00Z]`)),
      ].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(out.status).toBe(status); // 250 ≤ 300 : aucun départ
      expect(out.moved).toEqual([]);
    });

    it('R6 — marqueur futur (tampon de l\'an neuf) : daté du futur, pas > 24 h, gardé', () => {
      const future = blocker('futur', 'RÉSOLU 10/11 00:00Z');
      const status = ['### Blocages structurels', future].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(out.status).toContain('- **futur**');
    });

    it('R7 — test du dispatch C1 : statut à Blocages volumineux ramené sous le plancher d\'octets par la SEULE passe, sans plancher ni perte', () => {
      // Dispatch ai-01 11/11 (#4434 résiduel C1) : « un test qui fait entrer un
      // statut à Blocages volumineux sous le budget sans plancher ». Reproduit
      // la mesure fondatrice à échelle synthétique : Blocages domine le statut
      // (réel : 57 puces actives / 833 mots / 65 % du statut workspace-CoursIA,
      // tokens français plus longs que les nôtres — d'où 100 puces × 25 mots
      // pour franchir DÉTERMINISTEMENT le plancher d'octets), les 7 autres
      // sections en dépassement de génération ×4 (mesure ai-01 09/11 : ×1,4 à
      // ×6,8 sur CHAQUE section).
      const MAX = 15 * 1024; // miroir de MAX_STATUS_SIZE_BYTES (dashboard.ts) — hors export, épingle la valeur
      const blockerBullets = Array.from({ length: 100 }, (_, i) =>
        bullet(`blk${i}`, 25, ` [vérifié 0${(i % 8) + 1}/11 09:00Z]`));
      const mk4x = (h: string) => {
        const def = STATUS_SECTION_WORD_BUDGETS.find((d) => d.name === h)!;
        const per = Math.max(1, Math.floor((def.budget * 4) / 5)); // 5 puces → ×4 le budget
        return [`### ${h}`, ...Array.from({ length: 5 }, (_, i) => bullet(`${h}-${i}`, per))].join('\n');
      };
      const status = [
        '## [workspace-coursia] — État au 2026-11-09T12:00Z',
        mk4x('Résumé'),
        mk4x('État des systèmes'),
        mk4x('Décisions actées'),
        ['### Blocages structurels', ...blockerBullets].join('\n'),
        mk4x('Livrables récents'),
        mk4x('En cours'),
        mk4x('Métriques de référence'),
        mk4x('Patterns appris'),
      ].join('\n');
      expect(bytes(status)).toBeGreaterThan(MAX); // l'entrée dépasse le plancher d'octets
      const out = enforceStatusBudget(status, now);
      // La passe SEULE ramène sous le plancher : condenseTextIfTooLarge /
      // truncateToMaxSize n'a plus rien à couper — « sans plancher », aucune
      // ligne perdue.
      expect(out.bytesAfter).toBeLessThanOrEqual(MAX);
      // Les 8 sections canoniques survivent, habitées.
      for (const h of ['Résumé', 'État des systèmes', 'Décisions actées', 'Blocages structurels',
        'Livrables récents', 'En cours', 'Métriques de référence', 'Patterns appris']) {
        expect(out.status).toContain(`### ${h}`);
      }
      expect(sectionWords(out.status, 'Blocages structurels')).toBeLessThanOrEqual(300);
      // AUCUNE perte : chaque puce d'entrée est soit dans le statut rendu, soit
      // déplacée verbatim (archive #4434) — la retraite n'a rien ici (actives).
      const movedLines = new Set(out.moved.flatMap((m) => m.bullets.flatMap((b) => b.split('\n'))));
      const rendered = new Set(out.status.split('\n'));
      for (const line of status.split('\n')) {
        if (!/^\s*[-*]\s+\S/.test(line)) continue;
        expect(rendered.has(line) || movedLines.has(line), `puce perdue : ${line}`).toBe(true);
      }
      expect(out.retiredBlockerLines).toEqual([]);
    });

    it('R8 — pas de doublon d\'archive : une puce RÉSOLU > 24 h dans un Blocages sur budget part UNE fois (retraite), jamais déplacée', () => {
      // Composition des deux étapes depuis que Blocages porte un budget : la
      // puce retirée à l'étape 1 ne doit être NI comptée (elle gonflerait le
      // déficit) NI re-déplacée (elle atterrirait deux fois dans l'archive —
      // une fois retirée, une fois déplacée). Témoin M13.
      const retired = blocker('resolu-old', 'RÉSOLU 01/10 10:00Z');
      const bullets = [retired, ...Array.from({ length: 10 }, (_, i) => bullet(`a${i}`, 40, ` [vérifié 0${(i % 8) + 1}/11 09:00Z]`))];
      const status = ['### Blocages structurels', ...bullets].join('\n');
      const out = enforceStatusBudget(status, now);
      // Retraite UNE fois…
      expect(out.retiredBlockerLines).toEqual([retired]);
      // …et JAMAIS dans les déplacements : 400 mots d'actives (la retirée ne
      // compte pas) → 3 départs de 40 → 280 ≤ 300. La retirée porte le tampon
      // le PLUS ANCIEN de la section (01/10 < 01/11) : un mutant qui ne la
      // saute pas la classe EN TÊTE du classement et la DÉPLACE en plus de la
      // retraite — doublon d'archive (deux fois le même verbatim), et 411
      // mots comptés au lieu de 400.
      const movedFlattened = out.moved.flatMap((m) => m.bullets).join('\n');
      expect(movedFlattened).not.toContain('resolu-old');
      expect(out.moved).toHaveLength(1);
      expect(out.moved[0].section).toBe('Blocages structurels');
      expect(out.moved[0].moved).toBe(3);
      expect(sectionWords(out.status, 'Blocages structurels')).toBe(280);
    });

    it('R9 — topLevelBlocks : parent daté + sous-puces indentées = UN bloc, aucune orpheline (review 11/11)', () => {
      // Finding de la review lane (00:46Z) : STATUS_BULLET_RE matche les
      // puces indentées → sur Blocages, le parent daté partait seul
      // (classement « anciennement vérifié d'abord ») et ses sous-puces non
      // datées restaient orphelines dans le statut vivant — motif réel :
      // statuts Argumentum (« - **#2229 / #2230** : … [vérifié …] » suivi de
      // sous-puces indentées). topLevelBlocks : départ de bloc au premier
      // niveau uniquement, l'extension avale les sous-puces.
      expect(STATUS_SECTION_WORD_BUDGETS.find((d) => d.name === 'Blocages structurels')!.topLevelBlocks).toBe(true);
      const parent = bullet('parent', 40, ' [vérifié 02/11 08:00Z]');
      const sub1 = '  - [sub1] d0 d1 d2 d3 d4 d5 d6 d7 d8 d9'; // 11 mots comptés
      const sub2 = '  - [sub2] e0 e1 e2 e3 e4 e5 e6 e7 e8 e9'; // 11 mots comptés
      const others = Array.from({ length: 6 }, (_, i) => bullet(`o${i}`, 45, ` [vérifié 0${i + 3}/11 09:00Z]`));
      const status = ['### Blocages structurels', parent, sub1, sub2, ...others].join('\n');
      // 40 + 11 + 11 + 6×45 = 332 > 300 : le parent (tampon le plus ancien,
      // 02/11) part EN PREMIER — son bloc de 62 mots ramène à 270 ≤ 300.
      const out = enforceStatusBudget(status, now);
      expect(out.moved).toHaveLength(1);
      expect(out.moved[0].section).toBe('Blocages structurels');
      expect(out.moved[0].moved).toBe(1);
      expect(out.moved[0].bullets[0]).toBe([parent, sub1, sub2].join('\n'));
      // AUCUNE orpheline : les sous-puces partent AVEC leur parent.
      expect(out.status).not.toContain('[sub1]');
      expect(out.status).not.toContain('[sub2]');
      // Les autres blocages restent, section revenue sous le plafond.
      expect(out.status).toContain('- [o5]');
      expect(sectionWords(out.status, 'Blocages structurels')).toBe(270);
      expect(out.retiredBlockerLines).toEqual([]);
    });
  });

  describe('A — archive de la passe : verbatim, sous la section d\'origine', () => {
    const now = new Date('2026-11-09T12:00:00Z');

    it('A1 — puces déplacées et lignes retirées, verbatim, sous leurs sous-sections', () => {
      const vieux = bullet('old', 30, ' [vérifié 02/11 08:00Z]');
      const frais = bullet('frais', 30, ' [vérifié 09/11 08:00Z]');
      const retired = '- **resolu** : ligne de blocage RÉSOLU 07/11 10:00Z';
      const status = [
        '### Patterns appris', vieux, frais,
        '### Blocages structurels', retired, '- **actif** : tenu',
      ].join('\n');
      const result = enforceStatusBudget(status, now);
      const archive = buildStatusBudgetArchiveSection(result, now);
      expect(archive).not.toBeNull();
      expect(archive).toContain('## Statut — entrées sorties du budget (#4434)');
      expect(archive).toContain(`### Patterns appris\n${vieux}`);
      expect(archive).toContain('### Blocages — lignes RÉSOLU/REFUTE retirées');
      expect(archive).toContain(retired);
      // Le résumé porte la télémétrie : octets avant/après et comptes.
      expect(archive).toContain(`${result.bytesBefore} → ${result.bytesAfter} octets`);
      expect(archive).toContain('Patterns appris : 1');
    });

    it('A2 — verbatim : la puce déplacée est l\'octet pour octet la ligne d\'entrée', () => {
      // Métriques de référence, budget 85 : 80 + 10 = 90 → la datée part.
      const unique = bullet('unique-✓-字', 80, ' [vérifié 01/11 08:00Z]');
      const status = ['### Métriques de référence', unique, bullet('reste', 10)].join('\n');
      const result = enforceStatusBudget(status, now);
      expect(result.moved[0].bullets[0]).toBe(unique);
      const archive = buildStatusBudgetArchiveSection(result, now);
      expect(archive).toContain(unique);
    });

    it('A3 — passe no-op : pas de section d\'archive (null)', () => {
      const result = enforceStatusBudget('### Résumé\n' + bullet('r', 10), now);
      expect(buildStatusBudgetArchiveSection(result, now)).toBeNull();
    });
  });

  describe('C — contrats de comptage', () => {
    const now = new Date('2026-11-09T12:00:00Z');

    it('C1 — le marqueur de puce ne compte pas comme mot', () => {
      // Patterns appris, budget 55 : deux puces totalisant EXACTEMENT 55 vrais
      // mots (25 + 30). La vraie passe lit 55 ≤ 55 → no-op ; un mutant qui
      // compte le marqueur de puce (M8) lit 57 > 55 et déplace.
      const status = [
        '### Patterns appris',
        bullet('a', 25, ' [vérifié 08/11 08:00Z]'),
        bullet('b', 30, ' [vérifié 09/11 08:00Z]'),
      ].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(out.status).toBe(status);
      expect(out.moved).toEqual([]);
    });

    it('C2 — une ligne de prose ne compte pas et ne se déplace pas', () => {
      const prose = 'Phrase de prose sans puce, assez longue pour peser si elle comptait : ' + 'mot '.repeat(30);
      const status = ['### Patterns appris', prose, bullet('r', 54)].join('\n');
      const out = enforceStatusBudget(status, now);
      expect(out.status).toContain(prose); // ni déplacée…
      expect(out.moved).toEqual([]); // …ni comptée (54 ≤ 55)
    });

    it('C3 — tampon hors calendrier : pas un marqueur de date (la puce est « non datée »)', () => {
      // 99/13 n'existe pas : la puce est non datée et part par la QUEUE —
      // après toute puce datée valide, même plus récente.
      const invalid = bullet('bad', 30, ' vu le 99/13');
      const valid = bullet('good', 30, ' [vérifié 03/11 08:00Z]');
      const tail = bullet('tail', 30);
      const status = ['### Patterns appris', invalid, valid, tail].join('\n');
      const out = enforceStatusBudget(status, now);
      // 90 mots, budget 55 : 1 départ = good (datée valide), PAS tail :
      // après good il reste 60 > 55 → 2e départ = tail (non datée, queue).
      // Recompte : départ 1 = good (le plus ancien daté), départ 2 = tail.
      expect(out.moved[0].bullets).toEqual([valid, tail]);
      expect(out.status).toContain('- [bad]'); // non datée, elle, ne part qu'après la queue
    });

    it('C4 — année glissante : décembre lu en janvier est l\'année d\'avant (le plus ancien)', () => {
      const jan = new Date('2027-01-05T12:00:00Z');
      const dec = bullet('dec', 30, ' [vérifié 28/12 10:00Z]');
      const earlyJan = bullet('jan', 30, ' [vérifié 02/01 09:00Z]');
      const status = ['### Patterns appris', dec, earlyJan].join('\n');
      const out = enforceStatusBudget(status, jan);
      // 60 mots, budget 55 : 1 départ — décembre 2026 (le plus ancien), pas janvier.
      expect(out.moved[0].bullets).toEqual([dec]);
    });
  });

  describe('SU — source unique des budgets (suite ms#1712 : 3 copies → 1)', () => {
    it('SU1 — statusBudgetPromptLines émet exactement une ligne par section de la table, budget compris', () => {
      const lines = statusBudgetPromptLines();
      expect(lines).toHaveLength(STATUS_SECTION_WORD_BUDGETS.length);
      for (const d of STATUS_SECTION_WORD_BUDGETS) {
        const line = lines.find((l) => l.startsWith(`- ${d.name} :`));
        expect(line, `ligne prompt pour « ${d.name} »`).toBeTruthy();
        expect(line).toBe(`- ${d.name} : ≤ ${d.budget} mots${d.hint ? ` (${d.hint})` : ''}`);
      }
    });

    it('SU2 — la table porte « Blocages structurels » AVEC un plafond positif (#4434 C1 : 300)', () => {
      // Inversé par #4434 résiduel C1 : l'absence de plafond (l'ancien SU2)
      // laissait la section dépasser 800 mots mesurés et tuait la convergence
      // du fallback. Le plafond vit dans la table comme les 7 autres — si sa
      // valeur change, c'est ICI et dans le prompt (source unique) ensemble.
      const def = STATUS_SECTION_WORD_BUDGETS.find((d) => d.name === 'Blocages structurels');
      expect(def).toBeTruthy();
      expect(def!.budget).toBe(300);
    });
  });
});
