/**
 * Garde fraîcheur des fixtures temporelles (#3673, livrable « gate
 * anti-fixture-périmée ») — suite du fix T0 (#1160).
 *
 * Incident fondateur (15/09 10:00Z) : compare-claude-settings.test.ts:65
 * épinglait `collectedAt: '2026-09-08T10:00:00Z'` ; avec
 * CLAUDE_SETTINGS_STALE_WARN_DAYS=7 (compare-config.ts:1005), la fixture a
 * basculé STALE le 15/09 à 10:00Z — toute PR ouverte de la flotte est
 * devenue rouge, quel que soit son diff. Le défaut n'est pas la date figée
 * en soi : c'est une date figée CONSOMMÉE COMME UN ÂGE par du code de
 * production qui lit Date.now().
 *
 * FAILS quand un fichier de test assigne un littéral ISO ABSOLU à un champ
 * dont la production calcule l'âge (`collectedAt` — seuils 7 j/30 j,
 * compare-config.ts:1005-1006 ; `snapshotAt` — seuil 7 j,
 * compare-config.ts:885) et que le fichier n'injecte PAS une horloge
 * contrôlée. Sans horloge mockée, ces fixtures sont des bombes à
 * retardement : vertes le jour de leur écriture, rouges à l'échéance du
 * seuil — sans aucun changement de diff.
 *
 * Exemptés : les fichiers portant un marqueur d'horloge contrôlée
 * (vi.useFakeTimers / setSystemTime / `now: () =>`). Là, une date figée est
 * déterministe par construction : les deux côtés de la comparaison
 * temporelle partagent la même horloge.
 *
 * Correctif attendu : exprimer la date RELATIVEMENT à l'instant du test —
 * `new Date(Date.now() - n * 864e5).toISOString()` (cf. `daysAgoIso`,
 * compare-claude-settings.test.ts) — ou mocker l'horloge du fichier.
 *
 * Périmètre assumé : seule la forme « littéral d'objet »
 * (`collectedAt: '20…'`) est gardée. Les passes positionnelles via helpers
 * (buildSnapshot(…), publishSnapshot(…, collectedAt)) échappent à une
 * détection statique fiable ; leur sûreté vient de l'horloge contrôlée des
 * fichiers qui les emploient (HarmonizationCampaignService.test.ts injecte
 * `now`, ClaudeSettingsService.test.ts mocke `now`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { glob } from 'glob';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Champs dont la production calcule l'âge contre Date.now().
const AGE_CONSUMED_FIELDS = ['collectedAt', 'snapshotAt'];

// Littéral ISO absolu en valeur d'un champ consommé comme un âge.
const FROZEN_FIXTURE_RE = new RegExp(
  `(${AGE_CONSUMED_FIELDS.join('|')})\\s*:\\s*(['"])20\\d{2}-\\d{2}-\\d{2}`
);

// Marqueurs d'horloge contrôlée : une date figée y est déterministe.
const CONTROLLED_CLOCK_RE =
  /vi\.useFakeTimers|setSystemTime|now\s*:\s*\(\s*\)\s*=>/;

describe('Garde fraîcheur des fixtures temporelles (#3673)', () => {
  it('aucune fixture à date ISO absolue sur un champ consommé comme un âge', async () => {
    const files = await glob(['src/**/*.test.ts', 'tests/**/*.test.ts'], {
      cwd: ROOT,
      absolute: true,
    });
    expect(files.length, 'la découverte des tests ne doit pas être vide').toBeGreaterThan(0);

    const violations: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf-8');
      if (!FROZEN_FIXTURE_RE.test(text)) continue;
      if (CONTROLLED_CLOCK_RE.test(text)) continue;
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      text.split('\n').forEach((line, i) => {
        if (FROZEN_FIXTURE_RE.test(line)) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(
      violations,
      `littéral ISO ABSOLU sur ${AGE_CONSUMED_FIELDS.join('/')} sans horloge contrôlée — bombe à retardement de seuil (cf. #1160, #3673). Exprimer la date relative à now (daysAgoIso) ou mocker l'horloge du fichier.`
    ).toEqual([]);
  });
});
