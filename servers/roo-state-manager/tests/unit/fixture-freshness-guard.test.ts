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
 * compare-config.ts:885) sans exemption déclarée.
 *
 * Exemption — marqueur opt-in strict (review #1162) : seul un commentaire
 * DÉDIÉ portant le marqueur `fixture-freshness-guard: controlled-clock`
 * (CONTROLLED_CLOCK_MARKER_RE) exempte le fichier, à poser uniquement là où
 * l'horloge est effectivement contrôlée (vi.useFakeTimers / setSystemTime /
 * horloge injectée `now`). Une simple mention des API d'horloge dans un
 * commentaire ou une chaîne N'EXEMPTE PAS — l'heuristique textuelle
 * file-wide de la v1 était neutralisable par un simple commentaire.
 *
 * Correctif attendu : exprimer la date RELATIVEMENT à l'instant du test —
 * `new Date(Date.now() - n * 864e5).toISOString()` (cf. `daysAgoIso`,
 * compare-claude-settings.test.ts) — ou mocker l'horloge du fichier puis
 * déclarer le marqueur.
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
const OWN_PATH = fileURLToPath(import.meta.url);

// Champs dont la production calcule l'âge contre Date.now().
const AGE_CONSUMED_FIELDS = ['collectedAt', 'snapshotAt'];

// Littéral ISO absolu en valeur d'un champ consommé comme un âge.
const FROZEN_FIXTURE_RE = new RegExp(
  `(${AGE_CONSUMED_FIELDS.join('|')})\\s*:\\s*(['"])20\\d{2}-\\d{2}-\\d{2}`
);

// Exemption : ligne de commentaire DÉDIÉE (//, * docblock, #) commençant
// par le marqueur opt-in. Ni une mention des API d'horloge, ni le marqueur
// dans une chaîne de code n'exemptent (contre-épreuves 1 et 4).
const CONTROLLED_CLOCK_MARKER_RE =
  /^\s*(?:\/\/|\*|#)\s*fixture-freshness-guard:\s*controlled-clock\b/;

/**
 * Égalité de chemins pour l'auto-exclusion.
 *
 * Windows : `path.resolve` ne normalise PAS la casse de la lettre de lecteur.
 * Sous vitest, `import.meta.url` rend `d:\dev\…` (casse du cwd de lancement)
 * tandis que `glob({absolute:true})` rend `D:\dev\…` (casse du volume). Une
 * comparaison `===` sur chemins résolus est donc FAUSSE sur ce siège : le
 * fichier ne se reconnaissait pas lui-même et la garde signalait ses propres
 * lignes de contre-épreuve (6/111/120/139), rouge Windows-only sur `main`
 * depuis la fermeture de #3673. Mesuré po-2027 23/11 (c.05:30Z).
 */
function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

interface FileVerdict {
  exempted: boolean;
  /** violations au format "lineNo: trimmed line" */
  violations: string[];
}

/** Décision unitaire de la garde — pure, testable sur des lignes synthétiques. */
function evaluateLines(lines: string[]): FileVerdict {
  if (lines.some(l => CONTROLLED_CLOCK_MARKER_RE.test(l))) {
    return { exempted: true, violations: [] };
  }
  const violations: string[] = [];
  lines.forEach((line, i) => {
    if (FROZEN_FIXTURE_RE.test(line)) violations.push(`${i + 1}: ${line.trim()}`);
  });
  return { exempted: false, violations };
}

describe('Garde fraîcheur des fixtures temporelles (#3673)', () => {
  it('aucune fixture à date ISO absolue sur un champ consommé comme un âge, sans marqueur controlled-clock', async () => {
    const files = await glob(['src/**/*.test.ts', 'tests/**/*.test.ts'], {
      cwd: ROOT,
      absolute: true,
    });
    expect(files.length, 'la découverte des tests ne doit pas être vide').toBeGreaterThan(0);

    const violations: string[] = [];
    for (const f of files) {
      // Self-exclusion documentée : CE fichier cite le littéral de l'incident
      // dans sa doc et dans ses contre-épreuves. La contre-épreuve 3 prouve
      // que cette exclusion n'est PAS une auto-exemption : évalué comme un
      // fichier tiers, il rendrait exempted=false avec violations.
      if (samePath(f, OWN_PATH)) continue;
      const lines = readFileSync(f, 'utf-8').split('\n');
      const verdict = evaluateLines(lines);
      if (verdict.exempted) continue;
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      for (const v of verdict.violations) violations.push(`${rel}:${v}`);
    }

    expect(
      violations,
      `littéral ISO ABSOLU sur ${AGE_CONSUMED_FIELDS.join('/')} sans marqueur d'exemption — bombe à retardement de seuil (cf. #1160, #3673). Exprimer la date relative à now (daysAgoIso), ou mocker l'horloge du fichier et déclarer le marqueur de commentaire dédié (cf. en-tête de cette garde).`
    ).toEqual([]);
  });

  describe("contre-épreuves du mécanisme d'exemption (review #1162)", () => {
    it('1. mention des API d’horloge en COMMENTAIRE seul n’exempte PAS → ROUGE', () => {
      const verdict = evaluateLines([
        '// horloge contrôlée : vi.useFakeTimers + setSystemTime + now: () => new Date()',
        "      collectedAt: '2026-09-08T10:00:00Z',",
      ]);
      expect(verdict.exempted).toBe(false);
      expect(verdict.violations).toHaveLength(1);
    });

    it('2. marqueur opt-in en commentaire dédié exempte → VERT', () => {
      const verdict = evaluateLines([
        '// fixture-freshness-guard: controlled-clock',
        "      collectedAt: '2026-09-08T10:00:00Z',",
      ]);
      expect(verdict.exempted).toBe(true);
      expect(verdict.violations).toEqual([]);
    });

    it('3. la garde n’est pas exemptée par sa propre documentation', () => {
      const own = readFileSync(OWN_PATH, 'utf-8').split('\n');
      const verdict = evaluateLines(own);
      // Le docblock cite le littéral de l'incident ET le nom du marqueur :
      // aucun des deux ne doit déclencher l'exemption (sinon la garde
      // s'auto-neutraliserait exactement comme sous l'heuristique v1).
      expect(verdict.exempted).toBe(false);
      expect(verdict.violations.length).toBeGreaterThan(0);
    });

    it('4. le marqueur écrit dans une CHAÎNE de code n’exempte pas', () => {
      const verdict = evaluateLines([
        "      const marker = '// fixture-freshness-guard: controlled-clock';",
        "      collectedAt: '2026-09-08T10:00:00Z',",
      ]);
      expect(verdict.exempted).toBe(false);
      expect(verdict.violations).toHaveLength(1);
    });

    it('5. auto-exclusion : deux écritures de la MÊME lettre de lecteur sont le même chemin', () => {
      // Régression Windows-only : `import.meta.url` rendait `d:\…` et `glob`
      // rendait `D:\…` ; `path.resolve` ne normalise pas la casse du lecteur,
      // donc `===` échouait et la garde flaggait ses propres lignes.
      const lower = OWN_PATH.charAt(0).toLowerCase() + OWN_PATH.slice(1);
      const upper = OWN_PATH.charAt(0).toUpperCase() + OWN_PATH.slice(1);
      if (process.platform === 'win32') {
        expect(samePath(lower, upper)).toBe(true);
      }
      // Hors Windows la casse est significative : la seule assertion portable
      // est qu'un chemin est égal à lui-même.
      expect(samePath(OWN_PATH, OWN_PATH)).toBe(true);
    });

    it('6. auto-exclusion : deux fichiers DISTINCTS du même dossier restent distincts', () => {
      const dir = path.dirname(OWN_PATH);
      const sibling = path.join(dir, 'some-other-guard.test.ts');
      expect(samePath(OWN_PATH, sibling)).toBe(false);
    });
  });
});
