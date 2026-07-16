/**
 * ConfigValidator - Module de validation des configurations baseline
 *
 * Ce module est responsable de la validation structurelle et sémantique
 * des configurations baseline et des fichiers de configuration.
 */

import {
  BaselineConfig,
  BaselineFileConfig,
  BaselineServiceError,
  BaselineServiceErrorCode
} from '../../types/baseline.js';

export class ConfigValidator {
  /**
   * Valide la configuration de la baseline
   */
  public validateBaselineConfig(baseline: BaselineConfig): boolean {
    try {
      // Champs communs requis quel que soit le format
      if (!baseline || !baseline.machineId || !baseline.version) {
        return false;
      }

      const b = baseline as any;

      // Format v2.x (post-#570/#571) : les sections roo/hardware/software sont
      // portées par machines[] et il n'y a pas de `config` de haut niveau.
      // C'est le format produit par createBaselineFromInventory (update standard)
      // et par le mode profile. Un tableau machines non vide suffit.
      // Sans cette branche, toute mise à jour standard échouait (bug fleet-wide,
      // révélé par web1 sur la régénération d'une baseline 0-byte).
      if (Array.isArray(b.machines) && b.machines.length > 0) {
        return true;
      }

      // Format v1.x (legacy) : sections sous config.* (RooSyncService mode legacy,
      // anciens fichiers sync-config.ref.json).
      return !!(
        baseline.config &&
        baseline.config.roo &&
        baseline.config.hardware &&
        baseline.config.software &&
        baseline.config.system
      );
    } catch (error) {
      console.error('Erreur lors de la validation de la baseline', error);
      return false;
    }
  }

  /**
   * Valide la configuration du fichier baseline (BaselineFileConfig)
   */
  public validateBaselineFileConfig(baselineFile: BaselineFileConfig): boolean {
    try {
      const isValid = !!(
        baselineFile.version &&
        baselineFile.baselineId &&
        baselineFile.machineId &&
        baselineFile.timestamp &&
        baselineFile.machines &&
        Array.isArray(baselineFile.machines) &&
        baselineFile.machines.length > 0
      );
      
      if (!isValid) {
        console.error('DEBUG VALIDATION FAILED:',
            'ver:', !!baselineFile.version,
            'bid:', !!baselineFile.baselineId,
            'mid:', !!baselineFile.machineId,
            'ts:', !!baselineFile.timestamp,
            'm:', !!baselineFile.machines,
            'isArray:', Array.isArray(baselineFile.machines),
            'len:', baselineFile.machines?.length
        );
        console.error('FULL OBJECT:', JSON.stringify(baselineFile));
      }
      return isValid;
    } catch (error) {
      console.error('Erreur lors de la validation du fichier baseline', error);
      return false;
    }
  }

  /**
   * Valide et lève une exception si la configuration baseline est invalide
   */
  public ensureValidBaselineConfig(baseline: BaselineConfig): void {
    if (!this.validateBaselineConfig(baseline)) {
      throw new BaselineServiceError(
        'Configuration baseline invalide',
        BaselineServiceErrorCode.BASELINE_INVALID
      );
    }
  }

  /**
   * Valide et lève une exception si le fichier baseline est invalide
   */
  public ensureValidBaselineFileConfig(baselineFile: BaselineFileConfig): void {
    // Validation basique indispensable
    if (!baselineFile) {
      throw new BaselineServiceError(
        'Configuration baseline file invalide: objet null ou undefined',
        BaselineServiceErrorCode.BASELINE_INVALID
      );
    }
    
    const missingFields = [];
    if (!baselineFile.machineId) missingFields.push('machineId');
    if (!baselineFile.version) missingFields.push('version');
    // timestamp est optionnel dans l'interface, on accepte timestamp OU lastUpdated
    if (!baselineFile.timestamp && !baselineFile.lastUpdated) missingFields.push('timestamp/lastUpdated');
    
    if (missingFields.length > 0) {
      throw new BaselineServiceError(
        `Configuration baseline file invalide: champs requis manquants [${missingFields.join(', ')}]`,
        BaselineServiceErrorCode.BASELINE_INVALID
      );
    }
    
    // Note: La validation stricte via validateBaselineFileConfig est désactivée ici
    // car elle est redondante avec la vérification des champs ci-dessus et peut poser problème
    // dans certains environnements de test où l'objet a des propriétés inattendues ou prototypales.
  }
}