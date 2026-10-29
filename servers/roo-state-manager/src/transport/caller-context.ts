/**
 * Contexte d'appelant par requête (AsyncLocalStorage) — #4149 F2.
 *
 * Le daemon HTTP sert plusieurs clients concurrents. Une identité portée par
 * une variable de module ("set at connection") fuit d'un client vers l'autre
 * dès que deux requêtes s'entrelacent : le transport HTTP installe donc
 * l'identité DANS un AsyncLocalStorage, autour de chaque handler de requête,
 * et les helpers d'identité (`getLocalMachineId` / `getLocalWorkspaceId`)
 * le lisent en premier.
 *
 * Aucun secret ici : uniquement des identifiants (machine / workspace).
 *
 * @module transport/caller-context
 * @version 1.0.0 - #4149 F2 phase 0 (transport HTTP + identité par requête)
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Transport qui sert la requête courante.
 * - `http` : daemon multi-clients (identité par requête, obligatoire pour une écriture) ;
 * - `stdio` : session locale (le comportement historique — résolution par le process).
 */
export type CallerTransport = 'http' | 'stdio';

/**
 * Identité de l'appelant, portée par la requête courante.
 *
 * `machineId` / `workspaceId` sont absents quand la requête n'a rien asserted
 * (pas d'en-tête `x-roosync-as`) : sur le transport HTTP, une ÉCRITURE dans
 * ce cas est refusée (amendement 3 d'ai-01) — la résolution locale (cwd/env du
 * daemon) ne vaut pour aucun client.
 */
export interface CallerContext {
  /** Machine assertée par l'appelant (`x-roosync-as`), canonique. */
  machineId?: string;
  /** Workspace asserté (partie après `:` de `machine:workspace`). */
  workspaceId?: string;
  /** Identité complète assertée ("machine" ou "machine:workspace"). */
  fullId?: string;
  /** Transport qui sert la requête courante. */
  transport: CallerTransport;
}

const storage = new AsyncLocalStorage<CallerContext>();

/**
 * Exécute `fn` dans le contexte d'appelant donné.
 *
 * Le contexte est hérité par toutes les continuations async lancées depuis
 * `fn` (awaits, timers, promesses) — c'est ce qui rend l'isolation correcte
 * quand deux requêtes de deux identités s'entrelacent.
 */
export function runWithCallerContext<T>(context: CallerContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Contexte d'appelant de la requête courante, ou `undefined` hors requête
 * (tâches de fond, bootstrap du process).
 */
export function getCallerContext(): CallerContext | undefined {
  return storage.getStore();
}

/**
 * Vrai quand la requête courante est servie par le transport HTTP (daemon).
 * Les écritures y exigent une identité assertée (amendement 3).
 */
export function isHttpCaller(): boolean {
  return storage.getStore()?.transport === 'http';
}
