/**
 * Extraction canonique de la valeur réelle d'une machine pour une catégorie de
 * configuration (#4106).
 *
 * Source unique partagée par :
 * - `ConfigComparator` (comparaison d'un inventaire machine vs des profils),
 * - `NonNominativeBaselineService` (détection de déviation contre une baseline
 *   non-nominative stockée).
 *
 * Les deux dupliquaient ce `switch` ; seul `NonNominativeBaselineService` en
 * couvrait la majorité, et `ConfigComparator` n'implémentait que 2 des 11
 * catégories — toute autre catégorie rendait `undefined` et la comparaison
 * passait en silence.
 *
 * Contrat :
 * - catégorie connue → sa valeur, ou `undefined` quand l'inventaire ne porte
 *   aucune donnée pour elle (une valeur absente n'est pas un résultat de
 *   comparaison, l'appelant décide de sauter) ;
 * - toute autre entrée → **jette**. Une catégorie hors `ConfigurationCategory`
 *   est un défaut d'appelant/donnée, pas une valeur absente : rendre
 *   `undefined`/`null` en silence est précisément ce qui a masqué le trou.
 *
 * Supporte les deux structures d'inventaire : legacy (`config.*`) et actuelle
 * (`inventory.*`).
 *
 * @module services/roosync/ConfigurationValueExtractor
 * @issue #4106
 */

import { ALL_CATEGORIES } from './ProfileApplicabilityHelper.js';

export class ConfigurationValueExtractor {
  /**
   * Extrait la valeur réelle de `inventory` pour `category`.
   *
   * @param inventory Inventaire machine (structure legacy `config.*` ou actuelle
   *                  `inventory.*`). Typé `any` volontairement : les appelants
   *                  le construisent depuis des JSON non validés (profils,
   *                  baselines stockées, réponses d'outil).
   * @param category  Catégorie de configuration (`ConfigurationCategory`).
   * @throws si `category` n'appartient pas à `ConfigurationCategory`.
   */
  static extract(inventory: any, category: string): any {
    switch (category) {
      case 'roo-core':
        return {
          modes: inventory?.config?.roo?.modes || inventory?.inventory?.rooModes,
          mcpSettings: inventory?.config?.roo?.mcpSettings
        };

      case 'roo-advanced':
        return {
          userSettings: inventory?.config?.roo?.userSettings
        };

      case 'hardware-cpu':
        return inventory?.config?.hardware?.cpu || inventory?.inventory?.systemInfo;

      case 'hardware-memory':
        return inventory?.config?.hardware?.memory || inventory?.inventory?.systemInfo;

      case 'hardware-storage':
        return inventory?.config?.hardware?.disks || inventory?.inventory?.systemInfo?.disks;

      case 'hardware-gpu':
        return inventory?.config?.hardware?.gpu || inventory?.inventory?.systemInfo?.gpu;

      case 'software-powershell':
        return {
          version: inventory?.config?.software?.powershell
            || inventory?.inventory?.systemInfo?.powershellVersion
            || inventory?.inventory?.tools?.powershell?.version
            || 'Unknown'
        };

      case 'software-node':
        return {
          version: inventory?.config?.software?.node
            || inventory?.inventory?.tools?.node?.version
            || 'Unknown'
        };

      case 'software-python':
        return {
          version: inventory?.config?.software?.python
            || inventory?.inventory?.tools?.python?.version
            || 'Unknown'
        };

      case 'system-os':
        return {
          os: inventory?.config?.system?.os
            || inventory?.inventory?.systemInfo?.os
            || 'Unknown'
        };

      case 'system-architecture':
        return {
          arch: inventory?.config?.system?.architecture
            || inventory?.inventory?.systemInfo?.architecture
            || 'Unknown'
        };

      default:
        throw new Error(
          `Unknown configuration category '${String(category)}'. `
          + `Known categories: ${ALL_CATEGORIES.join(', ')}.`
        );
    }
  }
}
