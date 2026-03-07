/**
 * BaselineLoader - Module de chargement des baselines
 *
 * Ce module gère la lecture, le parsing et la transformation
 * des fichiers de configuration baseline.
 */
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('baseline-loader');

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { resolve } from 'path';
import {
  BaselineConfig,
  BaselineFileConfig,
  BaselineServiceError,
  BaselineServiceErrorCode
} from '../../types/baseline.js';
import { ConfigValidator } from './ConfigValidator.js';
import { readJSONFileWithoutBOM } from '../../utils/encoding-helpers.js';
import {
  BaselineLoaderError,
  BaselineLoaderErrorCode
} from '../../types/errors.js';

export class BaselineLoader {
  constructor(private validator: ConfigValidator) {}

  /**
   * Charge la configuration baseline depuis un fichier
   * @throws {BaselineLoaderError} Si le chargement échoue
   */
  public async loadBaseline(baselinePath: string): Promise<BaselineConfig | null> {
    logger.debug('BaselineLoader.loadBaseline() appelé');
    logger.debug('baselinePath', { baselinePath });

    try {
      logger.debug('Début try block dans loadBaseline');

      if (!existsSync(baselinePath)) {
        logger.warn('Fichier baseline non trouvé', { baselinePath });
        return null;
      }

      logger.debug('Fichier baseline trouvé, lecture en cours');
      const baselineFile = await readJSONFileWithoutBOM<BaselineFileConfig>(baselinePath);
      logger.debug('JSON parsé avec succès');

      // Validation du fichier baseline
      this.validator.ensureValidBaselineFileConfig(baselineFile);

      // Transformer le fichier baseline en BaselineConfig pour compatibilité
      const baseline = this.transformBaselineForDiffDetector(baselineFile);

      return baseline;
    } catch (error) {
      // DEBUG: Capturer l'erreur originale avec tous les détails
      const originalError = error as Error;
      logger.error('ERREUR DANS loadBaseline()', error, {
        message: originalError.message,
        stack: originalError.stack,
        type: typeof originalError,
        name: originalError.name,
        path: baselinePath
      });

      if (error instanceof BaselineLoaderError || error instanceof BaselineServiceError) {
        throw error;
      }

      if (error instanceof SyntaxError) {
        throw new BaselineLoaderError(
          `Erreur parsing JSON baseline: ${originalError.message}`,
          BaselineLoaderErrorCode.BASELINE_PARSE_FAILED,
          { baselinePath },
          originalError
        );
      }

      throw new BaselineLoaderError(
        `Erreur chargement baseline: ${originalError.message}`,
        BaselineLoaderErrorCode.BASELINE_LOAD_FAILED,
        { baselinePath },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Lit le fichier baseline de configuration (format BaselineFileConfig)
   * @throws {BaselineLoaderError} Si la lecture échoue
   */
  public async readBaselineFile(baselinePath: string): Promise<BaselineFileConfig | null> {
    const debugInfo = {
      path: baselinePath,
      pathType: typeof baselinePath,
      pathLength: baselinePath?.length || 0,
      workingDirectory: process.cwd(),
      fileExists: false,
      resolvedPath: ''
    };

    const fileExists = existsSync(baselinePath);
    debugInfo.fileExists = fileExists;
    debugInfo.resolvedPath = resolve(baselinePath);

    try {
      if (!fileExists) {
        throw new BaselineLoaderError(
          'Baseline file not found',
          BaselineLoaderErrorCode.BASELINE_NOT_FOUND,
          { baselinePath, resolvedPath: resolve(baselinePath) }
        );
      }

      logger.debug('Fichier trouvé, lecture du contenu');

      let baselineFile;
      try {
        baselineFile = await readJSONFileWithoutBOM<BaselineFileConfig>(baselinePath);
        logger.debug('JSON parsé avec succès');
      } catch (parseError) {
        console.error('DEBUG: ERREUR PARSING JSON:', parseError);
        throw new BaselineLoaderError(
          `Erreur parsing JSON baseline: ${(parseError as Error).message}`,
          BaselineLoaderErrorCode.BASELINE_PARSE_FAILED,
          { baselinePath },
          parseError as Error
        );
      }

      // Validation basique de la baseline file
      this.validator.ensureValidBaselineFileConfig(baselineFile);

      return baselineFile;
    } catch (error) {
      if (error instanceof BaselineLoaderError || error instanceof BaselineServiceError) {
        throw error;
      }

      throw new BaselineLoaderError(
        `Erreur lecture fichier baseline: ${(error as Error).message}`,
        BaselineLoaderErrorCode.BASELINE_READ_FAILED,
        { baselinePath, debugInfo },
        error as Error
      );
    }
  }

  /**
   * Transforme la structure du fichier baseline pour le DiffDetector
   * Supporte deux formats:
   * - Format agrégé v2.x: { machines: [{ roo, hardware, software, ... }] }
   * - Format par machine: { machineId, config: { roo }, hardware, software, system }
   * @throws {BaselineLoaderError} Si la transformation échoue
   */
  public transformBaselineForDiffDetector(baselineFile: BaselineFileConfig): BaselineConfig {
    try {
      // Détecter le format de la baseline
      const anyFile = baselineFile as any;
      const isPerMachineFormat = !baselineFile.machines?.length && anyFile.config?.roo;

      // Sources de données selon le format
      let rooSource: any;
      let hardwareSource: any;
      let softwareSource: any;
      let systemSource: any;

      if (isPerMachineFormat) {
        // Format par machine: données à la racine
        rooSource = anyFile.config.roo || {};
        hardwareSource = anyFile.hardware || {};
        softwareSource = anyFile.software || {};
        systemSource = anyFile.system || {};
      } else {
        // Format agrégé v2.x: données dans machines[0]
        const firstMachine = baselineFile.machines?.[0];
        if (!firstMachine) {
          throw new BaselineLoaderError(
            'Aucune machine trouvée dans le fichier baseline (format agrégé)',
            BaselineLoaderErrorCode.BASELINE_INVALID,
            { baselineId: baselineFile.baselineId, machineCount: baselineFile.machines?.length || 0 }
          );
        }
        rooSource = firstMachine.roo || {};
        hardwareSource = firstMachine.hardware || {};
        softwareSource = firstMachine.software || {};
        systemSource = { os: firstMachine.os, architecture: firstMachine.architecture };
      }

      return {
        machineId: baselineFile.machineId || anyFile.machineId || 'unknown',
        config: {
          roo: {
            modes: rooSource.modes || [],
            mcpSettings: this.extractMcpSettings(rooSource.mcpServers || []),
            userSettings: {}
          },
          hardware: {
            cpu: {
              model: 'Unknown CPU',
              cores: hardwareSource?.cpu?.cores || 0,
              threads: hardwareSource?.cpu?.threads || 0
            },
            memory: {
              total: hardwareSource?.memory?.total || 0
            },
            disks: [],
            gpu: 'Unknown'
          },
          software: {
            powershell: softwareSource?.powershell || 'Unknown',
            node: softwareSource?.node || 'Unknown',
            python: softwareSource?.python || 'Unknown'
          },
          system: {
            os: systemSource?.os || 'Unknown',
            architecture: systemSource?.architecture || 'Unknown'
          }
        },
        lastUpdated: baselineFile.timestamp || anyFile.lastUpdated || new Date().toISOString(),
        version: baselineFile.version || '2.1'
      };
    } catch (error) {
      if (error instanceof BaselineLoaderError) {
        throw error;
      }

      throw new BaselineLoaderError(
        `Erreur lors de la transformation de la baseline: ${error instanceof Error ? error.message : String(error)}`,
        BaselineLoaderErrorCode.BASELINE_TRANSFORM_FAILED,
        { baselineId: (baselineFile as any).baselineId },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Extrait les paramètres MCP depuis la liste des serveurs MCP
   */
  private extractMcpSettings(mcpServers: any[]): Record<string, any> {
    const settings: Record<string, any> = {};

    mcpServers.forEach(server => {
      if (server.name && server.enabled) {
        settings[server.name] = {
          enabled: server.enabled,
          command: server.command,
          autoStart: server.autoStart,
          transportType: server.transportType,
          alwaysAllow: server.alwaysAllow || [],
          description: server.description
        };
      }
    });

    return settings;
  }
}
