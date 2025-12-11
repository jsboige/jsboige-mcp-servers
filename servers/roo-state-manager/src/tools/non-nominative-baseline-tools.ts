/**
 * Outils MCP pour la gestion des baselines non-nominatives - RooSync v2.2
 *
 * Ce fichier contient les outils MCP pour interagir avec le nouveau système
 * de baseline non-nominatif qui ne dépend plus des identités de machines.
 *
 * @module NonNominativeBaselineTools
 * @version 2.2.0
 */

import { z } from 'zod';
import { getRooSyncService } from '../services/RooSyncService.js';
import { 
  NonNominativeBaseline, 
  ConfigurationCategory, 
  AggregationConfig, 
  MigrationOptions 
} from '../types/non-nominative-baseline.js';

/**
 * Génère des recommandations basées sur les résultats de validation
 */
function generateValidationRecommendations(validationResults: any): string[] {
  const recommendations: string[] = [];

  if (!validationResults.baseline.isValid) {
    recommendations.push('Corriger les problèmes de structure de la baseline');
  }

  if (validationResults.profiles.invalidCount > 0) {
    recommendations.push(`Corriger les ${validationResults.profiles.invalidCount} profils invalides`);
  }

  if (validationResults.mappings.invalidCount > 0) {
    recommendations.push(`Nettoyer les ${validationResults.mappings.invalidCount} mappings incohérents`);
  }

  if (recommendations.length === 0) {
    recommendations.push('Aucune action requise - la baseline est valide');
  }

  return recommendations;
}

/**
 * Convertit les données en format CSV
 */
function convertToCSV(data: any): string {
  const csvLines: string[] = [];
  
  // En-tête CSV pour les profils
  csvLines.push('Type,ID,Category,Name,Description,Priority,Status,CreatedAt');
  
  // Profils
  if (data.baseline && data.baseline.profiles) {
    for (const profile of data.baseline.profiles) {
      csvLines.push([
        'Profile',
        profile.profileId,
        profile.category,
        `"${profile.name}"`,
        `"${profile.description}"`,
        profile.priority,
        profile.metadata.stability,
        profile.metadata.createdAt
      ].join(','));
    }
  }

  return csvLines.join('\n');
}

/**
 * Crée une baseline non-nominative par agrégation automatique
 */
export const create_non_nominative_baseline = {
  name: 'create_non_nominative_baseline',
  description: 'Crée une baseline non-nominative par agrégation automatique des configurations existantes',
  inputSchema: z.object({
    name: z.string().describe('Nom de la baseline à créer'),
    description: z.string().describe('Description de la baseline'),
    aggregationConfig: z.object({
      sources: z.array(z.object({
        type: z.enum(['machine_inventory', 'existing_baseline', 'manual_input']),
        weight: z.number(),
        enabled: z.boolean()
      })).optional().describe('Sources de données pour l\'agrégation'),
      categoryRules: z.record(z.enum(['manual', 'majority', 'weighted_average', 'latest']), z.object({
        strategy: z.enum(['manual', 'majority', 'weighted_average', 'latest']),
        confidenceThreshold: z.number(),
        autoApply: z.boolean()
      })).optional().describe('Règles d\'agrégation par catégorie'),
      thresholds: z.object({
        deviationThreshold: z.number(),
        complianceThreshold: z.number(),
        outlierDetection: z.boolean()
      }).optional().describe('Seuils de détection')
    }).optional().describe('Configuration d\'agrégation personnalisée')
  }),
  handler: async (args: any) => {
    try {
      const rooSyncService = getRooSyncService();
      const baseline = await rooSyncService.createNonNominativeBaseline(
        args.name,
        args.description,
        args.aggregationConfig
      );

      return {
        success: true,
        baseline: {
          baselineId: baseline.baselineId,
          version: baseline.version,
          name: baseline.name,
          description: baseline.description,
          profilesCount: baseline.profiles.length,
          categories: baseline.profiles.map((p: any) => p.category),
          createdAt: baseline.metadata.createdAt,
          status: baseline.metadata.status
        },
        message: `Baseline non-nominative "${baseline.name}" créée avec succès (${baseline.profiles.length} profils)`
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        message: `Échec de la création de la baseline: ${(error as Error).message}`
      };
    }
  }
};

/**
 * Mappe une machine à la baseline non-nominative
 */
export const map_machine_to_non_nominative_baseline = {
  name: 'map_machine_to_non_nominative_baseline',
  description: 'Mappe une machine spécifique à la baseline non-nominative active',
  inputSchema: z.object({
    machineId: z.string().describe('Identifiant de la machine à mapper')
  }),
  handler: async (args: any) => {
    try {
      const rooSyncService = getRooSyncService();
      const mapping = await rooSyncService.mapMachineToNonNominativeBaseline(args.machineId);

      return {
        success: true,
        mapping: {
          mappingId: mapping.mappingId,
          machineHash: mapping.machineHash,
          baselineId: mapping.baselineId,
          appliedProfiles: mapping.appliedProfiles,
          deviationsCount: mapping.deviations.length,
          confidence: mapping.metadata.confidence,
          lastSeen: mapping.metadata.lastSeen
        },
        deviations: mapping.deviations.map((d: any) => ({
          category: d.category,
          severity: d.severity,
          description: `Déviation détectée pour ${d.category}`,
          detectedAt: d.detectedAt
        })),
        message: `Machine ${args.machineId} mappée avec succès (hash: ${mapping.machineHash})`
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        message: `Échec du mapping de la machine: ${(error as Error).message}`
      };
    }
  }
};

/**
 * Compare plusieurs machines avec la baseline non-nominative
 */
export const compare_machines_non_nominative = {
  name: 'compare_machines_non_nominative',
  description: 'Compare plusieurs machines avec la baseline non-nominative active',
  inputSchema: z.object({
    machineIds: z.array(z.string()).describe('Liste des identifiants de machines à comparer'),
    includeDetails: z.boolean().optional().describe('Inclure les détails des différences')
  }),
  handler: async (args: any) => {
    try {
      const rooSyncService = getRooSyncService();
      const report = await rooSyncService.compareMachinesNonNominative(args.machineIds);

      const result: any = {
        success: true,
        report: {
          reportId: report.reportId,
          baselineId: report.baselineId,
          totalMachines: report.statistics.totalMachines,
          totalDifferences: report.statistics.totalDifferences,
          complianceRate: Math.round(report.statistics.complianceRate * 100),
          differencesBySeverity: report.statistics.differencesBySeverity,
          differencesByCategory: Object.keys(report.statistics.differencesByCategory).reduce((acc, cat) => {
            acc[cat] = report.statistics.differencesByCategory[cat as ConfigurationCategory];
            return acc;
          }, {} as Record<string, number>)
        },
        message: `Comparaison terminée: ${report.statistics.totalDifferences} différences détectées`
      };

      // Inclure les détails si demandé
      if (args.includeDetails) {
        result.differences = {};
        for (const [category, diffs] of Object.entries(report.differencesByCategory)) {
          result.differences[category] = (diffs as any[]).map((d: any) => ({
            machineHash: d.machineHash,
            profileId: d.profileId,
            field: d.field,
            severity: d.severity,
            description: d.description,
            expectedValue: d.expectedValue,
            actualValue: d.actualValue
          }));
        }
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        message: `Échec de la comparaison: ${(error as Error).message}`
      };
    }
  }
};

/**
 * Migre depuis l'ancien système de baseline vers le nouveau système non-nominatif
 */
export const migrate_to_non_nominative = {
  name: 'migrate_to_non_nominative',
  description: 'Migre les données depuis l\'ancien système de baseline vers le nouveau système non-nominatif',
  inputSchema: z.object({
    keepLegacyReferences: z.boolean().optional().describe('Conserver les références legacy'),
    machineMappingStrategy: z.enum(['hash', 'uuid', 'sequential']).optional().describe('Stratégie de mapping des machines'),
    autoValidate: z.boolean().optional().describe('Valider automatiquement après migration'),
    createBackup: z.boolean().optional().describe('Créer un backup avant migration'),
    priorityCategories: z.array(z.enum(['roo-core', 'roo-advanced', 'hardware-cpu', 'hardware-memory', 'hardware-storage', 'hardware-gpu', 'software-powershell', 'software-node', 'software-python', 'system-os', 'system-architecture'])).optional().describe('Catégories prioritaires')
  }),
  handler: async (args: any) => {
    try {
      const rooSyncService = getRooSyncService();
      const options: MigrationOptions = {
        keepLegacyReferences: args.keepLegacyReferences ?? true,
        machineMappingStrategy: args.machineMappingStrategy ?? 'hash',
        autoValidate: args.autoValidate ?? true,
        createBackup: args.createBackup ?? true,
        priorityCategories: args.priorityCategories ?? ['roo-core', 'software-powershell', 'software-node', 'software-python']
      };

      const result = await rooSyncService.migrateToNonNominative(options);

      return {
        success: result.success,
        migration: {
          newBaseline: result.newBaseline ? {
            baselineId: result.newBaseline.baselineId,
            name: result.newBaseline.name,
            version: result.newBaseline.version,
            profilesCount: result.newBaseline.profiles.length
          } : null,
          statistics: result.statistics,
          errors: result.errors
        },
        message: result.success ? 
          `Migration réussie: ${result.statistics.successfulMigrations}/${result.statistics.totalMachines} machines migrées` :
          `Échec de la migration: ${result.errors.length} erreurs`
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        message: `Échec de la migration: ${(error as Error).message}`
      };
    }
  }
};

/**
 * Obtient l'état actuel du système de baseline non-nominatif
 */
export const get_non_nominative_baseline_state = {
  name: 'get_non_nominative_baseline_state',
  description: 'Obtient l\'état actuel du système de baseline non-nominatif',
  inputSchema: z.object({
    includeMappings: z.boolean().optional().describe('Inclure les mappings de machines'),
    includeBaseline: z.boolean().optional().describe('Inclure les détails de la baseline active')
  }),
  handler: async (args: any) => {
    try {
      const rooSyncService = getRooSyncService();
      const state = rooSyncService.getNonNominativeState();
      const activeBaseline = rooSyncService.getActiveNonNominativeBaseline();

      const result: any = {
        success: true,
        state: {
          statistics: state?.statistics || {
            totalBaselines: 0,
            totalProfiles: 0,
            totalMachines: 0,
            averageCompliance: 0,
            lastUpdated: new Date().toISOString()
          }
        }
      };

      if (args.includeBaseline && activeBaseline) {
        result.activeBaseline = {
          baselineId: activeBaseline.baselineId,
          name: activeBaseline.name,
          version: activeBaseline.version,
          description: activeBaseline.description,
          profilesCount: activeBaseline.profiles.length,
          status: activeBaseline.metadata.status,
          createdAt: activeBaseline.metadata.createdAt,
          updatedAt: activeBaseline.metadata.updatedAt
        };
      }

      if (args.includeMappings) {
        const mappings = rooSyncService.getNonNominativeMachineMappings();
        result.machineMappings = mappings.map((m: any) => ({
          mappingId: m.mappingId,
          machineHash: m.machineHash,
          baselineId: m.baselineId,
          appliedProfilesCount: m.appliedProfiles.length,
          deviationsCount: m.deviations.length,
          confidence: m.metadata.confidence,
          lastSeen: m.metadata.lastSeen
        }));
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        message: `Échec de l'obtention de l'état: ${(error as Error).message}`
      };
    }
  }
};

/**
 * Valide la cohérence d'une baseline non-nominative
 */
export const validate_non_nominative_baseline = {
  name: 'validate_non_nominative_baseline',
  description: 'Valide la cohérence d\'une baseline non-nominative',
  inputSchema: z.object({
    baselineId: z.string().optional().describe('Identifiant de la baseline à valider (sinon utilise l\'active)'),
    checkProfileCompatibility: z.boolean().optional().describe('Vérifier la compatibilité des profils'),
    checkMappingConsistency: z.boolean().optional().describe('Vérifier la cohérence des mappings'),
    generateReport: z.boolean().optional().describe('Générer un rapport détaillé')
  }),
  handler: async (args: any) => {
    try {
      const rooSyncService = getRooSyncService();
      const state = rooSyncService.getNonNominativeState();
      const activeBaseline = rooSyncService.getActiveNonNominativeBaseline();

      if (!activeBaseline) {
        return {
          success: false,
          error: 'Aucune baseline active trouvée',
          message: 'Aucune baseline non-nominative active à valider'
        };
      }

      const validationResults: any = {
        baseline: {
          isValid: true,
          issues: []
        },
        profiles: {
          validCount: 0,
          invalidCount: 0,
          issues: []
        },
        mappings: {
          validCount: 0,
          invalidCount: 0,
          issues: []
        }
      };

      // Valider la baseline
      if (!activeBaseline.baselineId || !activeBaseline.profiles || activeBaseline.profiles.length === 0) {
        validationResults.baseline.isValid = false;
        validationResults.baseline.issues.push('Baseline invalide: champs requis manquants');
      }

      // Valider les profils
      for (const profile of activeBaseline.profiles) {
        if (!profile.profileId || !profile.category || !profile.configuration) {
          validationResults.profiles.invalidCount++;
          validationResults.profiles.issues.push(`Profil invalide: ${profile.profileId || 'sans ID'}`);
        } else {
          validationResults.profiles.validCount++;
        }
      }

      // Valider les mappings si demandé
      if (args.checkMappingConsistency) {
        const mappings = rooSyncService.getNonNominativeMachineMappings();
        for (const mapping of mappings) {
          if (mapping.baselineId !== activeBaseline.baselineId) {
            validationResults.mappings.invalidCount++;
            validationResults.mappings.issues.push(`Mapping ${mapping.mappingId} ne correspond pas à la baseline active`);
          } else {
            validationResults.mappings.validCount++;
          }
        }
      }

      const isValid = validationResults.baseline.isValid && 
                     validationResults.profiles.invalidCount === 0 && 
                     (!args.checkMappingConsistency || validationResults.mappings.invalidCount === 0);

      const result: any = {
        success: true,
        validation: {
          isValid,
          summary: {
            baselineValid: validationResults.baseline.isValid,
            profilesValid: validationResults.profiles.validCount,
            profilesInvalid: validationResults.profiles.invalidCount,
            mappingsValid: validationResults.mappings.validCount,
            mappingsInvalid: validationResults.mappings.invalidCount
          },
          issues: [
            ...validationResults.baseline.issues,
            ...validationResults.profiles.issues,
            ...validationResults.mappings.issues
          ]
        },
        message: isValid ? 
          'Baseline non-nominative valide' : 
          `Baseline non-nominative invalide: ${validationResults.baseline.issues.length + validationResults.profiles.issues.length + validationResults.mappings.issues.length} problèmes détectés`
      };

      // Générer un rapport détaillé si demandé
      if (args.generateReport) {
        result.report = {
          baselineId: activeBaseline.baselineId,
          validatedAt: new Date().toISOString(),
          validationResults,
          recommendations: generateValidationRecommendations(validationResults)
        };
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        message: `Échec de la validation: ${(error as Error).message}`
      };
    }
  }
};

/**
 * Exporte une baseline non-nominative vers différents formats
 */
export const export_non_nominative_baseline = {
  name: 'export_non_nominative_baseline',
  description: 'Exporte une baseline non-nominative vers différents formats (JSON, YAML, CSV)',
  inputSchema: z.object({
    baselineId: z.string().optional().describe('Identifiant de la baseline à exporter (sinon utilise l\'active)'),
    format: z.enum(['json', 'yaml', 'csv']).describe('Format d\'exportation'),
    outputPath: z.string().optional().describe('Chemin de sortie pour le fichier exporté'),
    includeMappings: z.boolean().optional().describe('Inclure les mappings de machines'),
    includeMetadata: z.boolean().optional().describe('Inclure les métadonnées complètes')
  }),
  handler: async (args: any) => {
    try {
      const rooSyncService = getRooSyncService();
      const activeBaseline = rooSyncService.getActiveNonNominativeBaseline();

      if (!activeBaseline) {
        return {
          success: false,
          error: 'Aucune baseline active trouvée',
          message: 'Aucune baseline non-nominative active à exporter'
        };
      }

      let exportData: any = {
        baseline: {
          baselineId: activeBaseline.baselineId,
          name: activeBaseline.name,
          version: activeBaseline.version,
          description: activeBaseline.description,
          profiles: activeBaseline.profiles,
          aggregationRules: activeBaseline.aggregationRules
        }
      };

      if (args.includeMetadata) {
        exportData.baseline.metadata = activeBaseline.metadata;
      }

      if (args.includeMappings) {
        const mappings = rooSyncService.getNonNominativeMachineMappings();
        exportData.mappings = mappings.filter((m: any) => m.baselineId === activeBaseline.baselineId);
      }

      // Convertir selon le format demandé
      let content: string;
      let filename: string;

      switch (args.format) {
        case 'yaml':
          // Pour YAML, il faudrait utiliser une librairie comme js-yaml
          content = JSON.stringify(exportData, null, 2);
          filename = `baseline-${activeBaseline.baselineId}.yaml`;
          break;
        case 'csv':
          // Pour CSV, créer une version simplifiée
          const csvData = convertToCSV(exportData);
          content = csvData;
          filename = `baseline-${activeBaseline.baselineId}.csv`;
          break;
        default: // json
          content = JSON.stringify(exportData, null, 2);
          filename = `baseline-${activeBaseline.baselineId}.json`;
      }

      return {
        success: true,
        export: {
          format: args.format,
          filename,
          content,
          size: content.length
        },
        message: `Baseline exportée avec succès au format ${args.format}`
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        message: `Échec de l'exportation: ${(error as Error).message}`
      };
    }
  }
};

// Export de tous les outils
export const nonNominativeBaselineTools = [
  create_non_nominative_baseline,
  map_machine_to_non_nominative_baseline,
  compare_machines_non_nominative,
  migrate_to_non_nominative,
  get_non_nominative_baseline_state,
  validate_non_nominative_baseline,
  export_non_nominative_baseline
];