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
 * le bloc `env` des configs vitest (assignation pure, avant tout import) et
 * l'épinglage `''` inconditionnel de jest.setup.js — dotenv n'écrase jamais une
 * clé existante et une clé présente est host-owned, donc aucun des vecteurs
 * (setup-env, index.ts:49, applyEnvFileForNonHostKeys) ne peut re-remplir. Les
 * deux couches lisent la MÊME liste, `tests/setup/test-env-pins.js`.
 *
 * Ce fichier est le fil trip : il importe l'entrée (déclenchant les appels
 * dotenv de :49) puis vérifie que les clés épinglées tiennent, que les quatre
 * gates résolvent OFF, et que la liste couvre encore TOUTES les gates du
 * module (une gate future non épinglée rougit ici). Les assertions ne
 * comparent que des BOOLEENS et des NOMS de clés — une valeur fuitée porte une
 * chaîne de connexion avec son mot de passe, et un diff d'assertion
 * l'imprimerait.
 */

import { describe, test, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PG_URL_ENV } from '../services/unified-store/pg-flags.js';
import { PINNED_TEST_ENV_KEYS } from '../../tests/setup/test-env-pins.js';

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
    //
    // Review ms#1559 (ai-01, 28/10) : `?? ''` laissait passer une clé ABSENTE —
    // c'est-à-dire l'ancien défaut #2957 (`delete`), celui qu'applyEnvFileForNonHostKeys
    // re-remplit avec la valeur RÉELLE du siège. Le pin doit être PRÉSENTE et VIDE :
    // une clé absente rougit le fil trip même en forme CI, sans `.env` pour la remplir.
    const stillPinned = Object.fromEntries(
      PINNED_TEST_ENV_KEYS.map((key) => [key, key in process.env && process.env[key] === ''])
    );
    const expected = Object.fromEntries(PINNED_TEST_ENV_KEYS.map((key) => [key, true]));
    expect(stillPinned).toEqual(expected);
  });

  test('les read-gates PG résolvent OFF dans l’environnement de test (aucun héritage de siège)', async () => {
    const gates = await import('../services/unified-store/pg-read-gates.js');

    expect(gates.isDashboardPgPrimaryEnabled()).toBe(false);
    expect(gates.isDashboardReadPgEnabled()).toBe(false);
    expect(gates.isChannelReadPgEnabled()).toBe(false);
    // Revue ms#1558, point 2 : les deux gates qui manquaient au trip.
    expect(gates.isChannelPgPrimaryEnabled()).toBe(false);
    // Un siège qui porte DUAL_WRITE=0 armerait le kill-switch dans les tests :
    // la clé épinglée est la chaîne vide, donc « explicitly off » doit rester faux.
    expect(gates.isDualWriteExplicitlyOff()).toBe(false);
  });
});

describe('#4131 (A) — garde de dérive : la liste épinglée couvre les gates', () => {
  test('chaque drapeau lu par pg-read-gates.ts est épinglé (une gate future rougit ici)', async () => {
    // Lecture du SOURCE, pas du module évalué : les drapeaux sont des littéraux
    // à l'intérieur des fonctions, aucun export ne les énumère. jest.setup.js
    // mocke `fs` — on prend l'implémentation réelle pour cet import.
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const gatesPath = fileURLToPath(
      new URL('../services/unified-store/pg-read-gates.ts', import.meta.url)
    );
    const source = realFs.readFileSync(gatesPath, 'utf8');

    // La prose ne lit aucun drapeau : sans ce retrait, un nom cité dans un
    // commentaire (« NOT GATED HERE — …CONVERSATION_READ_PG ») serait exigé
    // épinglé et la garde mordrait un commentaire au lieu du code. Les trois
    // formes y passent : blocs /* */, `//` en début de ligne, et `//` en fin de
    // ligne (🟡2 de la revue) — la classe `[^:]` épargne les `://` de protocole.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/([^:])\/\/.*$/gm, '$1');
    const gateFlags = [...new Set(code.match(/UNIFIED_STORE_[A-Z0-9_]+/g) ?? [])].sort();

    // Contrôle de l'instrument AVANT le verdict : un parseur cassé rendrait un
    // ensemble vide, et « tout est épinglé » serait vrai par vacuité.
    expect(gateFlags.length).toBeGreaterThanOrEqual(5);
    expect(gateFlags).toEqual(
      expect.arrayContaining([
        'UNIFIED_STORE_DUAL_WRITE',
        'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
        'UNIFIED_STORE_DASHBOARD_PG_PRIMARY',
      ])
    );

    const unpinned = gateFlags.filter((flag) => !PINNED_TEST_ENV_KEYS.includes(flag));
    // Noms de drapeaux seulement — jamais de valeur.
    expect(unpinned).toEqual([]);
  });

  test('la clé racine est épinglée — sans elle, tous les défauts ON se réarment', () => {
    // hasPgUrl() est la racine de tous les défauts « ON » de pg-flags.ts : une
    // URL de siège qui passerait rendrait chaque gate par défaut active.
    expect(PINNED_TEST_ENV_KEYS).toContain(PG_URL_ENV);
  });
});
