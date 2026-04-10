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
import { getRooSyncService, RooSyncServiceError } from '../../services/lazy-roosync.js';
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
  granularity: z.enum(['mcp', 'mode', 'settings', 'claude', 'modes-yaml', 'full']).optional()
    .describe('Niveau de granularité: mcp (MCPs uniquement), mode (modes Roo), settings (Roo settings state.vscdb), claude (config Claude Code ~/.claude.json), modes-yaml (custom_modes.yaml global), full (comparaison complète GranularDiffDetector)'),
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
  granularity: z.string().optional().describe('Granularité de comparaison (mcp, mode, settings, claude, modes-yaml, full)'),
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
  try {
      let service;
      let config;
      let sourceMachineId;
      let targetMachineId;

      // Gestion gracieuse : si RooSyncService ne peut pas être initialisé (répertoire manquant, etc.)
      // retourner un résultat CRITICAL au lieu de lancer une exception
      try {
          service = await getRooSyncService();
          config = service.getConfig();

          // Déterminer machines source et cible
          // Gérer l'alias 'local-machine' qui doit être mappé vers le vrai machineId
          sourceMachineId = (args.source === 'local-machine') ? config.machineId : (args.source || config.machineId);
          targetMachineId = (args.target === 'local-machine') ? config.machineId : (args.target || await getDefaultTargetMachine(service, sourceMachineId));
      } catch (initError) {
          // Le service ne peut pas être initialisé (répertoire manquant, config invalide, etc.)
          // Retourner un résultat CRITICAL cohérent avec le comportement attendu
          const errorMsg = initError instanceof Error ? initError.message : String(initError);
          const isEnoent = errorMsg.includes('ENOENT') || errorMsg.includes('no such file');

          return {
              source: args.source || 'local-machine',
              target: args.target || 'unknown',
              granularity: args.granularity || 'full',
              differences: [{
                  category: 'infrastructure',
                  severity: 'CRITICAL',
                  path: 'roo-sync.infrastructure',
                  description: isEnoent
                      ? 'État partagé RooSync manquant ou inaccessible. Le répertoire ROOSYNC_SHARED_PATH n\'existe pas ou contient des fichiers manquants.'
                      : `Erreur d'initialisation RooSync: ${errorMsg}`,
                  action: 'Vérifier que ROOSYNC_SHARED_PATH est correctement configuré et que le répertoire existe.'
              }],
              summary: { total: 1, critical: 1, important: 0, warning: 0, info: 0 }
          };
      }

    // Settings comparison: uses RooSettingsService + GDrive published settings
    if (args.granularity === 'settings') {
      return await compareSettings(sourceMachineId, targetMachineId, service, args.filter);
    }

    // Si granularity est fourni, utiliser GranularDiffDetector
    if (args.granularity) {
      // Charger les inventaires complets des deux machines
      const sourceInventory = await service.getInventory(sourceMachineId, args.force_refresh || false);
      const targetInventory = await service.getInventory(targetMachineId, args.force_refresh || false);

      if (!sourceInventory || !targetInventory) {
        // Gestion gracieuse : retourner un avertissement au lieu de lancer une erreur
        const missingInventories: string[] = [];
        if (!sourceInventory) missingInventories.push(`source "${sourceMachineId}"`);
        if (!targetInventory) missingInventories.push(`target "${targetMachineId}"`);

        return {
          source: sourceMachineId,
          target: targetMachineId,
          granularity: args.granularity,
          differences: [{
            category: 'inventory',
            severity: 'CRITICAL',
            path: 'inventory',
            description: `Inventaire(s) manquant(s) : ${missingInventories.join(', ')}. Exécutez Get-MachineInventory.ps1 sur la/les machine(s) concernée(s).`,
            action: missingInventories.length === 2
              ? 'Générer les inventaires des deux machines'
              : `Générer l'inventaire de ${missingInventories[0]}`
          }],
          summary: { total: 1, critical: 1, important: 0, warning: 0, info: 0 }
        };
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
        case 'claude':
          // Compare Claude Code config (~/.claude.json) — mcpServers + env + model
          sourceData = (sourceInventory as any).inventory?.claudeConfig ||
                       (sourceInventory as any).claudeConfig ||
                       {};
          targetData = (targetInventory as any).inventory?.claudeConfig ||
                       (targetInventory as any).claudeConfig ||
                       {};
          break;
        case 'modes-yaml':
          // Compare global custom_modes.yaml — same data as 'mode' but explicitly for YAML global source
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
      } else if (args.granularity === 'mode' || args.granularity === 'modes-yaml') {
        diffs = diffs.map(diff => ({
          ...diff,
          path: `inventory.rooModes.${diff.path}`,
          category: 'roo_config' as any
        }));
      } else if (args.granularity === 'claude') {
        diffs = diffs.map(diff => ({
          ...diff,
          path: `inventory.claudeConfig.${diff.path}`,
          category: 'claude_config' as any
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

      // Convertir au format CompareConfigResult (avec comparaison model profiles #498)
      return formatGranularReport(granularReport, filteredDiffs, sourceMachineId, targetMachineId, args.granularity, sourceInventory, targetInventory);
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
    return formatComparisonReport(report, 'full');
    
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }

    const originalError = error as Error;
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
      granularity: 'settings',
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
    granularity: 'settings',
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

  // Try standalone files (multiple naming conventions from Python script)
  const standaloneNames = [
    'roo-settings-safe.json',
    'roo-settings.json',
    'settings-extract.json',
  ];

  for (const name of standaloneNames) {
    const path = join(configsDir, name);
    if (existsSync(path)) {
      try {
        const raw = await fsPromises.readFile(path, 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed.settings ?? parsed;
      } catch (err) {
        console.warn(`[compare-config] Failed to read settings file ${name}:`, err instanceof Error ? err.message : String(err));
        continue;
      }
    }
  }

  // Try dated standalone files (e.g., settings-extract-2026-02-28.json)
  try {
    const entries = await fsPromises.readdir(configsDir);
    const settingsFiles = entries
      .filter(e => e.startsWith('settings-extract') && e.endsWith('.json'))
      .sort()
      .reverse();

    if (settingsFiles.length > 0) {
      const raw = await fsPromises.readFile(join(configsDir, settingsFiles[0]), 'utf-8');
      const parsed = JSON.parse(raw);
      return parsed.settings ?? parsed;
    }
  } catch (err) {
    console.warn('[compare-config] Failed to list dated standalone settings files:', err instanceof Error ? err.message : String(err));
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
  } catch (err) {
    console.warn('[compare-config] Failed to find versioned packages:', err instanceof Error ? err.message : String(err));
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
function formatComparisonReport(report: any, granularity: string = 'full'): CompareConfigResult {
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
    granularity,
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
  targetMachineId: string,
  granularity: string,
  sourceInventory?: any,
  targetInventory?: any
): CompareConfigResult {
  // Vérifier les variables d'environnement critiques manquantes (#495)
  const envDiffs = checkMissingEnvVars();

  // #498: Comparer les profils de modèle
  const modelProfileDiffs = compareModelProfiles(sourceInventory, targetInventory);

  const allDifferences = [
    ...filteredDiffs.map(diff => ({
      category: diff.category,
      severity: diff.severity,
      path: diff.path,
      description: diff.description,
      action: getRecommendedAction(diff)
    })),
    ...envDiffs,
    ...modelProfileDiffs
  ];

  // Recalculer le summary basé sur tous les diffs (incluant env vars et model profiles)
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
    granularity,
    host_id: report.sourceLabel,
    differences: allDifferences,
    summary
  };
}

/**
 * Compare les profils de modèle entre deux machines (#498)
 * Détecte les différences dans model-configs.json
 */
function compareModelProfiles(
  sourceInventory: any,
  targetInventory: any
): Array<{
  category: string;
  severity: string;
  path: string;
  description: string;
  action?: string;
}> {
  const diffs: Array<{
    category: string;
    severity: string;
    path: string;
    description: string;
    action?: string;
  }> = [];

  const sourceProfile = sourceInventory?.roo?.modelProfile || sourceInventory?.inventory?.rooConfig?.modelProfile;
  const targetProfile = targetInventory?.roo?.modelProfile || targetInventory?.inventory?.rooConfig?.modelProfile;

  // Pas de profil sur la source
  if (!sourceProfile) {
    if (targetProfile) {
      diffs.push({
        category: 'roo_config',
        severity: 'WARNING',
        path: 'roo.modelProfile',
        description: `Profil modèle non configuré sur cette machine, mais présent sur ${targetInventory?.machineId || 'cible'}`,
        action: 'Vérifier si model-configs.json doit être collecté'
      });
    }
    return diffs;
  }

  // Pas de profil sur la cible
  if (!targetProfile) {
    diffs.push({
      category: 'roo_config',
      severity: 'WARNING',
      path: 'roo.modelProfile',
      description: `Profil modèle non configuré sur la machine cible (${targetInventory?.machineId || 'inconnue'})`,
      action: 'Exécuter Get-MachineInventory.ps1 sur la machine cible'
    });
    return diffs;
  }

  // Comparer les hashes
  if (sourceProfile.hash !== targetProfile.hash) {
    // Vérifier si les modeApiConfigs diffèrent
    const sourceModes = JSON.stringify(sourceProfile.modeApiConfigs || {});
    const targetModes = JSON.stringify(targetProfile.modeApiConfigs || {});

    if (sourceModes !== targetModes) {
      diffs.push({
        category: 'roo_config',
        severity: 'CRITICAL',
        path: 'roo.modelProfile.modeApiConfigs',
        description: `Configuration des modes différente. Source: ${Object.keys(sourceProfile.modeApiConfigs || {}).length} modes, Cible: ${Object.keys(targetProfile.modeApiConfigs || {}).length} modes`,
        action: 'Synchroniser model-configs.json entre les machines'
      });
    } else {
      diffs.push({
        category: 'roo_config',
        severity: 'IMPORTANT',
        path: 'roo.modelProfile.hash',
        description: `Hash model-configs.json différent (source: ${sourceProfile.hash}, cible: ${targetProfile.hash}) mais modeApiConfigs identiques. Probablement formatage/whitespace.`,
        action: 'Vérifier si la différence est significative'
      });
    }
  }

  // Comparer les profils disponibles
  const sourceProfiles = sourceProfile.profiles || [];
  const targetProfiles = targetProfile.profiles || [];
  const missingProfiles = sourceProfiles.filter((p: string) => !targetProfiles.includes(p));

  if (missingProfiles.length > 0) {
    diffs.push({
      category: 'roo_config',
      severity: 'WARNING',
      path: 'roo.modelProfile.profiles',
      description: `Profils manquants sur la cible: ${missingProfiles.join(', ')}`,
      action: 'Ajouter les profils manquants dans model-configs.json'
    });
  }

  // Comparer les seuils de condensation
  const sourceThresholds = sourceProfile.profileThresholds || {};
  const targetThresholds = targetProfile.profileThresholds || {};

  for (const [profile, threshold] of Object.entries(sourceThresholds)) {
    if (targetThresholds[profile] !== threshold) {
      diffs.push({
        category: 'roo_config',
        severity: 'IMPORTANT',
        path: `roo.modelProfile.profileThresholds.${profile}`,
        description: `Seuil condensation ${profile}: source=${threshold}%, cible=${targetThresholds[profile] || 'non défini'}%`,
        action: 'Harmoniser les seuils de condensation (#502)'
      });
    }
  }

  return diffs;
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

Modes de granularité :
- mcp: Compare uniquement les configurations MCP
- mode: Compare uniquement les modes Roo
- settings: Compare les settings Roo (state.vscdb) entre machines (#547)
- claude: Compare la configuration Claude Code (~/.claude.json) entre machines
- modes-yaml: Compare le custom_modes.yaml global entre machines
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
        enum: ['mcp', 'mode', 'settings', 'claude', 'modes-yaml', 'full'],
        description: 'Niveau de granularité: mcp (MCPs uniquement), mode (modes Roo), settings (Roo settings state.vscdb), claude (config Claude Code ~/.claude.json), modes-yaml (custom_modes.yaml global), full (comparaison complète)'
      },
      filter: {
        type: 'string',
        description: 'Filtre optionnel sur les paths (ex: "jupyter" pour filtrer un MCP spécifique)'
      }
    },
    additionalProperties: false
  }
};