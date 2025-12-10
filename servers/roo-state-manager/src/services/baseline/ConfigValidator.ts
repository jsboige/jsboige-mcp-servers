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
      return !!(
        baseline.machineId &&
        baseline.config &&
        baseline.version &&
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
      return !!(
        baselineFile.version &&
        baselineFile.baselineId &&
        baselineFile.machineId &&
        baselineFile.timestamp &&
        baselineFile.machines &&
        Array.isArray(baselineFile.machines) &&
        baselineFile.machines.length > 0
      );
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
    if (!this.validateBaselineFileConfig(baselineFile)) {
      throw new BaselineServiceError(
        'Configuration baseline invalide',
        BaselineServiceErrorCode.BASELINE_INVALID
      );
    }
    
    // Validation basique supplémentaire
    if (!baselineFile.machineId || !baselineFile.version || !baselineFile.timestamp) {
      throw new BaselineServiceError(
        'Configuration baseline file invalide: champs requis manquants',
        BaselineServiceErrorCode.BASELINE_INVALID
      );
    }
  }
}