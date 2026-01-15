/**
 * Outil MCP : roosync_export_baseline
 * 
 * Exporte une baseline vers différents formats (JSON, YAML, CSV)
 * 
 * @module tools/roosync/export-baseline
 * @version 2.1.0
 */

import { z } from 'zod';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createLogger, Logger } from '../../utils/logger.js';
import { BaselineService } from '../../services/BaselineService.js';
import { ConfigService } from '../../services/ConfigService.js';
import type { BaselineConfig, BaselineFileConfig } from '../../types/baseline.js';
import { StateManagerError } from '../../types/errors.js';

// Logger instance for export baseline tool
const logger: Logger = createLogger('ExportBaselineTool');

/**
 * Schema de validation pour roosync_export_baseline
 */
export const ExportBaselineArgsSchema = z.object({
  format: z.enum(['json', 'yaml', 'csv'])
    .describe('Format d\'exportation'),
  outputPath: z.string().optional()
    .describe('Chemin de sortie pour le fichier exporté (optionnel)'),
  machineId: z.string().optional()
    .describe('ID de la machine à exporter (optionnel, utilise la baseline actuelle si non spécifié)'),
  includeHistory: z.boolean().default(false)
    .describe('Inclure l\'historique des modifications'),
  includeMetadata: z.boolean().default(true)
    .describe('Inclure les métadonnées complètes'),
  prettyPrint: z.boolean().default(true)
    .describe('Formater la sortie pour une meilleure lisibilité')
});

export type ExportBaselineArgs = z.infer<typeof ExportBaselineArgsSchema>;

/**
 * Schema de retour pour roosync_export_baseline
 */
export const ExportBaselineResultSchema = z.object({
  success: z.boolean().describe('Succès de l\'export'),
  machineId: z.string().describe('ID de la machine exportée'),
  version: z.string().describe('Version de la baseline exportée'),
  format: z.string().describe('Format d\'export'),
  outputPath: z.string().describe('Chemin du fichier exporté'),
  size: z.number().describe('Taille du fichier en octets'),
  includeHistory: z.boolean().describe('Inclusion de l\'historique'),
  includeMetadata: z.boolean().describe('Inclusion des métadonnées'),
  message: z.string().describe('Message de résultat')
});

export type ExportBaselineResult = z.infer<typeof ExportBaselineResultSchema>;

/**
 * Fonction principale pour roosync_export_baseline
 */
export async function roosync_export_baseline(args: ExportBaselineArgs): Promise<ExportBaselineResult> {
  try {
    logger.info('Export baseline started', { args });

    // Validation des arguments
    const validatedArgs = ExportBaselineArgsSchema.parse(args);
    
    // Créer le service BaselineService avec ConfigService réel
    // Fix Bug #290: utiliser ConfigService au lieu d'un objet vide
    const configService = new ConfigService();
    const baselineService = new BaselineService(
      configService,
      {} as any, // inventoryCollector - non requis pour loadBaseline
      {} as any  // diffDetector - non requis pour loadBaseline
    );
    
    // Récupérer la baseline à exporter
    let baseline: BaselineConfig | null;
    if (validatedArgs.machineId) {
      baseline = await baselineService.loadBaseline();
    } else {
      // Utiliser la baseline actuelle
      baseline = await baselineService.loadBaseline();
    }

    if (!baseline) {
      throw new StateManagerError(
        `Baseline non trouvée pour machineId: ${validatedArgs.machineId || 'actuelle'}`,
        'BASELINE_NOT_FOUND',
        'ExportBaselineTool',
        { machineId: validatedArgs.machineId || 'actuelle' }
      );
    }

    // Préparer les données d'export
    const exportData = await prepareExportData(baseline, validatedArgs);

    // Générer le contenu selon le format
    let content: string;
    let extension: string;
    
    switch (validatedArgs.format) {
      case 'json':
        content = generateJsonExport(exportData, validatedArgs.prettyPrint);
        extension = '.json';
        break;
      case 'yaml':
        content = generateYamlExport(exportData);
        extension = '.yaml';
        break;
      case 'csv':
        content = generateCsvExport(exportData);
        extension = '.csv';
        break;
      default:
        throw new StateManagerError(
          `Format non supporté: ${validatedArgs.format}`,
          'UNSUPPORTED_FORMAT',
          'ExportBaselineTool',
          { format: validatedArgs.format, supportedFormats: ['json', 'yaml', 'csv'] }
        );
    }

    // Déterminer le chemin de sortie
    let outputPath = validatedArgs.outputPath;
    if (!outputPath) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `baseline-export-${baseline.machineId}-${timestamp}${extension}`;
      outputPath = join(process.cwd(), 'exports', filename);
    }

    // Créer le répertoire de sortie si nécessaire
    const outputDir = outputPath.substring(0, outputPath.lastIndexOf('/'));
    if (outputDir && !existsSync(outputDir)) {
      require('fs').mkdirSync(outputDir, { recursive: true });
    }

    // Écrire le fichier d'export
    writeFileSync(outputPath, content, 'utf-8');

    logger.info('Baseline exported successfully', {
      machineId: baseline.machineId,
      format: validatedArgs.format,
      outputPath,
      size: content.length
    });

    // Préparer le message de résultat
    let message = `Baseline exportée avec succès au format ${validatedArgs.format.toUpperCase()}`;
    message += `\nMachine: ${baseline.machineId}`;
    message += `\nVersion: ${baseline.version}`;
    message += `\nFichier: ${outputPath}`;
    message += `\nTaille: ${content.length} octets`;

    return {
      success: true,
      machineId: baseline.machineId,
      version: baseline.version,
      format: validatedArgs.format,
      outputPath,
      size: content.length,
      includeHistory: validatedArgs.includeHistory,
      includeMetadata: validatedArgs.includeMetadata,
      message
    };

  } catch (error) {
    logger.error('Export baseline failed', { error: (error as Error).message, args });
    if (error instanceof StateManagerError) {
      throw error;
    }
    throw new StateManagerError(
      `Erreur lors de l'export de la baseline: ${(error as Error).message}`,
      'EXPORT_FAILED',
      'ExportBaselineTool',
      { originalError: (error as Error).message, args }
    );
  }
}

/**
 * Prépare les données d'export
 */
async function prepareExportData(baseline: BaselineConfig, args: any): Promise<any> {
  const exportData: any = {
    exportInfo: {
      timestamp: new Date().toISOString(),
      format: args.format,
      exportedBy: 'roosync_export_baseline',
      version: '1.0.0'
    }
  };

  if (args.includeMetadata) {
    exportData.metadata = {
      machineId: baseline.machineId,
      version: baseline.version,
      lastUpdated: baseline.lastUpdated
    };
  }

  // Inclure les données de configuration
  exportData.configuration = baseline.config || {};

  // Inclure l'historique si demandé
  if (args.includeHistory) {
    exportData.history = []; // Pas d'historique dans BaselineConfig actuel
  }

  // Inclure les statistiques
  exportData.statistics = {
    totalParameters: countParameters(baseline.config),
    lastModified: baseline.lastUpdated,
    exportTimestamp: new Date().toISOString()
  };

  return exportData;
}

/**
 * Génère l'export JSON
 */
function generateJsonExport(data: any, prettyPrint: boolean): string {
  if (prettyPrint) {
    return JSON.stringify(data, null, 2);
  } else {
    return JSON.stringify(data);
  }
}

/**
 * Génère l'export YAML
 */
function generateYamlExport(data: any): string {
  try {
    // Utiliser yaml library si disponible, sinon fallback simple
    const yaml = require('js-yaml');
    return yaml.dump(data, { indent: 2 });
  } catch (error) {
    // Fallback simple si js-yaml n'est pas disponible
    return simpleYamlExport(data);
  }
}

/**
 * Export YAML simple (fallback)
 */
function simpleYamlExport(data: any, indent: number = 0): string {
  const spaces = '  '.repeat(indent);
  let yaml = '';

  if (Array.isArray(data)) {
    for (const item of data) {
      yaml += `${spaces}- ${simpleYamlExport(item, indent + 1)}\n`;
    }
  } else if (typeof data === 'object' && data !== null) {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        yaml += `${spaces}${key}:\n${simpleYamlExport(value, indent + 1)}`;
      } else if (Array.isArray(value)) {
        yaml += `${spaces}${key}:\n${simpleYamlExport(value, indent + 1)}`;
      } else {
        yaml += `${spaces}${key}: ${value}\n`;
      }
    }
  } else {
    yaml += `${data}\n`;
  }

  return yaml;
}

/**
 * Génère l'export CSV
 */
function generateCsvExport(data: any): string {
  const csvLines: string[] = [];
  
  // En-tête CSV
  csvLines.push('Type,Clé,Valeur,Description');

  // Fonction récursive pour aplatir les données
  const flattenData = (obj: any, prefix: string = ''): void => {
    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        flattenData(item, `${prefix}[${index}]`);
      });
    } else if (typeof obj === 'object' && obj !== null) {
      Object.entries(obj).forEach(([key, value]) => {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          flattenData(value, fullKey);
        } else {
          const csvValue = typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : value;
          csvLines.push(`Data,${fullKey},${csvValue},""`);
        }
      });
    }
  };

  // Aplatir les données principales
  if (data.metadata) {
    Object.entries(data.metadata).forEach(([key, value]) => {
      const csvValue = typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : value;
      csvLines.push(`Metadata,${key},${csvValue},""`);
    });
  }

  if (data.configuration) {
    flattenData(data.configuration, 'configuration');
  }

  if (data.statistics) {
    Object.entries(data.statistics).forEach(([key, value]) => {
      const csvValue = typeof value === 'string' ? `"${value.replace(/"/g, '""')}"` : value;
      csvLines.push(`Statistics,${key},${csvValue},""`);
    });
  }

  return csvLines.join('\n');
}

/**
 * Compte le nombre de paramètres dans une configuration
 */
function countParameters(config: any): number {
  let count = 0;
  
  const countRecursive = (obj: any): void => {
    if (Array.isArray(obj)) {
      obj.forEach(countRecursive);
    } else if (typeof obj === 'object' && obj !== null) {
      Object.values(obj).forEach(countRecursive);
    } else {
      count++;
    }
  };
  
  countRecursive(config);
  return count;
}