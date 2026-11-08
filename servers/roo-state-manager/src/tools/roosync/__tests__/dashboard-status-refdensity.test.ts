/**
 * #4434 — critère « refs/Ko >= 4,0 » : tests du helper de densité d'ancres.
 *
 * Le plancher est calé sur la distribution mesurée après pivot (n=363 statuts :
 * P25 4,12 / médiane 7,47 refs/Ko) ; la queue sous-plancher mesurée est à
 * 98,8 % des statuts >= 2 Kio — de la prose HAUTE sans ancres, pas des petits
 * statuts pénalisés par la division. Ces tests pinnent le helper pur
 * `measureStatusRefDensity` (regex du corpus `#\d{2,5}\b`, taille UTF-8) et
 * les constantes exportées. Le mode est WARN-only — mesure et signalement,
 * jamais de rejet (GO coordinateur c.6723319640) ; le point de branchement
 * (statut FINAL après les gardes #3771/#3803/#3962) vit dans le pipeline.
 */
import { describe, it, expect } from 'vitest';
import {
  measureStatusRefDensity,
  STATUS_REF_DENSITY_FLOOR,
  STATUS_REF_DENSITY_MIN_KB,
} from '../dashboard.js';

describe('STATUS_REF_DENSITY constants (#4434)', () => {
  it('floor is the calibrated P25 rounded down — 4.0 refs/Ko, not stricter', () => {
    // GO c.6723319640 : le plancher activé est 4,0 (P25 mesuré 4,12 arrondi).
    // Un durcissement silencieux du seuil casserait le contrat du GO.
    expect(STATUS_REF_DENSITY_FLOOR).toBe(4.0);
  });

  it('min size below which the ratio is meaningless is the corpus filter 0.3 KiB', () => {
    expect(STATUS_REF_DENSITY_MIN_KB).toBeCloseTo(0.3, 10);
  });
});

describe('measureStatusRefDensity (#4434)', () => {
  it('counts #NN anchors over UTF-8 size — a payload status is dense', () => {
    const lines = Array.from(
      { length: 8 },
      (_, i) => `- #460${i} livré (PR mergée, tests verts, cycle rapporté sur le dashboard)`
    ).join('\n');
    const r = measureStatusRefDensity(lines);
    expect(r).not.toBeNull();
    expect(r!.refs).toBe(8);
    expect(r!.density).toBeGreaterThan(STATUS_REF_DENSITY_FLOOR);
  });

  it('tall prose without anchors is the below-floor case the criterion targets', () => {
    // La queue mesurée : médiane 14,4 Kio de prose sans une seule ancre #NN.
    const prose = Array.from(
      { length: 24 },
      (_, i) => `Ligne ${i} : la coordination poursuit son cours, les lanes rapportent, rien à signaler.`
    ).join('\n');
    const r = measureStatusRefDensity(prose);
    expect(r).not.toBeNull();
    expect(r!.refs).toBe(0);
    expect(r!.density).toBeLessThan(STATUS_REF_DENSITY_FLOOR);
  });

  it('returns null below the minimum size — the ratio is meaningless there', () => {
    // 2 refs sur 40 octets : 0,04 Kio — hors corpus, exempt de mesure.
    const r = measureStatusRefDensity('#123 ok\n#456 ok');
    expect(r).toBeNull();
  });

  it('anchor regex is the corpus regex: single-digit and 6-digit numbers do not count', () => {
    // `#\d{2,5}\b` du script de distribution : #1 (1 chiffre) et #123456
    // (6 chiffres) ne sont pas des ancres d'issue/PR ; #42 et #4604 le sont.
    const body = '#1 x\n#123456 y\n#42 z\n#4604 w\n'.padEnd(400, 'prose ');
    const r = measureStatusRefDensity(body);
    expect(r).not.toBeNull();
    expect(r!.refs).toBe(2);
  });

  it('size is UTF-8 bytes, not character count', () => {
    // « é » = 2 octets : la taille mesurée doit suivre les octets UTF-8,
    // comme le script de distribution qui a calé le seuil.
    const ascii = 'a'.repeat(1024);
    const accent = 'é'.repeat(1024);
    const rAscii = measureStatusRefDensity(ascii);
    const rAccent = measureStatusRefDensity(accent);
    expect(rAccent!.kb).toBeGreaterThan(rAscii!.kb);
  });
});
