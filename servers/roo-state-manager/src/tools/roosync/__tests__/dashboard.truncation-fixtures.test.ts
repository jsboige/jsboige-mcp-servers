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
 *      coupe en plein token (le « (658 » mesuré) ; le diviseur de sécurité
 *      UTF-8 doit garantir le plafond d'octets (défaut /2 trouvé PAR cette
 *      suite : '字'×600 sous cap 600 rendait 900 o — une unité UTF-16 code
 *      jusqu'à 3 octets, pas 2).
 *   C. Marqueur #2719 — strip ancré en début de ligne (la prose citant la
 *      sentinelle survit), au plus un marqueur par re-stamp, et le contrat
 *      de réservation du call-site (marker + statut tronqué ≤ plafond).
 *
 * Témoins de mutation (exécutés au cycle, consignés dans la PR) :
 *   M1 inversion du sens de la boucle (tête↔queue)        → A1 rouge
 *   M2 diviseur /3 → /2                                    → B2 rouge
 *   M3 strip startsWith → includes                         → C1 rouge
 *   M4 slice(-maxChars) → slice(0, maxChars)               → B1 rouge
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
      expect(out.length).toBeGreaterThan(0);
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

      // La coupure atterrit entre deux chiffres : nombre amputé, ni
      // séparateur ni début de token à la frontière.
      const windowStart = line.length - out.length;
      expect(windowStart).toBeGreaterThan(0);
      expect(/^[0-9]/.test(out)).toBe(true);
      expect(/[0-9]$/.test(line.charAt(windowStart - 1))).toBe(true);
    });

    it('B2 — plafond DUR en pire cas UTF-8 : 3 octets par unité (le diviseur /2 le violait — défaut trouvé par cette suite)', () => {
      // '字' = 3 octets UTF-8 pour 1 unité JS. Avec maxChars = floor(cap/2)
      // le rendu faisait cap/2 × 3 = 1,5× cap en octets (mesure : cap 600
      // → 900 o). Une unité UTF-16 code au plus 3 octets (BMP ; les paires
      // supplémentaires font 2 unités × 2 octets = 2 o/unité) : /3 est le
      // diviseur sûr LE PLUS SERRE. Mutant M2 (/3 → /2) rouge ici.
      const line = '字'.repeat(600); // 600 unités, 1 800 o
      const cap = 600;
      const out = truncateToMaxSize(line, cap, 'Status (fixture B2)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      expect(out.length).toBeGreaterThan(0);
    });

    it('B3 — emoji 4 octets, fenêtre alignée sur les paires : emoji ENTIERS, ≤ cap', () => {
      // cap 600 → fenêtre floor(600/3) = 200 unités = 100 paires exactement.
      const line = '😀'.repeat(400); // 800 unités JS, 1 600 o
      const cap = 600;
      const out = truncateToMaxSize(line, cap, 'Status (fixture B3)');
      expect(bytes(out)).toBeLessThanOrEqual(cap);
      // Paires surrogates intactes : longueur paire et décomposition en
      // codepoints complets (aucun demi-surrogat isolé).
      expect(out.length % 2).toBe(0);
      expect(out).toBe('😀'.repeat(out.length / 2));
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
