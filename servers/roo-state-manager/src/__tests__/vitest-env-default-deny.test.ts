/**
 * #4131 item 3 (A) — the suite-level env default-deny, proven from a seat.
 *
 * @module src/__tests__/vitest-env-default-deny
 *
 * ms#1553 : `dashboard-key-listing` et `dashboard-merge` rouges sur un siège,
 * verts en CI. Cause racine : `src/index.ts:49` recharge le `.env` DU SIÈGE à
 * l'import de l'entrée (et `tests/setup-env.ts` le charge aussi pour les clés
 * manquantes) — un fichier de test qui importe l'entrée hérite donc de valeurs
 * que la CI ne voit jamais. Mesuré 28/10 : l'ancien sanitiseur de
 * jest.setup.js DELETait UNIFIED_STORE_PG_URL + DUAL_WRITE (#2957), et la
 * suppression invitait le refill — une clé absente n'est pas host-owned
 * (host-env-snapshot.ts), donc applyEnvFileForNonHostKeys la re-remplissait
 * avec la valeur RÉELLE du siège à l'import. Deux couches ferment la classe :
 * le bloc `env` des configs vitest (documentation + ??=) et l'épinglage `''`
 * inconditionnel de jest.setup.js (même liste) — dotenv n'écrase jamais une
 * clé existante et une clé présente est host-owned, donc aucun des vecteurs
 * (setup-env, index.ts:49, applyEnvFileForNonHostKeys) ne peut re-remplir.
 *
 * Ce fichier est le fil trip : il importe l'entrée (déclenchant les appels
 * dotenv de :49) puis vérifie que les clés épinglées tiennent. Les assertions
 * ne comparent que des BOOLEENS — une clé fuillée porte une chaîne de
 * connexion avec son mot de passe, et un diff d'assertion l'imprimerait.
 */

import { describe, test, expect } from 'vitest';
import { PG_URL_ENV } from '../services/unified-store/pg-flags.js';

/** Les clés épinglées par le bloc `env` des configs vitest — même liste, un seul endroit de vérité : les configs. */
const PINNED_EMPTY = [
  PG_URL_ENV,
  'UNIFIED_STORE_DUAL_WRITE',
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'UNIFIED_STORE_DASHBOARD_READ_PG',
  'UNIFIED_STORE_DASHBOARD_PG_PRIMARY',
  'EMBEDDING_OPS_PER_MINUTE',
] as const;

describe('#4131 (A) — default-deny : le `.env` du siège n\'atteint plus un fichier de test', () => {
  test("l'import de l'entrée serveur ne peut pas faire fuiter le `.env` du siège", async () => {
    // L'import EST l'attaque : src/index.ts:49 exécute dotenv.config() puis
    // applyEnvFileForNonHostKeys sur le `.env` du siège à cet instant. Ce test
    // tourne sur un siège qui EN A un (la CI n'en a pas — il y pinne alors
    // trivialement le contrat).
    await import('../index.js');

    // Booleans only — NEVER the values themselves: a leaked UNIFIED_STORE_PG_URL
    // is a live connection string with its password, and an assertion diff would
    // print it straight into the test output.
    const stillPinned = Object.fromEntries(
      PINNED_EMPTY.map((key) => [key, (process.env[key] ?? '') === ''])
    );
    const expected = Object.fromEntries(PINNED_EMPTY.map((key) => [key, true]));
    expect(stillPinned).toEqual(expected);
  });

  test('les read-gates PG résolvent OFF dans l’environnement de test (aucun héritage de siège)', async () => {
    const gates = await import('../services/unified-store/pg-read-gates.js');

    expect(gates.isDashboardPgPrimaryEnabled()).toBe(false);
    expect(gates.isDashboardReadPgEnabled()).toBe(false);
    expect(gates.isChannelReadPgEnabled()).toBe(false);
  });
});
