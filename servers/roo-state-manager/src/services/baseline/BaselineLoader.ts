/**
 * BaselineLoader - Module de chargement des baselines
 *
 * Ce module gère la lecture, le parsing et la transformation
 * des fichiers de configuration baseline.
 */

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

export class BaselineLoader {
  constructor(private validator: ConfigValidator) {}

  /**
   * Charge la configuration baseline depuis un fichier
   */
  public async loadBaseline(baselinePath: string): Promise<BaselineConfig | null> {
    console.log('[DEBUG] BaselineLoader.loadBaseline() appelé');
    console.log('[DEBUG] baselinePath:', baselinePath);

    try {
      console.log('[DEBUG] Début try block dans loadBaseline');

      if (!existsSync(baselinePath)) {
        console.log('[DEBUG] Fichier baseline non trouvé:', baselinePath);
        return null;
      }

      console.log('[DEBUG] Fichier baseline trouvé, lecture en cours...');
      const content = await fs.readFile(baselinePath, 'utf-8');
      console.log('[DEBUG] Contenu lu, longueur:', content.length);
      console.log('[DEBUG] Début du contenu:', content.substring(0, 100));

      const baselineFile = JSON.parse(content) as BaselineFileConfig;
      console.log('[DEBUG] JSON parsé avec succès');

      // Validation du fichier baseline
      this.validator.ensureValidBaselineFileConfig(baselineFile);

      // Transformer le fichier baseline en BaselineConfig pour compatibilité
      const baseline = this.transformBaselineForDiffDetector(baselineFile);

      return baseline;
    } catch (error) {
      // DEBUG: Capturer l'erreur originale avec tous les détails
      const originalError = error as Error;
      console.error('[DEBUG] ERREUR DANS loadBaseline():');
      console.error('[DEBUG] Message:', originalError.message);
      console.error('[DEBUG] Stack:', originalError.stack);
      console.error('[DEBUG] Type:', typeof originalError);
      console.error('[DEBUG] Nom:', originalError.name);
      console.error('[DEBUG] Path:', baselinePath);

      if (error instanceof BaselineServiceError) {
        throw error;
      }

      if (error instanceof SyntaxError) {
        throw new BaselineServiceError(
          `Erreur parsing JSON baseline: ${originalError.message}`,
          BaselineServiceErrorCode.BASELINE_INVALID,
          error
        );
      }

      throw new BaselineServiceError(
        `Erreur chargement baseline: ${originalError.message}`,
        BaselineServiceErrorCode.BASELINE_NOT_FOUND,
        error
      );
    }
  }

  /**
   * Lit le fichier baseline de configuration (format BaselineFileConfig)
   */
  public async readBaselineFile(baselinePath: string): Promise<BaselineFileConfig | null> {
    try {
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

      if (!fileExists) {
        throw new BaselineServiceError(
          'Baseline file not found',
          BaselineServiceErrorCode.BASELINE_NOT_FOUND
        );
      }

      console.error('DEBUG: Fichier trouvé, lecture du contenu...');
      const content = await fs.readFile(baselinePath, 'utf-8');
      console.error('DEBUG: Contenu lu, longueur:', content.length);
      console.error('DEBUG: Début du contenu:', content.substring(0, 100));

      let baselineFile;
      try {
        baselineFile = JSON.parse(content) as BaselineFileConfig;
        console.error('DEBUG: JSON parsé avec succès');
      } catch (parseError) {
        console.error('DEBUG: ERREUR PARSING JSON:', parseError);
        console.error('DEBUG: Contenu brut qui cause l\'erreur:', content);
        throw new BaselineServiceError(
          `Erreur parsing JSON baseline: ${(parseError as Error).message}`,
          BaselineServiceErrorCode.BASELINE_INVALID,
          parseError
        );
      }

      // Validation basique de la baseline file
      this.validator.ensureValidBaselineFileConfig(baselineFile);

      return baselineFile;
    } catch (error) {
      if (error instanceof BaselineServiceError) {
        throw error;
      }

      throw new BaselineServiceError(
        `Erreur lecture fichier baseline: ${(error as Error).message}`,
        BaselineServiceErrorCode.BASELINE_NOT_FOUND,
        error
      );
    }
  }

  /**
   * Transforme la structure du fichier baseline pour le DiffDetector
   */
  public transformBaselineForDiffDetector(baselineFile: BaselineFileConfig): BaselineConfig {
    // Récupérer la première machine du fichier baseline
    const firstMachine = baselineFile.machines?.[0];

    return {
      machineId: baselineFile.machineId || 'unknown',
      config: {
        roo: {
          modes: firstMachine?.roo?.modes || [],
          mcpSettings: this.extractMcpSettings(firstMachine?.roo?.mcpServers || []),
          userSettings: {}
        },
        hardware: {
          cpu: {
            model: 'Unknown CPU',
            cores: firstMachine?.hardware?.cpu?.cores || 0,
            threads: firstMachine?.hardware?.cpu?.threads || 0
          },
          memory: {
            total: firstMachine?.hardware?.memory?.total || 0
          },
          disks: [],
          gpu: 'Unknown'
        },
        software: {
          powershell: 'Unknown',
          node: firstMachine?.software?.node || 'Unknown',
          python: firstMachine?.software?.python || 'Unknown'
        },
        system: {
          os: firstMachine?.os || 'Unknown',
          architecture: firstMachine?.architecture || 'Unknown'
        }
      },
      lastUpdated: baselineFile.timestamp || new Date().toISOString(),
      version: baselineFile.version || '2.1'
    };
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