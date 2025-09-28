/**
 * Validation Engine - Système de validation unifié pour l'API Gateway consolidée
 * 
 * Architecture consolidée selon SDDD :
 * - Validation des 32 outils réels identifiés dans l'audit
 * - Schémas JSON Schema pour chaque catégorie d'outils
 * - Support des 5 presets intelligents avec validation spécifique
 * - Intégration avec l'Architecture 2-niveaux (validation immédiate)
 * 
 * Basé sur les patterns découverts dans l'audit exhaustif :
 * - Display (4 outils) : Navigation et affichage avec options de troncature
 * - Search (2 outils) : Recherche sémantique avec paramètres spécialisés  
 * - Summary (3 outils) : Synthèse avec formats multiples
 * - Export (7 outils) : 6 stratégies d'export identifiées
 * - Utility (16 outils) : Maintenance avec configurations variables
 * 
 * @version 1.0.0
 * @since 2025-09-27 (Phase implémentation consolidée)
 */

import { z } from 'zod';
import { 
  DisplayPreset, 
  DisplayOptions, 
  ToolCategory, 
  ValidationResult 
} from '../interfaces/UnifiedToolInterface.js';

/**
 * Schémas de validation pour chaque catégorie d'outils
 * Basés sur l'analyse des 32 outils réels
 */
class ToolValidationSchemas {
  
  /**
   * Schéma pour les outils Display (4 outils)
   * view_conversation_tree, get_task_tree, list_conversations, view_task_details
   */
  static readonly DISPLAY_SCHEMA = z.object({
    // Options communes découvertes dans l'audit
    truncate: z.number().min(0).optional().describe('Troncature des contenus longs (0 = pas de troncature)'),
    maxResults: z.number().min(1).max(1000).optional().describe('Nombre maximum de résultats'),
    detailLevel: z.enum(['skeleton', 'summary', 'full']).optional().describe('Niveau de détail'),
    includeContent: z.boolean().optional().describe('Inclure le contenu complet'),
    
    // Spécifique à view_conversation_tree
    viewMode: z.enum(['single', 'chain', 'cluster']).optional().describe('Mode d\'affichage'),
    maxOutputLength: z.number().min(1000).max(500000).optional().describe('Limite de sortie'),
    
    // Spécifique à list_conversations  
    sortBy: z.enum(['lastActivity', 'messageCount', 'totalSize']).optional().describe('Critère de tri'),
    sortOrder: z.enum(['asc', 'desc']).optional().describe('Ordre de tri'),
    hasApiHistory: z.boolean().optional().describe('Filtre API history'),
    hasUiMessages: z.boolean().optional().describe('Filtre messages UI'),
    workspace: z.string().optional().describe('Filtre par workspace'),
    
    // Spécifique à get_task_tree
    conversationId: z.string().optional().describe('ID de conversation'),
    maxDepth: z.number().min(1).max(20).optional().describe('Profondeur maximale'),
    includeSiblings: z.boolean().optional().describe('Inclure les tâches sœurs'),
    
    // Spécifique à view_task_details
    taskId: z.string().optional().describe('ID de la tâche'),
    actionIndex: z.number().min(0).optional().describe('Index d\'action spécifique')
  });

  /**
   * Schéma pour les outils Search (2 outils)
   * search_tasks_semantic, index_task_semantic
   */
  static readonly SEARCH_SCHEMA = z.object({
    // Paramètres de recherche sémantique
    searchQuery: z.string().min(1).optional().describe('Requête de recherche sémantique'),
    query: z.string().min(1).optional().describe('Requête de recherche'),
    maxResults: z.number().min(1).max(500).optional().describe('Nombre max de résultats'),
    workspace: z.string().optional().describe('Workspace à fouiller'),
    diagnoseIndex: z.boolean().optional().describe('Mode diagnostic d\'indexation'),
    
    // Spécifique à index_task_semantic
    taskId: z.string().optional().describe('ID de la tâche à indexer'),
    conversationId: z.string().optional().describe('ID de conversation')
  });

  /**
   * Schéma pour les outils Summary (3 outils)
   * generate_trace_summary, generate_cluster_summary, get_conversation_synthesis
   */
  static readonly SUMMARY_SCHEMA = z.object({
    // Options communes de synthèse
    taskId: z.string().optional().describe('ID de la tâche'),
    rootTaskId: z.string().optional().describe('ID de la tâche racine'),
    conversationId: z.string().optional().describe('ID de conversation'),
    filePath: z.string().optional().describe('Chemin de sauvegarde'),
    
    // Niveaux de détail découverts
    detailLevel: z.enum(['Full', 'NoTools', 'NoResults', 'Messages', 'Summary', 'UserOnly']).optional(),
    outputFormat: z.enum(['markdown', 'html', 'json']).optional().describe('Format de sortie'),
    truncationChars: z.number().min(0).optional().describe('Troncature de caractères'),
    compactStats: z.boolean().optional().describe('Format compact des stats'),
    includeCss: z.boolean().optional().describe('Inclure CSS embarqué'),
    generateToc: z.boolean().optional().describe('Générer table des matières'),
    
    // Options de plage (découvertes dans l'audit)
    startIndex: z.number().min(1).optional().describe('Index de début'),
    endIndex: z.number().min(1).optional().describe('Index de fin'),
    
    // Spécifique à generate_cluster_summary
    childTaskIds: z.array(z.string()).optional().describe('IDs des tâches enfantes'),
    clusterMode: z.enum(['aggregated', 'detailed', 'comparative']).optional(),
    includeClusterStats: z.boolean().optional().describe('Inclure stats de grappe'),
    crossTaskAnalysis: z.boolean().optional().describe('Analyse croisée des tâches'),
    maxClusterDepth: z.number().min(1).max(50).optional().describe('Profondeur max de grappe'),
    clusterSortBy: z.enum(['chronological', 'size', 'activity', 'alphabetical']).optional(),
    includeClusterTimeline: z.boolean().optional().describe('Inclure timeline de grappe'),
    clusterTruncationChars: z.number().min(0).optional().describe('Troncature spéc. grappe'),
    showTaskRelationships: z.boolean().optional().describe('Montrer relations parent-enfant')
  });

  /**
   * Schéma pour les outils Export (7 outils) 
   * export_conversation_json, export_conversation_csv, export_conversation_xml, export_tasks_xml, export_project_xml, configure_xml_export, export_conversations_to_file
   */
  static readonly EXPORT_SCHEMA = z.object({
    // Options d'export communes (6 stratégies identifiées)
    taskId: z.string().optional().describe('ID de la tâche à exporter'),
    conversationId: z.string().optional().describe('ID de conversation'),
    rootTaskId: z.string().optional().describe('ID de tâche racine'),
    filePath: z.string().optional().describe('Chemin de destination'),
    file_path: z.string().optional().describe('Chemin absolu du fichier'),
    
    // Formats d'export (Strategy Pattern découvert)
    outputFormat: z.enum(['json', 'csv', 'xml', 'markdown', 'html']).optional(),
    jsonVariant: z.enum(['light', 'full']).optional().describe('Variante JSON'),
    csvVariant: z.enum(['conversations', 'messages', 'tools']).optional().describe('Variante CSV'),
    xmlVariant: z.string().optional().describe('Variante XML'),
    
    // Options de formatage
    prettyPrint: z.boolean().optional().describe('Indentation lisible'),
    includeCss: z.boolean().optional().describe('CSS embarqué'),
    generateToc: z.boolean().optional().describe('Table des matières'),
    includeContent: z.boolean().optional().describe('Contenu complet'),
    truncationChars: z.number().min(0).optional().describe('Troncature caractères'),
    
    // Options de plage
    startIndex: z.number().min(1).optional().describe('Index début'),
    endIndex: z.number().min(1).optional().describe('Index fin'),
    
    // Spécifique aux exports XML
    maxDepth: z.number().min(1).max(20).optional().describe('Profondeur max XML'),
    projectPath: z.string().optional().describe('Chemin projet'),
    startDate: z.string().optional().describe('Date début ISO 8601'),
    endDate: z.string().optional().describe('Date fin ISO 8601'),
    
    // Configuration XML
    config: z.object({}).optional().describe('Configuration XML'),
    action: z.enum(['get', 'set', 'reset']).optional().describe('Action configuration'),
    
    // Export global
    workspace_filter: z.string().optional().describe('Filtre workspace')
  });

  /**
   * Schéma pour les outils Utility (16 outils)  
   * detect_roo_storage, get_storage_stats, build_skeleton_cache, touch_mcp_settings, etc.
   */
  static readonly UTILITY_SCHEMA = z.object({
    // Options communes de maintenance
    forceRebuild: z.boolean().optional().describe('Force la reconstruction'),
    force_rebuild: z.boolean().optional().describe('Force reconstruction complète'),
    backup: z.boolean().optional().describe('Sauvegarde automatique'),
    dryRun: z.boolean().optional().describe('Mode simulation'),
    dry_run: z.boolean().optional().describe('Simulation sans modification'),
    
    // Gestion MCP et settings
    action: z.enum(['read', 'write', 'backup', 'update_server', 'toggle_server']).optional(),
    server_name: z.string().optional().describe('Nom serveur MCP'),
    serverName: z.string().optional().describe('Nom de serveur'),
    server_config: z.object({}).optional().describe('Configuration serveur'),
    settings: z.object({}).optional().describe('Paramètres complets'),
    mcp_name: z.string().optional().describe('Nom MCP à rebuilder'),
    
    // Diagnostics et réparation
    fix_found: z.boolean().optional().describe('Réparer automatiquement'),
    fixFound: z.boolean().optional().describe('Réparation auto'),
    old_workspace: z.string().optional().describe('Ancien workspace'),
    new_workspace: z.string().optional().describe('Nouveau workspace'),
    target_workspace: z.string().optional().describe('Workspace cible'),
    
    // Options de lecture logs  
    lines: z.number().min(1).max(10000).optional().describe('Nombre de lignes'),
    filter: z.string().optional().describe('Filtre regex logs'),
    
    // Cache et indexation
    workspace_filter: z.string().optional().describe('Filtre workspace'),
    max_tasks: z.number().min(0).max(100000).optional().describe('Max tâches à traiter'),
    maxTasks: z.number().min(0).max(100000).optional().describe('Maximum de tâches'),
    confirm: z.boolean().optional().describe('Confirmation obligatoire')
  });
}

/**
 * Moteur de validation unifié
 * Intégré avec l'API Gateway consolidée
 */
export class ValidationEngine {
  
  /**
   * Validation d'un preset avec ses options selon la catégorie
   */
  static async validatePresetOptions(
    preset: DisplayPreset,
    options: DisplayOptions = {},
    category: ToolCategory
  ): Promise<ValidationResult> {
    
    try {
      // Sélection du schéma selon la catégorie
      const schema = this.getSchemaForCategory(category);
      
      // Validation des options générales
      const baseValidation = this.validateBaseOptions(options);
      if (!baseValidation.isValid) {
        return baseValidation;
      }
      
      // Validation spécifique par catégorie
      const result = schema.safeParse(options);
      
      if (!result.success) {
        return {
          isValid: false,
          errors: result.error.errors.map(err => `${err.path.join('.')}: ${err.message}`)
        };
      }
      
      // Validations métier spécifiques au preset
      const businessValidation = this.validateBusinessRules(preset, options, category);
      if (!businessValidation.isValid) {
        return businessValidation;
      }
      
      return { isValid: true, errors: [] };
      
    } catch (error) {
      return {
        isValid: false,
        errors: [`Validation engine error: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }

  /**
   * Sélection du schéma selon la catégorie d'outils
   */
  private static getSchemaForCategory(category: ToolCategory): z.ZodSchema {
    switch (category) {
      case ToolCategory.DISPLAY:
        return ToolValidationSchemas.DISPLAY_SCHEMA;
      case ToolCategory.SEARCH:
        return ToolValidationSchemas.SEARCH_SCHEMA;
      case ToolCategory.SUMMARY:
        return ToolValidationSchemas.SUMMARY_SCHEMA;
      case ToolCategory.EXPORT:
        return ToolValidationSchemas.EXPORT_SCHEMA;
      case ToolCategory.UTILITY:
        return ToolValidationSchemas.UTILITY_SCHEMA;
      default:
        throw new Error(`Unknown tool category: ${category}`);
    }
  }

  /**
   * Validation des options de base communes à tous les outils
   */
  private static validateBaseOptions(options: DisplayOptions): ValidationResult {
    const errors: string[] = [];
    
    // Validation des plages d'index
    if (options.startIndex !== undefined && options.endIndex !== undefined) {
      if (options.startIndex > options.endIndex) {
        errors.push('startIndex must be <= endIndex');
      }
    }
    
    // Validation des tailles  
    if (options.truncate !== undefined && options.truncate < 0) {
      errors.push('truncate must be >= 0');
    }
    
    if (options.maxResults !== undefined && options.maxResults < 1) {
      errors.push('maxResults must be >= 1');
    }
    
    // Validation des formats
    if (options.outputFormat && !['json', 'csv', 'xml', 'markdown', 'html'].includes(options.outputFormat)) {
      errors.push('outputFormat must be one of: json, csv, xml, markdown, html');
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Validation des règles métier spécifiques aux presets
   * Basées sur les patterns découverts dans l'audit
   */
  private static validateBusinessRules(
    preset: DisplayPreset,
    options: DisplayOptions,
    category: ToolCategory
  ): ValidationResult {
    
    const errors: string[] = [];
    const warnings: string[] = [];
    
    switch (preset) {
      case DisplayPreset.QUICK_OVERVIEW:
        // Pour la vue rapide, limiter les résultats
        if (options.maxResults && options.maxResults > 100) {
          warnings.push('maxResults > 100 may impact quick overview performance');
        }
        if (options.detailLevel === 'full') {
          warnings.push('detailLevel "full" is not recommended for quick overview');
        }
        break;
        
      case DisplayPreset.DETAILED_ANALYSIS:
        // Pour l'analyse détaillée, permettre plus de flexibilité
        if (options.truncate && options.truncate > 0 && options.truncate < 100) {
          warnings.push('Low truncate value may lose important details in analysis');
        }
        break;
        
      case DisplayPreset.SEARCH_RESULTS:
        // Validation spécifique à la recherche
        if (category === ToolCategory.SEARCH) {
          if (!options.searchQuery && !options.query) {
            errors.push('Search preset requires searchQuery or query parameter');
          }
        }
        break;
        
      case DisplayPreset.EXPORT_FORMAT:
        // Validation des exports
        if (category === ToolCategory.EXPORT) {
          if (!options.taskId && !options.conversationId && !options.rootTaskId) {
            errors.push('Export preset requires at least one ID parameter (taskId, conversationId, or rootTaskId)');
          }
        }
        break;
        
      case DisplayPreset.TREE_NAVIGATION:
        // Validation navigation arborescente
        if (options.maxDepth && options.maxDepth > 20) {
          warnings.push('maxDepth > 20 may cause performance issues in tree navigation');
        }
        break;
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  /**
   * Validation d'un outil individuel avec son schéma spécifique
   */
  static async validateToolInput(
    toolName: string,
    input: any,
    category: ToolCategory
  ): Promise<ValidationResult> {
    
    try {
      const schema = this.getSchemaForCategory(category);
      const result = schema.safeParse(input);
      
      if (!result.success) {
        return {
          isValid: false,
          errors: result.error.errors.map(err => 
            `Tool ${toolName} - ${err.path.join('.')}: ${err.message}`
          )
        };
      }
      
      // Validation spécifique par outil si nécessaire
      const toolValidation = this.validateSpecificTool(toolName, input);
      if (!toolValidation.isValid) {
        return toolValidation;
      }
      
      return { isValid: true, errors: [] };
      
    } catch (error) {
      return {
        isValid: false,
        errors: [`Tool validation error for ${toolName}: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }

  /**
   * Validations spécifiques par outil selon l'audit
   */
  private static validateSpecificTool(toolName: string, input: any): ValidationResult {
    const errors: string[] = [];
    
    switch (toolName) {
      case 'search_tasks_semantic':
        if (!input.searchQuery && !input.query) {
          errors.push('search_tasks_semantic requires searchQuery or query');
        }
        break;
        
      case 'export_conversation_json':
        if (!input.taskId) {
          errors.push('export_conversation_json requires taskId');
        }
        break;
        
      case 'generate_trace_summary':
        if (!input.taskId) {
          errors.push('generate_trace_summary requires taskId');
        }
        break;
        
      case 'build_skeleton_cache':
        // Validation Cache Anti-Fuite : respecter les seuils
        if (input.force_rebuild === true) {
          // Potentiellement dangereux, ajouter avertissement
          console.warn('[ValidationEngine] force_rebuild=true detected - potential Cache Anti-Leak impact');
        }
        break;
        
      // Ajouter d'autres validations spécifiques selon les besoins
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Validation du Cache Anti-Fuite selon les seuils identifiés
   */
  static validateCacheAntiLeakCompliance(options: DisplayOptions): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Vérifier les opérations potentiellement dangereuses
    if (options.forceRebuild === true || options.force_rebuild === true) {
      warnings.push('Force rebuild may impact Cache Anti-Leak protection (220GB threshold)');
    }
    
    // Vérifier les tailles de résultats
    if (options.maxResults && options.maxResults > 1000) {
      warnings.push('Large maxResults may contribute to Cache Anti-Leak threshold');
    }
    
    // Vérifier les exports massifs
    if (options.truncate === 0 && options.includeContent === true) {
      warnings.push('Full content export may impact Cache Anti-Leak limits');
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  /**
   * Génération d'un rapport de validation détaillé
   */
  static generateValidationReport(
    preset: DisplayPreset,
    options: DisplayOptions,
    category: ToolCategory
  ): { 
    validation: ValidationResult; 
    cacheCompliance: ValidationResult; 
    recommendations: string[] 
  } {
    
    const validation = this.validatePresetOptions(preset, options, category);
    const cacheCompliance = this.validateCacheAntiLeakCompliance(options);
    const recommendations: string[] = [];
    
    // Générer des recommandations basées sur l'audit
    if (preset === DisplayPreset.QUICK_OVERVIEW) {
      recommendations.push('Consider using detailLevel: "skeleton" for optimal quick overview performance');
    }
    
    if (category === ToolCategory.EXPORT && !options.prettyPrint) {
      recommendations.push('Consider enabling prettyPrint for better export readability');
    }
    
    if (options.maxResults && options.maxResults > 100) {
      recommendations.push('Large result sets may benefit from pagination or truncation');
    }
    
    return {
      validation: validation instanceof Promise ? { isValid: false, errors: ['Async validation not resolved'] } : validation,
      cacheCompliance,
      recommendations
    };
  }
}

/**
 * Factory pour création d'une instance de ValidationEngine
 */
export function createValidationEngine(): ValidationEngine {
  return new ValidationEngine();
}

/**
 * Export des schémas pour utilisation externe  
 */
export { ToolValidationSchemas };