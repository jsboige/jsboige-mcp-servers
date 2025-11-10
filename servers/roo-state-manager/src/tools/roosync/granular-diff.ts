import { z } from 'zod';
import { 
  CallToolResult 
} from '@modelcontextprotocol/sdk/types.js';
import { 
  GranularDiffDetector, 
  GranularDiffOptions, 
  GranularDiffReport 
} from '../../services/GranularDiffDetector.js';
import { 
  MachineInventory 
} from '../../types/baseline.js';
import { 
  ConfigService 
} from '../../services/ConfigService.js';
import { 
  createLogger, 
  Logger 
} from '../../utils/logger.js';

// Logger instance for granular diff tool
const logger: Logger = createLogger('GranularDiffTool');

/**
 * Schema de validation pour roosync_granular_diff
 */
// Type pour les arguments de roosync_granular_diff
export type GranularDiffArgs = z.infer<typeof GranularDiffArgsSchema>;

export const GranularDiffArgsSchema = z.object({
  source: z.any()
    .describe('Configuration ou inventaire source (objet JSON ou chemin de fichier)'),
  target: z.any()
    .describe('Configuration ou inventaire cible (objet JSON ou chemin de fichier)'),
  sourceLabel: z.string().optional()
    .describe('Libellé pour la source (optionnel)'),
  targetLabel: z.string().optional()
    .describe('Libellé pour la cible (optionnel)'),
  options: z.object({
    includeUnchanged: z.boolean().optional().default(false),
    ignoreWhitespace: z.boolean().optional().default(true),
    ignoreCase: z.boolean().optional().default(false),
    arrayDiffMode: z.enum(['position', 'identity']).optional().default('identity'),
    semanticAnalysis: z.boolean().optional().default(false),
    maxDepth: z.number().optional().default(50)
  }).optional(),
  outputPath: z.string().optional()
    .describe('Chemin de sortie pour le rapport (optionnel)'),
  format: z.enum(['json', 'csv', 'html']).optional().default('json'),
  dryRun: z.boolean().optional().default(false)
});

/**
 * Outil MCP pour le diff granulaire
 */
export const roosync_granular_diff = {
  name: 'roosync_granular_diff',
  description: 'Effectue une comparaison granulaire entre deux configurations ou inventaires',
  inputSchema: GranularDiffArgsSchema
};

/**
 * Gestionnaire pour l'outil roosync_granular_diff
 */
export async function handleRoosyncGranularDiff(
  args: any
): Promise<CallToolResult> {
  const configService = new ConfigService();
  
  try {
    logger.info('Début du diff granulaire', { 
      sourceLabel: args.sourceLabel || 'source',
      targetLabel: args.targetLabel || 'target'
    });

    // Valider les arguments
    if (!args.source || !args.target) {
      throw new Error('Les paramètres source et target sont requis');
    }

    // Charger les données source et cible
    let sourceData = args.source;
    let targetData = args.target;

    // Si source/target sont des chaînes, essayer de les charger comme des fichiers
    if (typeof args.source === 'string') {
      try {
        const fs = await import('fs/promises');
        const sourceContent = await fs.readFile(args.source, 'utf-8');
        sourceData = JSON.parse(sourceContent);
        logger.info(`Source chargé depuis le fichier: ${args.source}`);
      } catch (error) {
        // Si ce n'est pas un fichier valide, considérer comme JSON direct
        try {
          sourceData = JSON.parse(args.source);
        } catch (parseError) {
          throw new Error(`Le source n'est ni un fichier JSON valide ni une chaîne JSON: ${(parseError as Error).message}`);
        }
      }
    }

    if (typeof args.target === 'string') {
      try {
        const fs = await import('fs/promises');
        const targetContent = await fs.readFile(args.target, 'utf-8');
        targetData = JSON.parse(targetContent);
        logger.info(`Cible chargé depuis le fichier: ${args.target}`);
      } catch (error) {
        // Si ce n'est pas un fichier valide, considérer comme JSON direct
        try {
          targetData = JSON.parse(args.target);
        } catch (parseError) {
          throw new Error(`La cible n'est ni un fichier JSON valide ni une chaîne JSON: ${(parseError as Error).message}`);
        }
      }
    }

    // Préparer les options
    const options: GranularDiffOptions = {
      includeUnchanged: args.options?.includeUnchanged || false,
      ignoreWhitespace: args.options?.ignoreWhitespace !== false,
      ignoreCase: args.options?.ignoreCase || false,
      arrayDiffMode: args.options?.arrayDiffMode || 'identity',
      semanticAnalysis: args.options?.semanticAnalysis || false,
      maxDepth: args.options?.maxDepth || 50
    };

    // Effectuer la comparaison granulaire
    const detector = new GranularDiffDetector();
    const report: GranularDiffReport = await detector.compareGranular(
      sourceData,
      targetData,
      args.sourceLabel || 'source',
      args.targetLabel || 'target',
      options
    );

    logger.info('Comparaison granulaire terminée', {
      totalDifferences: report.summary.total,
      executionTime: report.performance.executionTime,
      nodesCompared: report.performance.nodesCompared
    });

    // Exporter le rapport si demandé
    let outputPath = args.outputPath;
    let exportContent = '';

    if (args.format && args.format !== 'json') {
      exportContent = await detector.exportDiff(report, args.format);
    } else {
      exportContent = JSON.stringify(report, null, 2);
    }

    // Écrire le fichier si demandé et pas en mode dry-run
    if (outputPath && !args.dryRun) {
      const fs = await import('fs/promises');
      const path = await import('path');
      
      // Créer le répertoire si nécessaire
      const dir = path.dirname(outputPath);
      await fs.mkdir(dir, { recursive: true });
      
      // Écrire le fichier
      await fs.writeFile(outputPath, exportContent, 'utf-8');
      logger.info(`Rapport exporté vers: ${outputPath}`);
    }

    // Préparer le résultat
    const result: any = {
      success: true,
      reportId: report.reportId,
      summary: report.summary,
      performance: report.performance,
      differences: report.diffs,
      timestamp: report.timestamp
    };

    if (outputPath) {
      result.outputPath = outputPath;
      result.exportFormat = args.format || 'json';
    }

    if (args.dryRun) {
      result.dryRun = true;
      result.exportContent = exportContent;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };

  } catch (error) {
    logger.error('Erreur lors du diff granulaire', { 
      error: (error as Error).message,
      stack: (error as Error).stack 
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
          }, null, 2)
        }
      ],
      isError: true
    };
  }
}

/**
 * Schema de validation pour roosync_validate_diff
 */
export const ValidateDiffArgsSchema = z.object({
  reportId: z.string()
    .describe('ID du rapport de diff à valider'),
  diffIds: z.array(z.string())
    .describe('Liste des IDs de diffs à valider'),
  action: z.enum(['approve', 'reject', 'modify'])
    .describe('Action de validation'),
  reason: z.string().optional()
    .describe('Raison de la décision (optionnel)'),
  modifications: z.record(z.any()).optional()
    .describe('Modifications à appliquer (si action = modify)')
});

/**
 * Outil MCP pour valider un diff granulaire
 */
export const roosync_validate_diff = {
  name: 'roosync_validate_diff',
  description: 'Valide de manière interactive les différences détectées par un diff granulaire',
  inputSchema: ValidateDiffArgsSchema
};

/**
 * Gestionnaire pour l'outil roosync_validate_diff
 */
export async function handleRoosyncValidateDiff(
  args: any
): Promise<CallToolResult> {
  try {
    logger.info('Début de la validation de diff', { 
      reportId: args.reportId,
      action: args.action,
      diffCount: args.diffIds?.length
    });

    // Valider les arguments
    if (!args.reportId || !args.diffIds || !args.action) {
      throw new Error('Les paramètres reportId, diffIds et action sont requis');
    }

    // Pour l'instant, simuler la validation
    // Dans une implémentation complète, il faudrait:
    // 1. Charger le rapport depuis le stockage
    // 2. Appliquer les validations
    // 3. Sauvegarder les décisions
    // 4. Mettre à jour le statut

    const validationResults = args.diffIds.map((diffId: string) => ({
      diffId,
      action: args.action,
      reason: args.reason || '',
      timestamp: new Date().toISOString(),
      approvedBy: 'user', // Sera remplacé par l'utilisateur réel
      modifications: args.modifications || null
    }));

    const result = {
      success: true,
      reportId: args.reportId,
      validationResults,
      summary: {
        total: validationResults.length,
        approved: validationResults.filter((r: any) => r.action === 'approve').length,
        rejected: validationResults.filter((r: any) => r.action === 'reject').length,
        modified: validationResults.filter((r: any) => r.action === 'modify').length
      },
      timestamp: new Date().toISOString()
    };

    logger.info('Validation de diff terminée', result.summary);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };

  } catch (error) {
    logger.error('Erreur lors de la validation de diff', { 
      error: (error as Error).message,
      stack: (error as Error).stack 
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
          }, null, 2)
        }
      ],
      isError: true
    };
  }
}

/**
 * Schema de validation pour roosync_export_diff
 */
export const ExportDiffArgsSchema = z.object({
  reportId: z.string()
    .describe('ID du rapport de diff à exporter'),
  format: z.enum(['json', 'csv', 'html'])
    .describe('Format d\'export'),
  outputPath: z.string()
    .describe('Chemin de sortie pour le fichier exporté'),
  filter: z.object({
    severity: z.array(z.string()).optional(),
    category: z.array(z.string()).optional(),
    type: z.array(z.string()).optional()
  }).optional()
});

/**
 * Outil MCP pour exporter un diff granulaire
 */
export const roosync_export_diff = {
  name: 'roosync_export_diff',
  description: 'Exporte un rapport de diff granulaire vers différents formats',
  inputSchema: ExportDiffArgsSchema
};

/**
 * Gestionnaire pour l'outil roosync_export_diff
 */
export async function handleRoosyncExportDiff(
  args: any
): Promise<CallToolResult> {
  try {
    logger.info('Début de l\'export de diff', { 
      reportId: args.reportId,
      format: args.format,
      outputPath: args.outputPath
    });

    // Valider les arguments
    if (!args.reportId || !args.format || !args.outputPath) {
      throw new Error('Les paramètres reportId, format et outputPath sont requis');
    }

    // Pour l'instant, simuler l'export
    // Dans une implémentation complète, il faudrait:
    // 1. Charger le rapport depuis le stockage
    // 2. Appliquer les filtres
    // 3. Exporter dans le format demandé
    // 4. Écrire le fichier

    const detector = new GranularDiffDetector();
    
    // Simuler un rapport pour la démo
    const mockReport: GranularDiffReport = {
      reportId: args.reportId,
      timestamp: new Date().toISOString(),
      sourceLabel: 'source',
      targetLabel: 'target',
      options: {},
      summary: {
        total: 0,
        byType: {
          added: 0,
          removed: 0,
          modified: 0,
          moved: 0,
          copied: 0,
          unchanged: 0
        },
        bySeverity: {
          CRITICAL: 0,
          IMPORTANT: 0,
          WARNING: 0,
          INFO: 0
        },
        byCategory: {
          roo_config: 0,
          hardware: 0,
          software: 0,
          system: 0,
          nested: 0,
          array: 0,
          semantic: 0
        }
      },
      diffs: [],
      performance: {
        executionTime: 0,
        nodesCompared: 0
      }
    };

    const exportContent = await detector.exportDiff(mockReport, args.format);

    // Écrire le fichier
    const fs = await import('fs/promises');
    const path = await import('path');
    
    // Créer le répertoire si nécessaire
    const dir = path.dirname(args.outputPath);
    await fs.mkdir(dir, { recursive: true });
    
    // Écrire le fichier
    await fs.writeFile(args.outputPath, exportContent, 'utf-8');

    const result = {
      success: true,
      reportId: args.reportId,
      format: args.format,
      outputPath: args.outputPath,
      fileSize: exportContent.length,
      timestamp: new Date().toISOString()
    };

    logger.info('Export de diff terminé', result);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };

  } catch (error) {
    logger.error('Erreur lors de l\'export de diff', { 
      error: (error as Error).message,
      stack: (error as Error).stack 
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: (error as Error).message,
            timestamp: new Date().toISOString()
          }, null, 2)
        }
      ],
      isError: true
    };
  }
}