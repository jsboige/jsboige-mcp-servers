/**
 * #3459 — Test structurel anti-contournement (arbitrage ai-01, option b).
 *
 * Le helper `ensureStoreSubdir` (utils/shared-state-path.ts) ne devient la
 * propriété du système que s'il est LE SEUL chemin possible. Rien n'empêche
 * un `mkdirSync(join(sharedPath, ...))` écrit demain à côté du helper — par
 * un agent qui ne le connaît pas. Ce test rend ce contournement VISIBLE :
 * il échoue dès qu'un mkdir primitif prend un chemin dérivé de la racine du
 * store en dehors du helper.
 *
 * « Un grep structurel sur les sources suffit, il n'a pas besoin d'être
 * élégant. C'est ce test, pas le helper, qui porte la propriété dans le
 * temps. » — arbitrage #3459.
 *
 * Contre-épreuves (méthodologie #1088/#1081) :
 * - un `mkdirSync(join(sharedPath,'rogue'))` ajouté dans n'importe quel
 *   service non exclu → ce test ROUGIT (vérifié par mutation avant push) ;
 * - la neutralisation du helper n'affecte pas ce test (il scanne les
 *   sources, pas le comportement — c'est le rôle des tests bilatéraux de
 *   fail-closed-store.test.ts de rougir alors).
 *
 * Fichiers exclus :
 * - utils/shared-state-path.ts : le helper lui-même (son mkdirSync EST le
 *   chemin sanctionné) ;
 * - tools/roosync/roosync_init.ts : l'initialiseur — créer la racine du
 *   store est sa fonction déclarée (`roosync_init` sur store absent).
 *
 * @module tests/roosync/fail-closed-store-structural
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const SRC_ROOT = join(__dirname, '..', '..', '..');

const EXCLUDED = new Set([
  join('utils', 'shared-state-path.ts'),
  join('tools', 'roosync', 'roosync_init.ts'),
]);

/** Primitifs mkdir — le point de départ de l'audit « par le primitif ». */
const MKDIR_RE = /(?:mkdirSync|\bmkdir)\s*\(/;

/**
 * Jetons dont la présence près d'un mkdir trahit une dérivation depuis la
 * racine du store (accès directs ET variables dérivées : accessors
 * dashboards/archive, attachments, messages).
 */
const SHARED_TOKEN_RE =
  /sharedPath|sharedStatePath|getSharedStatePath|tryGetSharedStatePath|getDashboardsDir|getArchiveDir|attachmentsPath|messagesPath/;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'build') continue;
      out.push(...listSourceFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('structural: no raw mkdir on a store-root-derived path outside ensureStoreSubdir (#3459 b)', () => {
  it('every mkdir taking a shared-store-derived path routes through the helper', () => {
    const violations: { file: string; line: number; text: string }[] = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (EXCLUDED.has(rel)) continue;

      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
        if (!MKDIR_RE.test(line)) continue;

        // Fenêtre = la ligne de l'appel + les 4 lignes précédentes (y vit la
        // dérivation `const d = join(sharedPath, ...)` la plus courante).
        const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
        if (SHARED_TOKEN_RE.test(window)) {
          violations.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }

    expect(
      violations,
      'mkdir primitif sur un chemin dérivé de la racine du store HORS ensureStoreSubdir ' +
      '(migrer vers ensureStoreSubdir(...) — cf. #3459 arbitrage b, utils/shared-state-path.ts)'
    ).toEqual([]);
  });
});
