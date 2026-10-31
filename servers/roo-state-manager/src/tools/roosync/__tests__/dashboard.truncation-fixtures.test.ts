/**
 * #4434 volet 5 — fixtures hors ligne du chemin de troncation déterministe.
 *
 * Cycle 1 (po-204, corpus GDrive) a mesuré les mécanismes ; cette suite les
 * ÉPINGLE sur les fonctions réellement exportées et réellement appelées au
 * fallback (`truncateToMaxSize`, le trio marqueur #2719), pour qu'aucune
 * réintroduction ne passe inaperçue :
 *
 *   A. Décapitation de TÊTE — la boucle garde les lignes depuis la FIN
 *      (dashboard.ts « Keep lines from the end ») : les premières sections
 *      du statut (Résumé, État des systèmes, Décisions) meurent les
 *      premières. Chemin MAJORITAIRE (condensation déterministe dominante
 *      dans les mesures ai-01).
 *   B. Fallback mono-ligne — la fenêtre garde les DERNIERS caractères et
 *      coupe en plein token (le « (658 » mesuré) ; la coupe doit être
 *      EXACTE à l'octet et alignée sur les points de code (#4434 : le
 *      diviseur /3, borne du pire cas, jetait deux tiers du budget en ASCII ;
 *      avant lui /2, trouvé PAR cette suite, violait le plafond).
 *   C. Marqueur #2719 — strip ancré en début de ligne (la prose citant la
 *      sentinelle survit), au plus un marqueur par re-stamp, et le contrat
 *      de réservation du call-site (marker + statut tronqué ≤ plafond).
 *
 * Témoins de mutation (exécutés au cycle, consignés dans la PR) :
 *   M1 inversion du sens de la boucle (tête↔queue)        → A1 rouge
 *   M2 diviseur /3 → /2                                    → B2 rouge
 *   M3 strip startsWith → includes                         → C1 rouge
 *   M4 slice(-maxChars) → slice(0, maxChars)               → B1 rouge
 *   M5 coupe exacte → retour au diviseur floor(cap/3)      → B1/B2 rouges
 *   M6 paire de substitution non enjambée (1 unité)         → B5 rouge
 *   M7 largeur 4 octets comptée 3                           → B4/B5 rouges
 *
 * Hors d'atteinte unitaire (documenté, non testé ici) : l'append des marqueurs
 * #1502/#3803 APRÈS condenseTextIfTooLarge (dashboard.ts ~L5753-5782, mesure
 * cycle 1 : statuts jusqu'à ~16 012 o > 15 360) vit dans le pipeline de
 * condensation complet, pas dans une fonction exportée.
 *
 * @module tools/roosync/__tests__/dashboard.truncation-fixtures
 */

import { describe, it, expect, vi } from 'vitest';
import {
  truncateToMaxSize,
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

  describe('A — la queue survit, la tête est décapitée (mécanisme mesuré cycle 1)', () => {
    // 8 sections de ~2,1 Ko : les 3 premières portent les noms des sections
    // réelles décapitées dans les mesures (Résumé, État des systèmes,
    // Décisions) ; total ≈ 17 Ko, cap 6,5 Ko → seules ~3 sections de queue tiennent.
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

    it('A1 — les sections de TÊTE (Résumé/État des systèmes/Décisions) disparaissent, les sections de QUEUE survivent intactes', () => {
      const out = truncateToMaxSize(fixture, CAP_A, 'Status (fixture A)');
      expect(bytes(out)).toBeLessThanOrEqual(CAP_A);
      expect(bytes(out)).toBeGreaterThan(0);
      // La queue survit — y compris la toute dernière ligne, entière.
      expect(out).toContain('## S7');
      const lastOriginalLine = fixture.slice(fixture.lastIndexOf('\n') + 1);
      expect(out.endsWith(lastOriginalLine)).toBe(true);
      // La tête est décapitée : les surfaces de lecture primaire meurent.
      expect(out).not.toContain('## Résumé');
      expect(out).not.toContain('## État des systèmes');
      expect(out).not.toContain('## Décisions actées');
      expect(out).not.toContain('## S0'); // le fixture n'a pas de S0 — garde la forme
    });

    it('A2 — la coupe multi-lignes est granulaire par LIGNE : chaque ligne gardée est une ligne entière du fixture', () => {
      const out = truncateToMaxSize(fixture, CAP_A, 'Status (fixture A)');
      const originalLines = new Set(fixture.split('\n'));
      const keptLines = out.split('\n');
      // Toutes les lignes gardées existent telles quelles dans le fixture :
      // jamais de coupe au milieu d'une ligne sur le chemin multi-lignes
      // (contraste avec le fallback mono-ligne, B1).
      for (const line of keptLines) {
        expect(originalLines.has(line)).toBe(true);
      }
      // Et le résultat est bien un SUFFIXE du fixture (contigu depuis la fin).
      expect(fixture.endsWith(out)).toBe(true);
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
});
