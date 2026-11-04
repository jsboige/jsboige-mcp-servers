/**
 * #4434 volet 5 — fixtures hors ligne du chemin de troncation déterministe.
 *
 * Cycle 1 (po-204, corpus GDrive) a mesuré les mécanismes ; cette suite les
 * ÉPINGLE sur les fonctions réellement exportées et réellement appelées au
 * fallback (`truncateToMaxSize`, le trio marqueur #2719), pour qu'aucune
 * réintroduction ne passe inaperçue :
 *
 *   A. Plancher par sections (#4434, 04/11). Avant, la boucle gardait les
 *      lignes depuis la FIN, et les premières sections du statut (Résumé,
 *      État des systèmes, Décisions) mouraient les premières. Mesuré sur
 *      ai-01 le 04/11 : 7 passes sur 7, « … 24 lignes omises », Décisions
 *      actées perdues, et la passe suivante héritait du statut amputé.
 *      Désormais, sur un texte sectionné (2 titres ou plus), chaque titre
 *      survit, la section « Blocages » est gardée entière dans sa part (F), la
 *      dernière ligne survit, et les octets sortent de la section la plus
 *      grosse, ligne du haut d'abord ; à égalité, c'est la plus tardive qui paie.
 *   B. Fallback mono-ligne — la fenêtre garde les DERNIERS caractères et
 *      coupe en plein token (le « (658 » mesuré) ; la coupe doit être
 *      EXACTE à l'octet et alignée sur les points de code (#4434 : le
 *      diviseur /3, borne du pire cas, jetait deux tiers du budget en ASCII ;
 *      avant lui /2, trouvé PAR cette suite, violait le plafond).
 *   C. Marqueur #2719 — strip ancré en début de ligne (la prose citant la
 *      sentinelle survit), au plus un marqueur par re-stamp, et le contrat
 *      de réservation du call-site (marker + statut tronqué ≤ plafond).
 *   D. Section « Blocages structurels » — le plancher garde ce bloc ENTIER
 *      (avec le titre du document) au lieu de le décapiter en premier, puis
 *      dépense le budget restant sur la queue. Pas de section ⇒ chemin
 *      historique inchangé, octet pour octet ; bloc seul au-dessus du
 *      plafond ⇒ repli sur la queue (une liste tronquée se lirait comme
 *      complète).
 *   E. Review ms#1637 (3 réserves ai-01) — (a) récence : le chemin bloc
 *      réserve la DERNIÈRE ligne avant la queue (le chemin historique ne
 *      la perd jamais — hard-cut en dernier recours — le chemin bloc ne le
 *      doit pas non plus) ; (b) marqueur d'omission : l'auto-condense rend
 *      un document qui DIT combien de lignes sont tombées, marqueur budgété
 *      comme #2719 (marqueur + corps ≤ plafond, invariant dur) ; (c) contrat
 *      de libellé : seuls « Blocages » / « Blockers » ouvrent le droit au
 *      bloc — tout autre libellé, même porteur du même contenu, est du
 *      contenu ordinaire (chemin historique).
 *   F. Part des blocages (#4434, 04/11). Sur 24 statuts archivés, la section
 *      blocages grossissait à chaque passe jusqu'à 91 % du statut, 0-1 ligne
 *      jamais marquée REFUTE/RÉSOLU : gardée entière, elle faisait payer les
 *      sept autres. Quand le plancher tourne, son corps est plafonné à 40 % du
 *      plafond ; sortent d'abord les lignes REFUTE/RÉSOLU, puis les non datées,
 *      puis la vérification la plus ancienne (à égalité, la plus haute). Levier
 *      `CONDENSE_BLOCKERS_MAX_SHARE_PCT=0` = « Blocages entiers » (D3/E1a/E1b
 *      épinglent ce chemin sous le levier).
 *
 * Témoins de mutation (exécutés au cycle, consignés dans la PR) :
 *   M1 inversion du sens de la boucle (tête↔queue)        → A1 rouge
 *   M2 diviseur /3 → /2                                    → B2 rouge
 *   M3 strip startsWith → includes                         → C1 rouge
 *   M4 slice(-maxChars) → slice(0, maxChars)               → B1 rouge
 *   M5 coupe exacte → retour au diviseur floor(cap/3)      → B1/B2 rouges
 *   M6 paire de substitution non enjambée (1 unité)         → B5 rouge
 *   M7 largeur 4 octets comptée 3                           → B4/B5 rouges
 *   M8 protection de la section désactivée (→ null)          → D1/D4/D5 rouges
 *   M9 fin de section = heading seul (bloc sans corps)       → D1/D3/D4/D5 rouges
 *   M10 séparateur non compté ('\n' + ligne → ligne)         → D5 rouge (> plafond)
 *   M11 garde de taille du bloc retirée                      → D3 rouge (> plafond)
 *   M12 plancher de récence retiré (garde + seed → état mergé) → E1a rouge
 *   M13 marqueur non budgété (append à budget plein)          → E2 rouge (> plafond)
 *   M14 libellé élargi à tout heading                         → E3 rouge (mesuré : 10 rouges — D1-D5, E1a/E1b ; la priorité de bloc change partout)
 *   M1-M14 ont été mesurés AVANT le plancher par sections (04/11). Les chemins
 *   qu'ils mutent ne servent plus que le texte non sectionné et le squelette
 *   qui ne tient pas seul ; ils n'ont pas été ré-exécutés (correspondance non
 *   re-mesurée).
 *   Plancher par sections (04/11, exécutés, fichier restauré par cp + sha256) :
 *   M15 chemin par sections désactivé (→ null)               → A1/A3/A4/A5/D1/D5/E3 rouges
 *   M16 section Blocages non exclue des segments             → A4/D1/D3/D5/E1a/E1b/E3 rouges
 *   M17 dernière ligne non protégée (end = to)               → A6/E1a/E1b rouges
 *   M18 égalité : la tête paie (>= → >)                      → A1/A5 rouges
 *   M19 séparateur non compté dans le coût d'une ligne       → A1/A5/D5 rouges
 *   M20 jambe cloud visant le plafond au lieu de 75 %        → condense-size-target (cloud) rouge
 *   Part des blocages (04/11, exécutés, fichier restauré par cp + sha256) :
 *   M21 part désactivée (share → null)                       → F1/F2/F4/F5/F6/F7 rouges
 *   M22 rang ignoré (ordre du document seul)                 → F1/F2/F5/F6 rouges
 *   M23 année glissante retirée                              → F3 rouge
 *   M24 REFUTE/RÉSOLU non déclassés                          → F2/F3 rouges
 *   M25 levier =0 ignoré                                     → D3/E1a/E1b/F4 rouges
 *   M26 dernière ligne du document candidate                 → F6 rouge
 *   M27 non daté rangé comme le plus récent                  → F2/F3 rouges
 *   M28 égalité : la plus basse sort                         → F2 rouge
 *   M29 part comptée sur le texte entier au lieu du plafond  → F1/F2/F4/F5/F7 rouges
 *
 * Hors d'atteinte unitaire (documenté, non testé ici) : l'append des marqueurs
 * #1502/#3803 APRÈS condenseTextIfTooLarge (dashboard.ts ~L5753-5782, mesure
 * cycle 1 : statuts jusqu'à ~16 012 o > 15 360) vit dans le pipeline de
 * condensation complet, pas dans une fonction exportée.
 *
 * @module tools/roosync/__tests__/dashboard.truncation-fixtures
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  truncateToMaxSize,
  blockerDropRank,
  truncateWithOmissionMarker,
  buildStatusFallbackMarker,
  stripStatusFallbackMarker,
} from '../dashboard.js';

// Miroir du mock minimal de condense-cap-enforcement.test.ts : l'import du
// module dashboard tire @/services/openai au niveau module ; on ne s'en sert
// pas ici (fonctions déterministes pures), mais l'import ne doit pas créer
// de client réel.
vi.mock('@/services/openai', () => ({
  getChatOpenAIClient: () => null,
  resetChatOpenAIClient: vi.fn(),
  getLLMModelId: () => 'test-model',
  getFallbackChatOpenAIClient: () => null,
  getFallbackLLMModelId: () => 'test-fallback-model',
}));

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** Section de statut réaliste : header + lignes de contenu ~100 o. */
function section(title: string, lineCount: number): string {
  const lines = [`## ${title}`];
  for (let i = 0; i < lineCount; i++) {
    lines.push(`${title} — activité ${i} : ${'x'.repeat(80)} fin de ligne ${i}.`);
  }
  return lines.join('\n');
}

describe('#4434 volet 5 — fixtures troncation déterministe', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('A — texte sectionné : chaque section garde son titre, la plus grosse paie (#4434, 04/11)', () => {
    // 8 sections de ~2,1 Ko : les 3 premières portent les noms des sections
    // réelles que l'ancien plancher décapitait (Résumé, État des systèmes,
    // Décisions) ; total ≈ 17 Ko, cap 6,5 Ko. L'ancien plancher n'en gardait
    // que ~3 de queue (mesuré ai-01 04/11 : « … 24 lignes omises », Décisions
    // actées perdues, perte définitive à la passe suivante).
    const fixture = [
      section('Résumé', 20),
      section('État des systèmes', 20),
      section('Décisions actées', 20),
      section('S3', 20),
      section('S4', 20),
      section('S5', 20),
      section('S6', 20),
      section('S7', 20),
    ].join('\n');
    const CAP_A = 6.5 * 1024;
    const bodyCount = (out: string, title: string) =>
      out.split('\n').filter(l => l.startsWith(`${title} — activité`)).length;

    it('A1 — les 8 titres survivent, chaque section garde du corps, la dernière ligne survit', () => {
      const out = truncateToMaxSize(fixture, CAP_A, 'Status (fixture A)');
      expect(bytes(out)).toBeLessThanOrEqual(CAP_A);
      for (const t of ['Résumé', 'État des systèmes', 'Décisions actées', 'S3', 'S4', 'S5', 'S6', 'S7']) {
        expect(out).toContain(`## ${t}`);
        expect(bodyCount(out, t)).toBeGreaterThan(0);
      }
      // Contrat de récence : la toute dernière ligne, entière.
      const lastOriginalLine = fixture.slice(fixture.lastIndexOf('\n') + 1);
      expect(out.endsWith(lastOriginalLine)).toBe(true);
      // Sections d'égale taille ⇒ égalisation : aucun écart de plus d'une ligne.
      const counts = ['Résumé', 'État des systèmes', 'Décisions actées', 'S3', 'S4', 'S5', 'S6', 'S7'].map(t => bodyCount(out, t));
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    });

    it('A2 — la coupe est granulaire par LIGNE et garde l\'ordre : sous-suite exacte du fixture', () => {
      const out = truncateToMaxSize(fixture, CAP_A, 'Status (fixture A)');
      const original = fixture.split('\n');
      const kept = out.split('\n');
      // Chaque ligne gardée est une ligne entière du fixture, dans l'ordre :
      // jamais de coupe au milieu d'une ligne (contraste B1), jamais de réordonnancement.
      let j = 0;
      for (const line of kept) {
        while (j < original.length && original[j] !== line) j++;
        expect(j).toBeLessThan(original.length);
        j++;
      }
    });

    it('A3 — la section la plus grosse paie d\'abord : les petites sections restent intactes', () => {
      const small = (t: string) => section(t, 2);
      const fx = [
        '## [workspace] — État',
        small('Résumé'),
        small('Décisions actées'),
        section('Patterns appris', 40),
        small('En cours'),
      ].join('\n');
      const cap = bytes(fx) - 20 * 101; // ~20 lignes à retirer, la grosse en a 40
      const out = truncateToMaxSize(fx, cap, 'Status (fixture A3)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      for (const t of ['Résumé', 'Décisions actées', 'En cours']) {
        for (const line of small(t).split('\n')) expect(out).toContain(line);
      }
      expect(bodyCount(out, 'Patterns appris')).toBeLessThan(40);
      expect(bodyCount(out, 'Patterns appris')).toBeGreaterThan(0);
    });

    it('A4 — forme réelle mesurée (04/11) : Décisions actées survit, blocages entiers, Patterns rogné', () => {
      // 20 lignes de blocage ≈ 2,7 Ko : sous leur part de 40 % du plafond (3,2 Ko),
      // donc gardées entières (au-delà, voir F).
      const blockers = section('Blocages structurels', 20);
      const fx = [
        '## [workspace-roo-extensions] — État au 2026-11-04T08:17Z',
        section('Résumé', 2),
        section('État des systèmes', 8),
        section('Décisions actées', 8),
        blockers,
        section('Livrables récents', 6),
        section('Métriques de référence', 20),
        section('Patterns appris', 30),
      ].join('\n');
      const cap = 8 * 1024;
      expect(bytes(fx)).toBeGreaterThan(cap);
      const out = truncateToMaxSize(fx, cap, 'Status (fixture A4)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      for (const line of blockers.split('\n')) expect(out).toContain(line);
      expect(out.split('\n')[0]).toBe('## [workspace-roo-extensions] — État au 2026-11-04T08:17Z');
      expect(bodyCount(out, 'Décisions actées')).toBeGreaterThan(0);
      expect(bodyCount(out, 'Résumé')).toBe(2); // petite section, jamais atteinte
      expect(bodyCount(out, 'Patterns appris')).toBeLessThan(30);
    });

    it('A5 — égalité de taille : c\'est la section la PLUS TARDIVE qui paie (la tête est protégée)', () => {
      const fx = [
        '## T',
        '## A', 'a1 ' + 'x'.repeat(97), 'a2 ' + 'x'.repeat(97),
        '## B', 'b1 ' + 'x'.repeat(97), 'b2 ' + 'x'.repeat(97),
        '## Z', 'fin',
      ].join('\n');
      const cap = bytes(fx) - 101; // une seule ligne de 100 o (+ séparateur) à retirer
      const out = truncateToMaxSize(fx, cap, 'Status (fixture A5)');
      expect(bytes(out)).toBe(cap);
      expect(out).toContain('a1 ');
      expect(out).toContain('a2 ');
      expect(out).not.toContain('b1 '); // B paie, ligne du haut d'abord
      expect(out).toContain('b2 ');
    });

    it('A6 — la dernière ligne est protégée : squelette + dernière ligne trop gros ⇒ repli historique, elle survit', () => {
      const last = `DERNIÈRE ${'z'.repeat(300)}`;
      const fx = ['## T', '## S1', `s1 ${'x'.repeat(100)}`, '## S2', last].join('\n');
      // La dernière ligne tient seule, mais pas avec les trois titres.
      const cap = bytes(last) + 5;
      expect(bytes('## T\n## S1\n## S2\n' + last)).toBeGreaterThan(cap);
      const out = truncateToMaxSize(fx, cap, 'Status (fixture A6)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      expect(out.endsWith(last)).toBe(true);
    });
  });

  describe('B — fallback mono-ligne : fenêtre depuis la fin, coupure mid-token, plafond UTF-8', () => {
    it('B1 — la fenêtre garde le CÔTÉ RÉCENT de la ligne : marqueurs de queue survivent, marqueurs de tête meurent', () => {
      // Marqueurs DISTINCTS en tête et en queue : une fenêtre depuis la fin
      // ne peut pas contenir le marqueur de tête, et vice-versa. (Un fixture
      // périodique ne distinguerait pas les deux fenêtres — vécu : le mutant
      // M4 y survivait, ce test n'était pas un garde.)
      const line = 'TÊTE marqueur unique ' + 'a'.repeat(700) + ' métrique finale 78,6 % du non-caché (658 ko au 30/10)';
      const cap = 300;
      expect(bytes(line)).toBeGreaterThan(cap); // bien le chemin mono-ligne

      const out = truncateToMaxSize(line, cap, 'Status (fixture B1)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);

      // Le résultat est un SUFFIXE exact — mutant M4 (slice(0, maxChars),
      // fenêtre de tête) rouge ici : il rendrait un préfixe.
      expect(line.endsWith(out)).toBe(true);
      // ASCII en queue : la coupe exacte remplit le budget à l'octet près
      // (le diviseur /3 n'en donnait que 100 — mutant M5 rouge ici). La queue
      // contient un 'é' (2 octets) : c'est bien l'OCTET qui est saturé, pas le
      // nombre d'unités UTF-16.
      expect(bytes(out)).toBe(cap);
      expect(out.length).toBeLessThan(cap);
      // Le contenu RÉCENT (la métrique de queue) survit…
      expect(out).toContain('78,6 % du non-caché (658');
      // …le marqueur de tête est hors fenêtre.
      expect(out).not.toContain('TÊTE');
    });

    it('B1b — la coupure peut atterrir EN PLEIN nombre : amputation sans frontière de token (cas « (658 » mesuré)', () => {
      // Ligne dense de métriques : que des chiffres, aucune frontière de mot.
      // Toute fenêtre amputée d'un préfixe atterrit donc EN PLEIN nombre.
      const line = '0123456789'.repeat(80); // 800 caractères ASCII = 800 o
      const cap = 300;
      expect(bytes(line)).toBeGreaterThan(cap);

      const out = truncateToMaxSize(line, cap, 'Status (fixture B1b)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      expect(line.endsWith(out)).toBe(true);
      // Que de l'ASCII : la fenêtre sature le budget à l'unité près.
      expect(out.length).toBe(cap);
      expect(bytes(out)).toBe(cap);

      // La coupure atterrit entre deux chiffres : nombre amputé, ni
      // séparateur ni début de token à la frontière.
      const windowStart = line.length - out.length;
      expect(windowStart).toBeGreaterThan(0);
      expect(/^[0-9]/.test(out)).toBe(true);
      expect(/[0-9]$/.test(line.charAt(windowStart - 1))).toBe(true);
    });

    it('B2 — plafond DUR en pire cas UTF-8 : 3 octets par unité, budget saturé (le diviseur /2 le violait)', () => {
      // '字' = 3 octets UTF-8 pour 1 unité JS. Avec maxChars = floor(cap/2)
      // le rendu faisait cap/2 × 3 = 1,5× cap en octets (mesure : cap 600
      // → 900 o). Mutant M2 (/3 → /2) rouge ici ; mutant M5 (retour au /3)
      // rouge aussi, parce que la fenêtre exacte doit ATTEINDRE le plafond.
      const line = '字'.repeat(600); // 600 unités, 1 800 o
      const cap = 600;
      const out = truncateToMaxSize(line, cap, 'Status (fixture B2)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      expect(out.length).toBe(200);
      expect(bytes(out)).toBe(600);
    });

    it('B3 — emoji 4 octets, fenêtre alignée sur les paires : emoji ENTIERS, budget saturé', () => {
      // cap 600 → 150 emoji (600 o). Le diviseur /3 en donnait 100 (400 o).
      const line = '😀'.repeat(400); // 800 unités JS, 1 600 o
      const cap = 600;
      const out = truncateToMaxSize(line, cap, 'Status (fixture B3)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      expect(out).toBe('😀'.repeat(150));
      // Paires surrogates intactes : longueur paire et décomposition en
      // codepoints complets (aucun demi-surrogat isolé).
      expect(out.length % 2).toBe(0);
      expect(out).toBe('😀'.repeat(out.length / 2));
    });

    it('B4 — coupe EXACTE : la fenêtre est MAXIMALE (un point de code de plus la ferait déborder)', () => {
      // Mélange 1/2/3/4 octets — 'a', 'é', '字', '😀' : 10 o par motif.
      const line = 'aé字😀'.repeat(300); // 1 200 unités JS, 3 000 o
      const cap = 1001; // ni multiple de 4, ni de 10
      const out = truncateToMaxSize(line, cap, 'Status (fixture B4)');

      expect(bytes(out)).toBeLessThanOrEqual(cap);
      expect(line.endsWith(out)).toBe(true);
      // Aucun demi-surrogat : le suffixe se recompose en points de code entiers.
      expect(Array.from(out).join('')).toBe(out);
      // MAXIMALITÉ : le point de code précédant la fenêtre ne rentre pas.
      const start = line.length - out.length;
      expect(start).toBeGreaterThan(0);
      const before = Array.from(line.slice(0, start));
      const nextWidth = bytes(before[before.length - 1]);
      expect(bytes(out) + nextWidth).toBeGreaterThan(cap);
    });

    it('B5 — emoji 4 octets : plafond non multiple de 4, la fenêtre s’arrête au dernier emoji ENTIER', () => {
      const line = '😀'.repeat(400); // 1 600 o
      const cases: Array<[number, number]> = [[601, 150], [600, 150], [399, 99]];
      for (const [cap, expected] of cases) {
        const out = truncateToMaxSize(line, cap, `Status (fixture B5 cap=${cap})`);
        // Un mutant qui compte 3 octets par unité (M7) déborderait ; un mutant
        // qui n'enjambe pas la paire (M6) couperait un demi-surrogat.
        expect(out).toBe('😀'.repeat(expected));
        expect(bytes(out)).toBe(expected * 4);
        expect(bytes(out)).toBeLessThanOrEqual(cap);
        expect(out.length % 2).toBe(0);
      }
    });
  });

  describe('C — marqueur #2719 : ancrage, unicité, réservation du plafond', () => {
    const now = '2026-10-31T00:00:00Z';

    it('C1 — le strip est ancré en DÉBUT de ligne : la prose citant la sentinelle survit (mutant M3 : includes → rouge)', () => {
      const marker = buildStatusFallbackMarker(now, 12, { primary: 'primary leg dead', cloud: 'unconfigured' });
      // Prose qui CITE la sentinelle en plein milieu de ligne — pas un marqueur.
      const prose = 'Le rapport cite «> [!WARNING] **lastCondense: fallback-truncated** @2026-10-30» comme exemple, sans être un marqueur.';
      const status = [marker, prose, '## Corps', 'contenu'].join('\n');

      const stripped = stripStatusFallbackMarker(status);
      // Le marqueur (ligne entière commençant par la sentinelle) part…
      expect(stripped.split('\n').some(l => l.startsWith('> [!WARNING] **lastCondense: fallback-truncated**'))).toBe(false);
      // …la prose citante reste, MOT POUR MOT.
      expect(stripped).toContain(prose);
      expect(stripped).toContain('## Corps');
    });

    it('C2 — au plus UN marqueur survit : strip puis re-stamp ne peut pas accumuler', () => {
      const oldMarker = buildStatusFallbackMarker('2026-10-30T00:00:00Z', 9, { primary: 'old pass', cloud: 'old cloud' });
      const body = ['## Status', 'ligne de statut', 'autre ligne'].join('\n');
      const stampedOnce = `${oldMarker}\n${body}`;

      // Le call-site re-stamp : strip de l'ancien PUIS préfixe du nouveau.
      const newMarker = buildStatusFallbackMarker(now, 15, { primary: 'new pass', cloud: 'cloud rejected' });
      const restamped = `${newMarker}\n${stripStatusFallbackMarker(stampedOnce)}`;

      const markerLines = restamped.split('\n')
        .filter(l => l.startsWith('> [!WARNING] **lastCondense: fallback-truncated**'));
      expect(markerLines).toHaveLength(1);
      expect(markerLines[0]).toBe(newMarker);
      // Le corps survit aux deux passes.
      expect(restamped).toContain('## Status');
      expect(restamped).toContain('autre ligne');
    });

    it('C3 — contrat du call-site (~dashboard.ts L5266) : marker + statut tronqué ≤ plafond 15 Ko, marqueur compris', () => {
      const MAX = 15 * 1024;
      // Marqueur long (jambe primaire bavarde + compteur hôte) et statut
      // largement au-dessus du plafond : le pire cas compositionnel.
      const marker = buildStatusFallbackMarker(now, 40, {
        primary: 'primary leg dead '.repeat(20).trim(),
        cloud: 'cloud rejected after retry budget exhausted',
      }, { count: 7, firstAt: '2026-10-28T12:00:00Z' });
      const status = ['## Résumé', section('S1', 60), section('S2', 60), section('S3', 60), section('S4', 60)].join('\n');
      expect(bytes(marker)).toBeGreaterThan(0);
      expect(bytes(status)).toBeGreaterThan(MAX);

      // Formule du call-site : réserver les octets du marqueur AVANT la
      // troncation, puis préfixer — l'invariant #2463/#2719 porte le BLOC
      // ENTIER, marqueur inclus.
      const markerBytes = bytes(`${marker}\n`);
      const truncated = truncateToMaxSize(status, Math.max(0, MAX - markerBytes), 'Status (fallback)');
      const whole = `${marker}\n${truncated}`;
      expect(bytes(whole)).toBeLessThanOrEqual(MAX);
      // Et le marqueur n'a pas été décapité : il est en tête, entière ligne.
      expect(whole.split('\n')[0]).toBe(marker);
    });
  });

  describe('D — la section « Blocages structurels » survit au plancher (#4434)', () => {
    // 6 sections de ~800 o ≈ 5,5 Ko pour un cap de 2,2 Ko : le budget est
    // TENDU. Le bloc blocages (6 lignes, ~820 o de corps) tient dans sa part de
    // 40 % du plafond (880 o) : c'est ce qui le garde entier ici (au-delà, F).
    const CAP_D = 2200;
    const withBlockers = [
      '## [workspace] — État au 2026-11-03T08:10Z',
      section('Résumé', 8),
      section('État des systèmes', 8),
      section('Blocages structurels', 6),
      '---',
      section('S5', 8),
      section('S6', 8),
      section('S7', 8),
    ].join('\n');

    it('D1 — la section blocages survit ENTIÈRE avec le titre du document ; la tête intermédiaire garde ses titres (#4434, 04/11)', () => {
      expect(bytes(withBlockers)).toBeGreaterThan(CAP_D); // bien le chemin de troncation
      const blockerLines = section('Blocages structurels', 6).split('\n');
      expect(blockerLines.length).toBeGreaterThan(1);

      const out = truncateToMaxSize(withBlockers, CAP_D, 'Status (fixture D1)');
      expect(bytes(out)).toBeLessThanOrEqual(CAP_D);

      // Le titre du document (lead heading) est conservé…
      expect(out.split('\n')[0]).toBe('## [workspace] — État au 2026-11-03T08:10Z');
      // …la section blocages est conservée ligne à ligne, heading compris…
      for (const line of blockerLines) expect(out).toContain(line);
      // …et le contrat de récence tient : la dernière ligne d'origine survit.
      expect(out).toContain('## S7');
      expect(out.endsWith(withBlockers.slice(withBlockers.lastIndexOf('\n') + 1))).toBe(true);
      // Plus de décapitation : les sections de tête gardent leur titre
      // (l'ancien plancher les jetait entières — c'était la perte mesurée).
      expect(out).toContain('## Résumé');
      expect(out).toContain('## État des systèmes');
    });

    it('D2 — texte NON sectionné (< 2 titres) : le comportement historique est intact, suffixe contigu', () => {
      const unsectioned = [
        '## Un seul titre',
        ...Array.from({ length: 40 }, (_, i) => `ligne ${i} : ${'x'.repeat(80)} fin ${i}.`),
      ].join('\n');
      expect(bytes(unsectioned)).toBeGreaterThan(CAP_D);

      const out = truncateToMaxSize(unsectioned, CAP_D, 'Status (fixture D2)');
      expect(bytes(out)).toBeLessThanOrEqual(CAP_D);
      // Suffixe exact : la règle « queue seule » n'a pas bougé d'un octet.
      expect(unsectioned.endsWith(out)).toBe(true);
      expect(out).not.toContain('## Un seul titre');
    });

    it('D3 — levier `=0` : bloc seul au-dessus du plafond ⇒ repli sur la queue (chemin historique)', () => {
      // Sous la part par défaut, ce bloc est rogné par date (F) ; le levier de
      // rollback rétablit « bloc entier ou rien » et ce chemin-ci.
      vi.stubEnv('CONDENSE_BLOCKERS_MAX_SHARE_PCT', '0');
      const huge = [
        '## Blocages structurels',
        ...Array.from({ length: 40 }, (_, i) => `blocage ${i} : ${'y'.repeat(200)} [vérifié 03/11].`),
      ].join('\n');
      const status = `## S1\n${huge}`;
      const cap = 500;
      expect(bytes(huge)).toBeGreaterThan(cap); // le bloc NE tient pas seul

      const out = truncateToMaxSize(status, cap, 'Status (fixture D3)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      expect(status.endsWith(out)).toBe(true); // chemin historique
      // Le heading du bloc est en TÊTE de bloc : absent de la fenêtre de queue.
      expect(out).not.toContain('## Blocages structurels');
    });

    it('D4 — blocages accentués et emoji : conservés octet pour octet, aucune paire de substitution cassée', () => {
      const block = [
        '## Blocages structurels',
        'blocage é : « déjà vérifié » — 字 😀 [vérifié 03/11 05:40Z].',
        'blocage à : données 100 % — fin de ligne.',
      ].join('\n');
      const fixture = [
        '## [workspace] — État',
        section('Résumé', 8),
        block,
        section('S9', 8),
      ].join('\n');
      const cap = 700;
      expect(bytes(fixture)).toBeGreaterThan(cap);

      const out = truncateToMaxSize(fixture, cap, 'Status (fixture D4)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      for (const line of block.split('\n')) expect(out).toContain(line);
      // Le plafond est un plafond d'OCTETS : la coupe ne laisse pas de
      // demi-surrogat (contraste avec une coupe par unités UTF-16).
      expect(Array.from(out).join('')).toBe(out);
    });

    it('D5 — comptabilité exacte : chaque séparateur compte, on s\'arrête à la première ligne qui fait tenir', () => {
      // Le corps de S5 (`---` + 2 queues ; la 3e est la dernière ligne, protégée)
      // est la plus grosse section retirable. Retirer `---` coûte 4 o (3 + le
      // séparateur) : à cap = total − 4, c'est la SEULE ligne qui tombe et le
      // plafond est atteint à l'octet. Un séparateur non compté (coût 3) laisse
      // 1 o de dépassement, une 2e ligne tombe et la sortie passe sous le plafond.
      const lead = '## [workspace] — État';
      const block = section('Blocages structurels', 3);
      const tail = [
        `queue 1 : ${'q'.repeat(120)}`,
        `queue 2 : ${'q'.repeat(120)}`,
        `queue 3 : ${'q'.repeat(120)}`,
      ];
      const fixture = [lead, section('Résumé', 2), block, '## S5', '---', ...tail].join('\n');

      const capA = bytes(fixture) - 4;
      const outA = truncateToMaxSize(fixture, capA, 'Status (fixture D5a)');
      expect(bytes(outA)).toBe(capA);
      expect(outA).toBe(fixture.replace('\n---\n', '\n'));

      // Un octet de moins : `---` ne suffit plus, la ligne du haut suivante de
      // la plus grosse section (toujours S5) paie — et seulement elle.
      const capB = capA - 1;
      const outB = truncateToMaxSize(fixture, capB, 'Status (fixture D5b)');
      expect(bytes(outB)).toBe(bytes(fixture) - 4 - (1 + bytes(tail[0])));
      expect(outB.split('\n')).not.toContain(tail[0]);
      expect(outB.endsWith(tail[2])).toBe(true);
      for (const line of block.split('\n')) expect(outB).toContain(line);
    });
  });

  describe('E — récence, marqueur d\'omission, contrat de libellé (review ms#1637)', () => {
    it('E1a — levier `=0` : bande meurtrière, le solde ne paie même pas la dernière ligne ⇒ repli historique, elle survit, le bloc paie', () => {
      // Le chemin bloc ne sert que le bloc ENTIER : sous la part par défaut, le
      // plancher par sections le rogne avant (F). On l'épingle sous le levier.
      vi.stubEnv('CONDENSE_BLOCKERS_MAX_SHARE_PCT', '0');
      // Revue ms#1637 réserve (a) : la boucle de queue démarrait à la DERNIÈRE
      // ligne et s'arrêtait net sur la première qui ne rentre pas — quand le
      // solde est plus petit que cette ligne, tail restait vide et la dernière
      // ligne mourait, contrairement au contrat de récence du chemin
      // historique (qui la hard-cute plutôt que de la perdre).
      const lead = '## [workspace] — État';
      const block = section('Blocages structurels', 3);
      const tail = [
        `queue 1 : ${'q'.repeat(150)}`,
        `queue 2 : ${'q'.repeat(150)}`,
        `DERNIÈRE : sentinelle de récence ${'z'.repeat(60)}`,
      ];
      const fixture = [lead, section('Résumé', 2), block, '## S5', ...tail].join('\n');
      const lines = fixture.split('\n');
      const start = lines.indexOf('## Blocages structurels');
      const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
      const leadBlockBytes = bytes([lines[0], ...lines.slice(start, end)].join('\n'));
      const lastCost = 1 + bytes(lines[lines.length - 1]);
      // La bande meurtrière exacte : lead+bloc passent SEULS, mais pas avec la
      // dernière ligne en plus.
      const cap = leadBlockBytes + Math.max(1, lastCost - 2);
      expect(leadBlockBytes).toBeLessThanOrEqual(cap);
      expect(leadBlockBytes + lastCost).toBeGreaterThan(cap);

      const out = truncateToMaxSize(fixture, cap, 'Status (fixture E1a)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      // Contrat de récence : la dernière ligne survit…
      expect(out.endsWith(lines[lines.length - 1])).toBe(true);
      // …et c'est le BLOC qui paie : chemin historique (suffixe contigu).
      expect(fixture.endsWith(out)).toBe(true);
      expect(out).not.toContain('## Blocages structurels');
    });

    it('E1b — levier `=0` : frontière inclusive, lead+bloc+dernière ligne exactement = budget ⇒ les trois tenus, l\'avant-dernière seule sacrifiée', () => {
      vi.stubEnv('CONDENSE_BLOCKERS_MAX_SHARE_PCT', '0');
      // Épingle d'exactitude (pas un témoin de mutation — l'état mergé rend
      // la même sortie à CE budget) : la garde est ≤, le seed paie la dernière
      // ligne en premier, et le plafond est atteint sans être franchi.
      const lead = '## [workspace] — État';
      const block = section('Blocages structurels', 3);
      const tail = [
        `queue 1 : ${'q'.repeat(150)}`,
        `DERNIÈRE : sentinelle de récence ${'z'.repeat(60)}`,
      ];
      const fixture = [lead, section('Résumé', 2), block, '## S5', ...tail].join('\n');
      const lines = fixture.split('\n');
      const start = lines.indexOf('## Blocages structurels');
      const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
      const leadBlock = [lines[0], ...lines.slice(start, end)].join('\n');
      const last = lines[lines.length - 1];
      const prev = lines[lines.length - 2];
      const cap = bytes(leadBlock) + 1 + bytes(last);
      expect(bytes(leadBlock) + (1 + bytes(last)) + (1 + bytes(prev))).toBeGreaterThan(cap);

      const out = truncateToMaxSize(fixture, cap, 'Status (fixture E1b)');
      expect(bytes(out)).toBe(cap); // atteint sans être franchi
      expect(out).toContain('## Blocages structurels'); // bloc tenu
      expect(out.endsWith(last)).toBe(true); // dernière tenue (réservée d'abord)
      expect(out.split('\n')).not.toContain(prev); // l'avant-dernière paie
    });

    it('E2 — le marqueur d\'omission annonce le VRAI compte de lignes tombées, et son budget est compté dans le plafond', () => {
      // Revue ms#1637 réserve (b) : la sortie du plancher ressemblait à un
      // document complet. Le marqueur est budgété comme #2719 — ses octets
      // sont réservés AVANT la troncature, marqueur + corps ≤ plafond.
      const fixture = [
        '## [workspace] — État',
        section('Résumé', 8),
        section('Blocages structurels', 4),
        section('S4', 8),
      ].join('\n');
      const cap = 1200;
      expect(bytes(fixture)).toBeGreaterThan(cap);

      const out = truncateWithOmissionMarker(fixture, cap, 'Status (fixture E2)');
      expect(bytes(out)).toBeLessThanOrEqual(cap); // invariant dur, marqueur compris
      const outLines = out.split('\n');
      const m = /^… (\d+) lignes omises$/.exec(outLines[0]);
      expect(m, 'la première ligne doit être le marqueur d\'omission').not.toBeNull();
      const removed = Number(m![1]);
      expect(removed).toBeGreaterThan(0);
      // Le compte est VRAI : lignes d'origine − lignes rendues (hors marqueur).
      expect(fixture.split('\n').length - (outLines.length - 1)).toBe(removed);
      // Budgété, pas plaqué : le corps tient sous le plafond RÉDUIT du marqueur.
      expect(bytes(outLines.slice(1).join('\n'))).toBeLessThanOrEqual(cap - bytes(`${outLines[0]}\n`));

      // Texte qui tient : aucun marqueur, sortie inchangée.
      const small = '## tient\nligne unique';
      expect(truncateWithOmissionMarker(small, 4096, 'Status (fixture E2bis)')).toBe(small);
    });

    it('E3 — contrat de libellé : « Verrous » (même rôle, autre libellé) = contenu ordinaire, rogné comme les autres', () => {
      // Revue ms#1637 réserve (c) : seuls « Blocages » / « Blockers » ouvrent
      // le droit au bloc ENTIER. Élargir le libellé est une décision produit,
      // pas une optimisation — ce test rend toute élargissement silencieuse rouge.
      // Depuis le plancher par sections (#4434, 04/11), le titre d'une section
      // ordinaire survit, mais son CORPS paie comme les autres.
      const lockLines = Array.from({ length: 12 }, (_, i) => `verrou ${i} : ${'v'.repeat(90)} [vérifié 03/11 22:53Z].`);
      // Sections voisines de 8 lignes : les verrous (~1,5 Ko) restent la plus
      // grosse section ET tiennent dans la part de 40 % du plafond (~1,7 Ko).
      const build = (title: string) => [
        '## [workspace] — État',
        section('Résumé', 8),
        `## ${title}`,
        ...lockLines,
        section('S4', 8),
        section('S5', 8),
      ].join('\n');
      const ordinary = build('Verrous ouverts');
      const cap = bytes(ordinary) - 200;

      const out = truncateToMaxSize(ordinary, cap, 'Status (fixture E3)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      expect(out).toContain('## Verrous ouverts'); // titre gardé, comme tout titre
      expect(lockLines.filter(l => out.includes(l)).length).toBeLessThan(lockLines.length); // corps rogné

      // Témoin : le MÊME contenu sous le libellé « Blocages » est gardé entier.
      const privileged = build('Blocages structurels');
      const outP = truncateToMaxSize(privileged, bytes(privileged) - 200, 'Status (fixture E3 témoin)');
      for (const l of lockLines) expect(outP).toContain(l);
    });
  });

  describe('F — part des blocages : au-delà de 40 % du plafond, les moins récemment vérifiés sortent (#4434, 04/11)', () => {
    // Mesuré sur 24 statuts archivés (31/10-04/11) : la section blocages
    // croissait à chaque passe jusqu'à 91 % du statut (14,5 Ko sur 15,9 Ko),
    // avec 0-1 ligne marquée REFUTE/RÉSOLU — des lignes entrent, aucune ne
    // sort, et « gardée entière » faisait payer les sept autres sections.
    const LINE = 120;
    /** Ligne de blocage de 120 o exactement, tampon en fin de ligne comme en production. */
    const blocker = (id: string, stamp: string) => {
      const head = `- **${id}** : `;
      return `${head}${'b'.repeat(LINE - bytes(head) - bytes(stamp) - 1)} ${stamp}`;
    };
    /** Tampons strictement décroissants : la ligne 0 est la plus récemment vérifiée. */
    const stampAt = (i: number) => {
      const hh = String(23 - Math.floor(i / 3)).padStart(2, '0');
      const mm = String(50 - (i % 3) * 20).padStart(2, '0');
      return `[vérifié 04/11 ${hh}:${mm}Z]`;
    };
    const blockersBody = (out: string) => {
      const ls = out.split('\n');
      const start = ls.indexOf('## Blocages structurels');
      let end = ls.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
      if (end === -1) end = ls.length;
      return ls.slice(start + 1, end);
    };
    const bodyBytes = (ls: string[]) => ls.reduce((a, l) => a + bytes(l) + 1, 0);
    const CAP_F = 8 * 1024;
    const SHARE_F = Math.floor(CAP_F * 0.4);
    const others = [['Résumé', 2], ['État des systèmes', 3], ['Décisions actées', 3], ['Livrables récents', 2], ['Patterns appris', 2]] as const;
    /** Forme mesurée : la section blocages porte l'essentiel du statut. */
    const measured = (n: number) => [
      '## [workspace-roo-extensions] — État au 2026-11-04T08:17Z',
      section('Résumé', 2),
      section('État des systèmes', 3),
      section('Décisions actées', 3),
      '## Blocages structurels',
      ...Array.from({ length: n }, (_, i) => blocker(`B${i}`, stampAt(i))),
      section('Livrables récents', 2),
      section('Patterns appris', 2),
    ].join('\n');

    it('F1 — forme mesurée (blocages > 80 % du statut) : la part est tenue au plus juste, les autres sections sortent INTACTES', () => {
      const fx = measured(70);
      expect(bytes(fx)).toBeGreaterThan(CAP_F);
      const before = blockersBody(fx);
      expect(bodyBytes(before) / bytes(fx)).toBeGreaterThan(0.8);

      const out = truncateToMaxSize(fx, CAP_F, 'Status (fixture F1)');
      expect(bytes(out)).toBeLessThanOrEqual(CAP_F);
      const kept = blockersBody(out);
      expect(bodyBytes(kept)).toBeLessThanOrEqual(SHARE_F);
      expect(bodyBytes(kept) + LINE + 1).toBeGreaterThan(SHARE_F); // une ligne de plus déborderait
      // Les plus récemment vérifiées restent — ici en tête : préfixe exact, ordre gardé.
      expect(kept).toEqual(before.slice(0, kept.length));
      // Les autres sections, que « Blocages entiers » faisait payer, sont intactes.
      for (const [t, n] of others) {
        for (const line of section(t, n).split('\n')) expect(out).toContain(line);
      }
      expect(out.split('\n')[0]).toBe('## [workspace-roo-extensions] — État au 2026-11-04T08:17Z');
    });

    it('F2 — ordre de sortie : REFUTE/RÉSOLU, puis non daté, puis la vérification la plus ancienne ; à égalité, la plus haute', () => {
      const ls = [
        blocker('neuf', '[vérifié 04/11 08:00Z]'),
        blocker('sans-date', '(aucun tampon)'),
        blocker('refuté', 'REFUTE 04/11 03:45Z [vérifié 04/11 09:00Z]'),
        blocker('ancien', '[vérifié 02/11 10:00Z]'),
        blocker('moyen-haut', '[vérifié 03/11 10:00Z]'),
        blocker('moyen-bas', '[vérifié 03/11 10:00Z]'),
        blocker('résolu', 'RÉSOLU [vérifié 04/11 10:00Z]'),
      ];
      const fx = ['## [workspace] — État', '## Résumé', 'résumé court', '## Blocages structurels', ...ls, '## Fin', 'fin'].join('\n');
      // Part = floor(0,4 × 7 × 121) = 338 o : 2 lignes (242 o) tiennent, 3 (363 o) non ⇒ 5 sortent.
      const cap = 7 * (LINE + 1);
      expect(bytes(fx)).toBeGreaterThan(cap);

      const out = truncateToMaxSize(fx, cap, 'Status (fixture F2)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      expect(blockersBody(out)).toEqual([ls[0], ls[5]]);
    });

    it('F3 — tampon sans année : décembre lu en janvier est l\'année d\'avant ; variantes du tampon', () => {
      const jan = new Date('2027-01-05T12:00:00Z');
      expect(blockerDropRank('x [vérifié 28/12 10:00Z]', jan)).toBeLessThan(blockerDropRank('x [vérifié 02/01 09:00Z]', jan));
      const nov = new Date('2026-11-04T12:00:00Z');
      expect(blockerDropRank('x [vérifié 03/11 23:59Z]', nov)).toBeLessThan(blockerDropRank('x [vérifié 04/11 00:01Z]', nov));
      // Graphie sans accent (celle de la règle #4082) et heure optionnelle : datées.
      expect(blockerDropRank('x [verifie 05/10 22:53Z]', nov)).toBeGreaterThan(Number.MIN_SAFE_INTEGER);
      expect(blockerDropRank('x [vérifié 03/11]', nov)).toBeLessThan(blockerDropRank('x [vérifié 03/11 00:01Z]', nov));
      // « posé » n'est pas une vérification : non daté.
      expect(blockerDropRank('x [posé 02/11]', nov)).toBe(Number.MIN_SAFE_INTEGER);
      // Marqueurs en majuscules = déclassé ; la prose « non résolu » et un préfixe de mot, non.
      expect(blockerDropRank('x REFUTE 04/11 [vérifié 04/11 09:00Z]', nov)).toBe(Number.NEGATIVE_INFINITY);
      expect(blockerDropRank('x RÉSOLU [vérifié 04/11 09:00Z]', nov)).toBe(Number.NEGATIVE_INFINITY);
      expect(blockerDropRank('x non résolu [vérifié 04/11 09:00Z]', nov)).toBeGreaterThan(Number.MIN_SAFE_INTEGER);
      expect(blockerDropRank('x REFUTED_BY [vérifié 04/11 09:00Z]', nov)).toBeGreaterThan(Number.MIN_SAFE_INTEGER);
    });

    it('F4 — levier : `=0` garde les blocages ENTIERS (les autres paient), valeur invalide = 40 %, `25` = 25 %', () => {
      // 60 lignes (7,3 Ko) : entières, elles tiennent encore avec les titres et la dernière ligne.
      const fx = measured(60);
      expect(bytes(fx)).toBeGreaterThan(CAP_F);
      const before = blockersBody(fx);

      vi.stubEnv('CONDENSE_BLOCKERS_MAX_SHARE_PCT', '0');
      const whole = truncateToMaxSize(fx, CAP_F, 'Status (fixture F4 =0)');
      expect(bytes(whole)).toBeLessThanOrEqual(CAP_F);
      expect(blockersBody(whole)).toEqual(before);
      const othersLines = others.flatMap(([t, n]) => section(t, n).split('\n').slice(1));
      expect(othersLines.filter(l => !whole.includes(l)).length).toBeGreaterThan(0);

      vi.stubEnv('CONDENSE_BLOCKERS_MAX_SHARE_PCT', 'abc');
      expect(bodyBytes(blockersBody(truncateToMaxSize(fx, CAP_F, 'Status (fixture F4 abc)')))).toBeLessThanOrEqual(SHARE_F);

      vi.stubEnv('CONDENSE_BLOCKERS_MAX_SHARE_PCT', '25');
      const quarter = bodyBytes(blockersBody(truncateToMaxSize(fx, CAP_F, 'Status (fixture F4 25)')));
      expect(quarter).toBeLessThanOrEqual(Math.floor(CAP_F * 0.25));
      expect(quarter + LINE + 1).toBeGreaterThan(Math.floor(CAP_F * 0.25));
    });

    it('F5 — le cliquet est rompu : 5 passes où le générateur ajoute 40 blocages frais, la part tient, les anciens sortent', () => {
      let status = measured(70);
      for (let p = 1; p <= 5; p++) {
        const fresh = Array.from({ length: 40 }, (_, i) =>
          blocker(`P${p}-${i}`, `[vérifié 0${4 + p}/11 ${String(23 - Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '10' : '40'}Z]`));
        // Le générateur réécrit le statut : ses lignes fraîches arrivent en tête des blocages.
        status = status.replace('## Blocages structurels\n', `## Blocages structurels\n${fresh.join('\n')}\n`);
        expect(bytes(status)).toBeGreaterThan(CAP_F); // le plancher tourne bien à chaque passe

        const out = truncateToMaxSize(status, CAP_F, `Status (fixture F5 passe ${p})`);
        expect(bytes(out)).toBeLessThanOrEqual(CAP_F);
        const kept = blockersBody(out);
        expect(bodyBytes(kept)).toBeLessThanOrEqual(SHARE_F);
        // Les 40 fraîches (4,8 Ko) dépassent seules la part : rien d'une passe précédente ne survit.
        expect(kept.length).toBeGreaterThan(0);
        expect(kept.every(l => l.startsWith(`- **P${p}-`))).toBe(true);
        for (const [t, n] of others) {
          for (const line of section(t, n).split('\n')) expect(out).toContain(line);
        }
        status = out;
      }
    });

    it('F6 — blocages en DERNIÈRE section : la dernière ligne du document survit, même la plus ancienne', () => {
      const ls = Array.from({ length: 10 }, (_, i) => blocker(`L${i}`, stampAt(i))); // L9 = la plus ancienne
      const fx = ['## [workspace] — État', section('Résumé', 2), '## Blocages structurels', ...ls].join('\n');
      const cap = bytes(fx) - 2 * (LINE + 1);

      const out = truncateToMaxSize(fx, cap, 'Status (fixture F6)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      expect(out.endsWith(ls[9])).toBe(true);
      expect(out).not.toContain(ls[8]); // la plus ancienne parmi les candidates est sortie
    });

    it('F7 — le marqueur d\'omission compte aussi les blocages sortis : compte vrai, plafond tenu', () => {
      const fx = measured(70);
      const out = truncateWithOmissionMarker(fx, CAP_F, 'Status (fixture F7)');
      expect(bytes(out)).toBeLessThanOrEqual(CAP_F);
      const outLines = out.split('\n');
      const m = /^… (\d+) lignes omises$/.exec(outLines[0]);
      expect(m).not.toBeNull();
      expect(fx.split('\n').length - (outLines.length - 1)).toBe(Number(m![1]));
      expect(Number(m![1])).toBe(70 - 27); // 27 lignes de 121 o = 3 267 o ≤ part
    });
  });
});
