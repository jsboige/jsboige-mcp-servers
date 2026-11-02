/**
 * #4434 — vitest laisse un fichier d'état du disjoncteur de condensation par
 * pid de worker dans `%TEMP%`, et rien ne les supprimait : 1 441 restes sur
 * ai-01, 639 sur po-2028 (mesuré le 02/11).
 *
 * Ces tests épinglent les deux moitiés du correctif :
 *   - le balayage, pour les workers tués avant leur hook de sortie ;
 *   - le nettoyage par l'écrivain lui-même, qui ne doit rien laisser derrière.
 *
 * Le fichier du disjoncteur RÉEL (`rsm-condense-cb-<sha12>.json`, partagé par
 * tous les process de l'hôte) n'est jamais candidat, même vieux de 45 min :
 * c'est le point que le premier test protège explicitement.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepCondenseCbTestFiles, __condenseBreakerHooks } from '../dashboard.js';

/** `process.kill(999999, 0)` lève sur Windows comme sur POSIX : pid mort par construction. */
const DEAD_PID = 999999;
const KEY = '0123456789ab';
const STALE_MS = 45 * 60_000;

let dir: string;

function writeFile(file: string, ageMs: number): string {
  const full = path.join(dir, file);
  fs.writeFileSync(full, '{}');
  if (ageMs > 0) {
    const stamp = new Date(Date.now() - ageMs);
    fs.utimesSync(full, stamp, stamp);
  }
  return full;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsm-cb-sweep-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sweepCondenseCbTestFiles (#4434)', () => {
  it('supprime les restes des workers morts et garde tout le reste', () => {
    const staleDead = writeFile(`rsm-condense-cb-test-${DEAD_PID}-${KEY}.json`, STALE_MS);
    const staleDeadTmp = writeFile(`rsm-condense-cb-test-${DEAD_PID}-${KEY}.json.tmp-${DEAD_PID}`, STALE_MS);
    const freshDead = writeFile(`rsm-condense-cb-test-${DEAD_PID}-aaaabbbbcccc.json`, 0);
    const staleAlive = writeFile(`rsm-condense-cb-test-${process.pid}-dddddddddddd.json`, STALE_MS);
    const realBreaker = writeFile('rsm-condense-cb-eeeeeeeeeeee.json', STALE_MS);

    const { swept } = sweepCondenseCbTestFiles({ minAgeMs: 15 * 60_000, dir });

    expect(swept.sort()).toEqual([path.basename(staleDead), path.basename(staleDeadTmp)].sort());
    expect(fs.existsSync(staleDead)).toBe(false);
    expect(fs.existsSync(staleDeadTmp)).toBe(false);
    // Trop récent : un test peut être en train d'écrire ce fichier.
    expect(fs.existsSync(freshDead)).toBe(true);
    // Pid vivant : son worker n'a pas fini.
    expect(fs.existsSync(staleAlive)).toBe(true);
    // Le disjoncteur réel n'est jamais touché, quel que soit son âge.
    expect(fs.existsSync(realBreaker)).toBe(true);
  });

  it('ne lève pas quand le répertoire est illisible', () => {
    const out = sweepCondenseCbTestFiles({ dir: path.join(dir, 'nope') });
    expect(out).toEqual({ swept: [], skipped: [] });
  });

  it("ne laisse aucun fichier après le nettoyage de l'écrivain", () => {
    const saved = process.env.CONDENSE_CB_STATE_FILE;
    // Vide = repli sur le chemin par-pid sous vitest (la variable est prioritaire sinon).
    process.env.CONDENSE_CB_STATE_FILE = '';
    try {
      const file = __condenseBreakerHooks.stateFile();
      expect(path.basename(file)).toMatch(/^rsm-condense-cb-test-\d+-[0-9a-f]{12}\.json$/);

      __condenseBreakerHooks.recordFailure();
      expect(fs.existsSync(file)).toBe(true); // le breaker a bien écrit

      const removed = __condenseBreakerHooks.cleanupOwnFiles();
      expect(removed).toContain(file);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.existsSync(`${file}.tmp-${process.pid}`)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CONDENSE_CB_STATE_FILE;
      else process.env.CONDENSE_CB_STATE_FILE = saved;
      __condenseBreakerHooks.cleanupOwnFiles();
    }
  });
});
