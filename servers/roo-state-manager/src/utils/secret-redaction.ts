/**
 * Masquage des secrets au passage d'une frontière de PUBLICATION (#3584).
 *
 * Compose les deux couches :
 * - FORME (`redactSecrets`, importé de `services/task-indexer/EmbeddingValidator.ts`) :
 *   motifs auto-descriptifs — préfixes `sk-`/`ghp_`, `NAME=VALUE`, `Bearer …`, et depuis
 *   #3584 §5.1 les URI à credentials (`scheme://user:pass@host`), que la classe de
 *   valeur du motif `NAME=VALUE` ne pouvait pas attraper (`:`/`@` exclus).
 * - VALEUR CONNUE (`known-value-masker.ts`, extrait de ce fichier pour permettre à
 *   `sanitizePayload` de le consommer sans cycle d'import) : la fuite fondatrice
 *   #3584 était une clé d'API NUE, 64 caractères hexadécimaux, publiée sans nom de
 *   variable. Aucun motif de forme ne peut la distinguer d'un SHA git de 40 caractères
 *   ou d'un hash quelconque : un masquage par entropie casserait la citation des SHA,
 *   qui est le vocabulaire courant du canal de coordination. D'où la comparaison
 *   littérale aux valeurs détenues par `process.env`.
 *
 * Définition UNIQUE de la composition des deux couches — dashboard ET messages
 * RooSync publient vers le même genre de store partagé. Toute frontière de
 * publication (writeDashboardFile, MessageManager.sendMessage, amendMessage)
 * appelle `maskSecretTextForPublication`, jamais sa propre copie.
 */

import { redactSecrets } from '../services/task-indexer/EmbeddingValidator.js';
import { createKnownValueMasker, redactKnownSecretValues } from './known-value-masker.js';

// Ré-export : les appelants historiques importaient ces deux fonctions depuis ici.
export { createKnownValueMasker, redactKnownSecretValues };

/**
 * Pré-filtre de la couche forme : des regexes sur un texte entier par passe de
 * publication pesaient assez pour faire basculer des tests au chrono serré
 * (#2463, #2719). Un texte sans marqueur n'a rien à y gagner — sauf la couche
 * valeur connue, qui court TOUJOURS : une valeur nue n'a par définition aucun
 * marqueur, c'est le cas fondateur #3584. L'alternative URI-credentials active
 * la couche forme pour `scheme://user:pass@host` (mais pas pour une URL banale,
 * sans userinfo — zéro surcoût pour `https://github.com/…`).
 */
export const FORM_LAYER_MARKER = /sk-|gh[opsur]_|xox|Bearer|API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i;

/**
 * Masque un texte au franchissement d'une frontière de PUBLICATION (#3584).
 *
 * @param text Texte destiné publication (message intercom, status de dashboard,
 *             corps/sujet de DM).
 */
export function maskSecretTextForPublication(text: string): string {
    const afterForm = FORM_LAYER_MARKER.test(text) ? redactSecrets(text) : text;
    return redactKnownSecretValues(afterForm);
}
