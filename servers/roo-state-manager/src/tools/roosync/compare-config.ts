/**
 * Outil MCP : roosync_compare_config
 *
 * Compare la configuration locale avec une autre machine ou un profil.
 * Supporte implicitement le mode "profils" via l'ID de cible.
 *
 * @module tools/roosync/compare-config
 * @version 2.3.0 - Added settings granularity for state.vscdb comparison (#547)
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import { GranularDiffDetector } from '../../services/GranularDiffDetector.js';
import type { GranularDiffReport, GranularDiffResult } from '../../services/GranularDiffDetector.js';
import { RooSettingsService, SYNC_SAFE_KEYS } from '../../services/RooSettingsService.js';
import { promises as fsPromises } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Variables d'environnement critiques pour le fonctionnement du MCP
 * Ces variables doivent être présentes pour que les fonctionnalités clés fonctionnent
 * @see #495 - Détection config EMBEDDING_*
 */
const CRITICAL_ENV_VARS = [
  { name: 'EMBEDDING_MODEL', description: 'Modèle d\'embedding pour codebase_search', severity: 'WARNING' as const },
  { name: 'EMBEDDING_DIMENSIONS', description: 'Dimension des vecteurs d\'embedding', severity: 'WARNING' as const },
  { name: 'EMBEDDING_API_BASE_URL', description: 'URL de l\'API d\'embedding', severity: 'WARNING' as const },
  { name: 'EMBEDDING_API_KEY', description: 'Clé API pour l\'embedding', severity: 'WARNING' as const },
  { name: 'QDRANT_URL', description: 'URL du serveur Qdrant', severity: 'CRITICAL' as const },
  { name: 'QDRANT_API_KEY', description: 'Clé API Qdrant', severity: 'CRITICAL' as const },
];

/**
 * Vérifie les variables d'environnement critiques manquantes
 * @returns Liste des différences pour les variables manquantes
 */
function checkMissingEnvVars(): Array<{
  category: string;
  severity: string;
  path: string;
  description: string;
  action?: string;
}> {
  const missing: Array<{
    category: string;
    severity: string;
    path: string;
    description: string;
    action?: string;
  }> = [];

  for (const envVar of CRITICAL_ENV_VARS) {
    if (!process.env[envVar.name]) {
      missing.push({
        category: 'environment',
        severity: envVar.severity,
        path: `env.${envVar.name}`,
        description: `Variable d'environnement manquante: ${envVar.name} - ${envVar.description}`,
        action: `Ajouter ${envVar.name} dans le fichier .env du MCP`
      });
    }
  }

  return missing;
}

/**
 * Schema de validation pour roosync_compare_config
 */
export const CompareConfigArgsSchema = z.object({
  source: z.string().optional()
    .describe('ID de la machine source (optionnel, défaut: local_machine)'),
  target: z.string().optional()
    .describe('ID de la machine cible (optionnel, défaut: remote_machine)'),
  force_refresh: z.boolean().optional()
    .describe('Forcer la collecte d\'inventaire même si cache valide (défaut: false)'),
  granularity: z.enum(['mcp', 'mode', 'settings', 'full']).optional()
    .describe('Niveau de granularité: mcp (MCPs uniquement), mode (modes Roo), settings (Roo settings state.vscdb), full (comparaison complète GranularDiffDetector)'),
  filter: z.string().optional()
    .describe('Filtre optionnel sur les paths (ex: "jupyter" pour filtrer un MCP spécifique)')
});

export type CompareConfigArgs = z.infer<typeof CompareConfigArgsSchema>;

/**
 * Schema de retour pour roosync_compare_config
 */
export const CompareConfigResultSchema = z.object({
  source: z.string().describe('Machine source'),
  target: z.string().describe('Machine cible'),
  host_id: z.string().optional().describe('Identifiant de l\'hôte local'),
  differences: z.array(z.object({
    category: z.string().describe('Catégorie de différence'),
    severity: z.string().describe('Niveau de sévérité'),
    path: z.string().describe('Chemin de la différence'),
    description: z.string().describe('Description de la différence'),
    action: z.string().optional().describe('Action recommandée')
  })).describe('Liste des différences détectées'),
  summary: z.object({
    total: z.number().describe('Nombre total de différences'),
    critical: z.number().describe('Différences critiques'),
    important: z.number().describe('Différences importantes'),
    warning: z.number().describe('Avertissements'),
    info: z.number().describe('Informations')
  }).describe('Résumé des différences')
});

export type CompareConfigResult = z.infer<typeof CompareConfigResultSchema>;

/**
 * Outil roosync_compare_config
 * 
 * Compare la configuration locale avec une autre machine spécifiée.
 * Si aucune machine n'est spécifiée, sélectionne automatiquement la première
 * machine disponible différente de la machine locale.
 * Supporte la comparaison avec des profils (ex: 'profile:dev', 'profile:prod').
 *
 * @param args Arguments validés
 * @returns Résultat de la comparaison
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncCompareConfig(args: CompareConfigArgs): Promise<CompareConfigResult> {
  // SDDD Debug: Logging direct dans fichier pour contourner le problème de visibilité
  const debugLog = (message: string, data?: any) => {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${message}${data ? ` | ${JSON.stringify(data)}` : ''}\n`;
    
    // Écrire directement dans un fichier de log
    try {
      const fs = require('fs');
      fs.appendFileSync('c:/dev/roo-extensions/debug-roosync-compare.log', logEntry);
    } catch (e) {
      // Ignorer les erreurs de logging
    }
    
    // Garder le console.log pour compatibilité
    console.log(message, data);
  };
  
  debugLog('roosyncCompareConfig appelé avec args', args);
  try {
    debugLog('Avant getRooSyncService()');
      const service = getRooSyncService();
      debugLog('Après getRooSyncService(), service obtenu', { serviceExists: !!service });
      const config = service.getConfig();
      
      // Déterminer machines source et cible
      // Gérer l'alias 'local-machine' qui doit être mappé vers le vrai machineId
      const sourceMachineId = (args.source === 'local-machine') ? config.machineId : (args.source || config.machineId);
      const targetMachineId = (args.target === 'local-machine') ? config.machineId : (args.target || await getDefaultTargetMachine(service, sourceMachineId));

    // Settings comparison: uses RooSettingsService + GDrive published settings
    if (args.granularity === 'settings') {
      debugLog('Mode settings activé', { filter: args.filter });
      return await compareSettings(sourceMachineId, targetMachineId, service, args.filter);
    }

    // Si granularity est fourni, utiliser GranularDiffDetector
    if (args.granularity) {
      debugLog('Mode granulaire activé', { granularity: args.granularity, filter: args.filter });

      // Charger les inventaires complets des deux machines
      const sourceInventory = await service.getInventory(sourceMachineId, args.force_refresh || false);
      const targetInventory = await service.getInventory(targetMachineId, args.force_refresh || false);

      if (!sourceInventory || !targetInventory) {
        throw new RooSyncServiceError(
          `Inventaire manquant: source=${!!sourceInventory}, target=${!!targetInventory}`,
          'INVENTORY_MISSING'
        );
      }

      // Déterminer les données à comparer selon la granularité
      let sourceData: any;
      let targetData: any;

      switch (args.granularity) {
        case 'mcp':
          // Support 3 formats: FullInventory (inventory.mcpServers), InventoryCollector (roo.mcpServers), ou direct
          sourceData = (sourceInventory as any).inventory?.mcpServers ||
                       (sourceInventory as any).roo?.mcpServers ||
                       (sourceInventory as any).mcpServers ||
                       {};
          targetData = (targetInventory as any).inventory?.mcpServers ||
                       (targetInventory as any).roo?.mcpServers ||
                       (targetInventory as any).mcpServers ||
                       {};
          break;
        case 'mode':
          // Support 3 formats: FullInventory (inventory.rooModes), InventoryCollector (roo.modes), ou direct
          sourceData = (sourceInventory as any).inventory?.rooModes ||
                       (sourceInventory as any).roo?.modes ||
                       (sourceInventory as any).rooModes ||
                       {};
          targetData = (targetInventory as any).inventory?.rooModes ||
                       (targetInventory as any).roo?.modes ||
                       (targetInventory as any).rooModes ||
                       {};
          break;
        case 'full':
        default:
          sourceData = sourceInventory;
          targetData = targetInventory;
          break;
      }

      // Utiliser GranularDiffDetector
      const detector = new GranularDiffDetector();
      const granularReport = await detector.compareGranular(
        sourceData,
        targetData,
        sourceMachineId,
        targetMachineId,
        {
          includeUnchanged: false,
          semanticAnalysis: true,
          maxDepth: 30
        }
      );

      // Préfixer les chemins pour le mode granulaire
      let diffs = granularReport.diffs;
      if (args.granularity === 'mcp') {
        diffs = diffs.map(diff => ({
          ...diff,
          path: `inventory.mcpServers.${diff.path}`,
          category: 'roo_config' as any
        }));
      } else if (args.granularity === 'mode') {
        diffs = diffs.map(diff => ({
          ...diff,
          path: `inventory.rooModes.${diff.path}`,
          category: 'roo_config' as any
        }));
      }

      // Appliquer le filtre si fourni
      let filteredDiffs = diffs;
      if (args.filter) {
        const filterLower = args.filter.toLowerCase();
        filteredDiffs = diffs.filter(diff =>
          diff.path.toLowerCase().includes(filterLower) ||
          diff.description.toLowerCase().includes(filterLower)
        );
      }

      // Convertir au format CompareConfigResult
      return formatGranularReport(granularReport, filteredDiffs, sourceMachineId, targetMachineId);
    }

    // Comparaison standard (sans granularité)
    const report = await service.compareRealConfigurations(
      sourceMachineId,
      targetMachineId,
      args.force_refresh || false
    );

    if (!report) {
      throw new RooSyncServiceError(
        'Échec de la comparaison des configurations',
        'COMPARISON_FAILED'
      );
    }

    // Formatter le rapport pour l'affichage
    return formatComparisonReport(report);
    
  } catch (error) {
    // CORRECTION SDDD: Laisser remonter les erreurs détaillées du BaselineService
    if (error instanceof RooSyncServiceError) {
      debugLog('RooSyncServiceError interceptée', {
        name: error.name,
        message: error.message,
        code: error.code
      });
      throw error;
    }
    
    // Conserver le message d'erreur original pour le debugging
    const originalError = error as Error;
    debugLog('Erreur originale dans compare-config', {
      errorType: typeof error,
      errorMessage: originalError.message,
      errorStack: originalError.stack,
      errorName: originalError.name
    });
    
    throw new RooSyncServiceError(
      `Erreur lors de la comparaison: ${originalError.message}`,
      'ROOSYNC_COMPARE_ERROR'
    );
  }
}

/**
 * Settings categories for severity classification
 */
const SETTINGS_CATEGORIES: Record<string, { severity: string; label: string }> = {
  // Model & API - CRITICAL (affects which model is used)
  apiProvider: { severity: 'CRITICAL', label: 'Model Configuration' },
  openAiBaseUrl: { severity: 'CRITICAL', label: 'Model Configuration' },
  openAiModelId: { severity: 'CRITICAL', label: 'Model Configuration' },
  currentApiConfigName: { severity: 'CRITICAL', label: 'Model Configuration' },
  listApiConfigMeta: { severity: 'CRITICAL', label: 'Model Configuration' },
  profileThresholds: { severity: 'IMPORTANT', label: 'Model Configuration' },

  // Condensation - IMPORTANT (affects context management)
  autoCondenseContext: { severity: 'IMPORTANT', label: 'Condensation' },
  autoCondenseContextPercent: { severity: 'IMPORTANT', label: 'Condensation' },
  condensingApiConfigId: { severity: 'IMPORTANT', label: 'Condensation' },

  // Auto-approval - IMPORTANT (affects security posture)
  autoApprovalEnabled: { severity: 'IMPORTANT', label: 'Auto-Approval' },
  alwaysAllowReadOnly: { severity: 'WARNING', label: 'Auto-Approval' },
  alwaysAllowWrite: { severity: 'IMPORTANT', label: 'Auto-Approval' },
  alwaysAllowBrowser: { severity: 'IMPORTANT', label: 'Auto-Approval' },
  alwaysAllowMcp: { severity: 'WARNING', label: 'Auto-Approval' },
  alwaysAllowExecute: { severity: 'IMPORTANT', label: 'Auto-Approval' },
};

/**
 * Compare settings between local machine and target machine's published settings
 */
async function compareSettings(
  sourceMachineId: string,
  targetMachineId: string,
  service: any,
  filter?: string
): Promise<CompareConfigResult> {
  const differences: Array<{
    category: string;
    severity: string;
    path: string;
    description: string;
    action?: string;
  }> = [];

  // 1. Load source settings (local machine = live from state.vscdb)
  const settingsService = new RooSettingsService();
  let sourceSettings: Record<string, unknown> = {};
  let sourceLabel = sourceMachineId;

  const config = service.getConfig();
  const isSourceLocal = sourceMachineId === config.machineId;

  if (isSourceLocal && settingsService.isAvailable()) {
    try {
      const extract = await settingsService.extractSettings('safe');
      sourceSettings = extract.settings;
      sourceLabel = `${sourceMachineId} (live)`;
    } catch (err) {
      // Fallback to published settings
      sourceSettings = await loadPublishedSettings(service, sourceMachineId);
      sourceLabel = `${sourceMachineId} (published)`;
    }
  } else {
    sourceSettings = await loadPublishedSettings(service, sourceMachineId);
    sourceLabel = `${sourceMachineId} (published)`;
  }

  // 2. Load target settings (always from published GDrive)
  const targetSettings = await loadPublishedSettings(service, targetMachineId);

  if (Object.keys(sourceSettings).length === 0 && Object.keys(targetSettings).length === 0) {
    return {
      source: sourceLabel,
      target: `${targetMachineId} (published)`,
      differences: [{
        category: 'roo_settings',
        severity: 'WARNING',
        path: 'settings',
        description: 'Aucun settings publié trouvé pour les deux machines. Exécutez roosync_config(action: "collect", targets: ["settings"]) puis publish.',
        action: 'Publier les settings des deux machines'
      }],
      summary: { total: 1, critical: 0, important: 0, warning: 1, info: 0 }
    };
  }

  // 3. Compare all sync-safe keys
  const allKeys = new Set([...Object.keys(sourceSettings), ...Object.keys(targetSettings)]);

  for (const key of allKeys) {
    if (!SYNC_SAFE_KEYS.has(key)) continue; // Only compare sync-safe keys

    const sourceVal = sourceSettings[key];
    const targetVal = targetSettings[key];
    const sourceJson = JSON.stringify(sourceVal);
    const targetJson = JSON.stringify(targetVal);

    if (sourceJson === targetJson) continue;

    const catInfo = SETTINGS_CATEGORIES[key] || { severity: 'INFO', label: 'Other' };
    const path = `settings.${key}`;

    // Apply filter if provided
    if (filter) {
      const filterLower = filter.toLowerCase();
      if (!path.toLowerCase().includes(filterLower) &&
          !key.toLowerCase().includes(filterLower) &&
          !catInfo.label.toLowerCase().includes(filterLower)) {
        continue;
      }
    }

    let description: string;
    if (sourceVal === undefined) {
      description = `[${catInfo.label}] "${key}" absent sur source, présent sur cible`;
    } else if (targetVal === undefined) {
      description = `[${catInfo.label}] "${key}" présent sur source, absent sur cible`;
    } else {
      // Truncate long values for display
      const srcDisplay = truncateValue(sourceVal);
      const tgtDisplay = truncateValue(targetVal);
      description = `[${catInfo.label}] "${key}" diffère: ${srcDisplay} → ${tgtDisplay}`;
    }

    differences.push({
      category: 'roo_settings',
      severity: catInfo.severity,
      path,
      description,
      action: catInfo.severity === 'CRITICAL' ? 'Synchroniser ce paramètre' : undefined
    });
  }

  // Sort by severity
  const severityOrder: Record<string, number> = { CRITICAL: 0, IMPORTANT: 1, WARNING: 2, INFO: 3 };
  differences.sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4));

  const summary = {
    total: differences.length,
    critical: differences.filter(d => d.severity === 'CRITICAL').length,
    important: differences.filter(d => d.severity === 'IMPORTANT').length,
    warning: differences.filter(d => d.severity === 'WARNING').length,
    info: differences.filter(d => d.severity === 'INFO').length
  };

  return {
    source: sourceLabel,
    target: `${targetMachineId} (published)`,
    host_id: config.machineId,
    differences,
    summary
  };
}

/**
 * Load published settings from GDrive for a specific machine
 * Checks multiple locations:
 * 1. configs/{machineId}/roo-settings-safe.json (standalone, from Python script)
 * 2. configs/{machineId}/latest versioned package with roo-settings/roo-settings.json
 */
async function loadPublishedSettings(service: any, machineId: string): Promise<Record<string, unknown>> {
  const config = service.getConfig();
  const sharedStatePath = process.env.ROOSYNC_SHARED_PATH || config.sharedStatePath;

  if (!sharedStatePath) return {};

  const configsDir = join(sharedStatePath, 'configs', machineId);
  if (!existsSync(configsDir)) return {};

  // Try standalone file first (published by Python script)
  const standalonePath = join(configsDir, 'roo-settings-safe.json');
  if (existsSync(standalonePath)) {
    try {
      const raw = await fsPromises.readFile(standalonePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Support wrapped format { metadata, settings } or raw dict
      return parsed.settings ?? parsed;
    } catch {
      // Continue to next source
    }
  }

  // Try versioned packages (find latest with roo-settings)
  try {
    const entries = await fsPromises.readdir(configsDir, { withFileTypes: true });
    const versionDirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith('v'))
      .map(e => e.name)
      .sort()
      .reverse();

    for (const dir of versionDirs) {
      const settingsPath = join(configsDir, dir, 'roo-settings', 'roo-settings.json');
      if (existsSync(settingsPath)) {
        const raw = await fsPromises.readFile(settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed.settings ?? parsed;
      }
    }
  } catch {
    // No versioned packages found
  }

  return {};
}

/**
 * Truncate a value for display in diff description
 */
function truncateValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    return value.length > 50 ? `"${value.substring(0, 47)}..."` : `"${value}"`;
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object);
    return `{${keys.length} keys}`;
  }
  return String(value);
}

/**
 * Obtenir la machine cible par défaut
 */
async function getDefaultTargetMachine(service: any, sourceMachineId: string): Promise<string> {
  const dashboard = await service.loadDashboard();
  const machines = Object.keys(dashboard.machines).filter(
    m => m !== sourceMachineId
  );
  
  if (machines.length === 0) {
    throw new RooSyncServiceError(
      'Aucune autre machine trouvée pour la comparaison',
      'NO_TARGET_MACHINE'
    );
  }
  
  // Trier par nom pour garantir une sélection prévisible
  machines.sort();
  return machines[0];
}

/**
 * Formate le rapport de comparaison pour l'affichage MCP
 */
function formatComparisonReport(report: any): CompareConfigResult {
  // Vérifier les variables d'environnement critiques manquantes (#495)
  const envDiffs = checkMissingEnvVars();

  const allDifferences = [
    ...report.differences.map((diff: any) => ({
      category: diff.category,
      severity: diff.severity,
      path: diff.path,
      description: diff.description,
      action: diff.recommendedAction
    })),
    ...envDiffs
  ];

  // Recalculer le summary avec les env vars
  const summary = {
    total: allDifferences.length,
    critical: allDifferences.filter(d => d.severity === 'CRITICAL').length,
    important: allDifferences.filter(d => d.severity === 'IMPORTANT').length,
    warning: allDifferences.filter(d => d.severity === 'WARNING').length,
    info: allDifferences.filter(d => d.severity === 'INFO').length
  };

  return {
    source: report.sourceMachine,
    target: report.targetMachine,
    host_id: report.hostId || 'unknown',
    differences: allDifferences,
    summary
  };
}

/**
 * Formate le rapport GranularDiffDetector pour l'affichage MCP
 */
function formatGranularReport(
  report: GranularDiffReport,
  filteredDiffs: GranularDiffResult[],
  sourceMachineId: string,
  targetMachineId: string
): CompareConfigResult {
  // Vérifier les variables d'environnement critiques manquantes (#495)
  const envDiffs = checkMissingEnvVars();

  const allDifferences = [
    ...filteredDiffs.map(diff => ({
      category: diff.category,
      severity: diff.severity,
      path: diff.path,
      description: diff.description,
      action: getRecommendedAction(diff)
    })),
    ...envDiffs
  ];

  // Recalculer le summary basé sur tous les diffs (incluant env vars)
  const summary = {
    total: allDifferences.length,
    critical: allDifferences.filter(d => d.severity === 'CRITICAL').length,
    important: allDifferences.filter(d => d.severity === 'IMPORTANT').length,
    warning: allDifferences.filter(d => d.severity === 'WARNING').length,
    info: allDifferences.filter(d => d.severity === 'INFO').length
  };

  return {
    source: sourceMachineId,
    target: targetMachineId,
    host_id: report.sourceLabel,
    differences: allDifferences,
    summary
  };
}

/**
 * Génère une action recommandée basée sur le type et la sévérité du diff
 */
function getRecommendedAction(diff: GranularDiffResult): string | undefined {
  switch (diff.type) {
    case 'added':
      return diff.severity === 'CRITICAL' ? 'Vérifier si ajout intentionnel' : undefined;
    case 'removed':
      return diff.severity === 'CRITICAL' ? 'Vérifier si suppression intentionnelle' : undefined;
    case 'modified':
      if (diff.severity === 'CRITICAL') {
        return 'Synchroniser la configuration';
      } else if (diff.severity === 'IMPORTANT') {
        return 'Vérifier la cohérence';
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 * Utilise Zod.shape natif pour compatibilité MCP
 */
export const compareConfigToolMetadata = {
  name: 'roosync_compare_config',
  description: `Compare les configurations Roo entre deux machines et détecte les différences réelles.

Détection multi-niveaux :
- Configuration Roo (modes, MCPs, settings) - CRITICAL
- Environment (EMBEDDING_*, QDRANT_*) - CRITICAL/WARNING
- Hardware (CPU, RAM, disques, GPU) - IMPORTANT
- Software (PowerShell, Node, Python) - WARNING
- System (OS, architecture) - INFO

Vérification des variables d'environnement critiques (#495):
- EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_API_BASE_URL, EMBEDDING_API_KEY
- QDRANT_URL, QDRANT_API_KEY

Supporte également la comparaison avec des profils (ex: target='profile:dev').
Utilise Get-MachineInventory.ps1 pour collecte d'inventaire complet avec cache TTL 1h.

Modes de granularité (nouveau) :
- mcp: Compare uniquement les configurations MCP
- mode: Compare uniquement les modes Roo
- settings: Compare les settings Roo (state.vscdb) entre machines (#547)
- full: Comparaison granulaire complète avec GranularDiffDetector`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      source: {
        type: 'string',
        description: 'ID de la machine source (optionnel, défaut: local_machine)'
      },
      target: {
        type: 'string',
        description: 'ID de la machine cible ou du profil (optionnel, défaut: remote_machine)'
      },
      force_refresh: {
        type: 'boolean',
        description: 'Forcer la collecte d\'inventaire même si cache valide (défaut: false)'
      },
      granularity: {
        type: 'string',
        enum: ['mcp', 'mode', 'settings', 'full'],
        description: 'Niveau de granularité: mcp (MCPs uniquement), mode (modes Roo), settings (Roo settings state.vscdb), full (comparaison complète)'
      },
      filter: {
        type: 'string',
        description: 'Filtre optionnel sur les paths (ex: "jupyter" pour filtrer un MCP spécifique)'
      }
    },
    additionalProperties: false
  }
};