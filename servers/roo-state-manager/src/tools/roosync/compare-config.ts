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
import { createHash } from 'crypto';
import { getRooSyncService, RooSyncServiceError } from '../../services/lazy-roosync.js';
import { GranularDiffDetector } from '../../services/GranularDiffDetector.js';
import type { GranularDiffReport, GranularDiffResult } from '../../services/GranularDiffDetector.js';
import { RooSettingsService, SYNC_SAFE_KEYS } from '../../services/RooSettingsService.js';
import { promises as fsPromises } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * #3044 — VibeSync: surface source/target values for each diff so the caller
 * can arbitrage harmonization without opening config files manually.
 *
 * Helpers below mask secrets, truncate long values, and build the
 * `harmonization_candidates` section that groups diffs by kind.
 */
const MAX_VALUE_LENGTH = 200;

const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /API_KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSPHRASE/i,
  /CREDENTIAL/i,
  /PRIVATE_KEY/i,
  /BEARER/i,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some(p => p.test(key));
}

function isSensitivePath(path: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some(p => p.test(path));
}

/**
 * Produce a secret-safe digest: `<set:len=N:sha256=hash8>` or `<unset>` / `<empty>`.
 * The hash lets the caller decide "same secret on both sides?" without ever
 * seeing the cleartext — that's the arbitration signal VibeSync needs.
 */
function maskSecretValue(value: unknown): string {
  if (value === null || value === undefined) return '<unset>';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str === undefined) return '<unset>';
  if (str.length === 0) return '<empty>';
  const hash = createHash('sha256').update(str).digest('hex').substring(0, 8);
  return `<set:len=${str.length}:sha256=${hash}>`;
}

/**
 * Recursively walk an object/array and replace values whose key matches a
 * sensitive pattern with their masked digest. Top-level scalar values that
 * live at a sensitive path are handled by the caller via `maskSecretValue`.
 */
function maskSensitiveInObject(value: any, currentPath: string): any {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v, i) => maskSensitiveInObject(v, `${currentPath}[${i}]`));
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    const childPath = currentPath ? `${currentPath}.${k}` : k;
    if (isSensitiveKey(k)) {
      out[k] = maskSecretValue(v);
    } else {
      out[k] = maskSensitiveInObject(v, childPath);
    }
  }
  return out;
}

/**
 * Truncate a string in the middle: keep `headRatio` of the budget at the
 * start and `tailRatio` at the end, with `[...]` as the cut marker.
 *
 * Why head+tail and not head-only: the case d'usage principal of
 * `compare_config` is to arbitrage config paths between machines, and the
 * discriminant part of a path is usually at the end
 * (`.../build/index.js` vs `.../build/src/index.js`). Head-only ate it.
 *
 * Ratios come from the original #949 implementation (60 % head, 30 % tail,
 * 10 % slack for the marker). Consigné sur #3044.
 */
const TRUNC_MARKER = '[...]';
const TRUNC_HEAD_RATIO = 0.6;
const TRUNC_TAIL_RATIO = 0.3;

function truncateMiddle(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const budget = maxLen - TRUNC_MARKER.length;
  if (budget <= 0) return TRUNC_MARKER;
  const headLen = Math.max(1, Math.floor(budget * TRUNC_HEAD_RATIO));
  const tailLen = Math.max(1, Math.floor(budget * TRUNC_TAIL_RATIO));
  return s.substring(0, headLen) + TRUNC_MARKER + s.substring(s.length - tailLen);
}

/**
 * Format a value for VibeSync display: masks secrets (whole value if path is
 * sensitive, or recursively walks to mask nested sensitive keys), then
 * truncates the result to ~MAX_VALUE_LENGTH chars.
 *
 * Returns `undefined` for `undefined` so the JSON output simply omits the
 * field — preserving backward compatibility for diffs that have only one side.
 */
function formatValue(value: any, path: string): string | undefined {
  if (value === undefined) return undefined;
  let prepared: any;
  if (isSensitivePath(path)) {
    return maskSecretValue(value);
  }
  prepared = maskSensitiveInObject(value, path);
  if (typeof prepared === 'string') {
    // -2 for the surrounding quotes
    return `"${truncateMiddle(prepared, MAX_VALUE_LENGTH - 2)}"`;
  }
  if (prepared === null) return 'null';
  if (typeof prepared === 'number' || typeof prepared === 'boolean') return String(prepared);
  // Object/array — JSON-stringify, then truncate
  const json = JSON.stringify(prepared);
  if (json === undefined) return undefined;
  return truncateMiddle(json, MAX_VALUE_LENGTH);
}

/**
 * Diff shape extended for VibeSync (#3044). `source_value`/`target_value`
 * are pre-formatted strings (masked + truncated) ready for direct display.
 */
interface VibeSyncDiff {
  category: string;
  severity: string;
  path: string;
  description: string;
  action?: string;
  source_value?: string;
  target_value?: string;
}

interface HarmonizationCandidateBase {
  path: string;
  severity: string;
  source_value?: string;
  target_value?: string;
  description: string;
}
interface PresentAbsentCandidate extends HarmonizationCandidateBase {
  kind: 'present_absent';
}
interface DivergentValueCandidate extends HarmonizationCandidateBase {
  kind: 'divergent_value';
}
type HarmonizationCandidate = PresentAbsentCandidate | DivergentValueCandidate;

interface HarmonizationCandidates {
  present_absent: PresentAbsentCandidate[];
  divergent_value: DivergentValueCandidate[];
  summary: { total: number; present_absent: number; divergent_value: number };
}

/**
 * Group value-bearing diffs into harmonization buckets. Diffs without any
 * formatted value (env diagnostics, roster checks, model profile hashes that
 * embed values in prose) are skipped — they aren't per-side arbitrable.
 */
function buildHarmonizationCandidates(diffs: VibeSyncDiff[]): HarmonizationCandidates {
  const present_absent: PresentAbsentCandidate[] = [];
  const divergent_value: DivergentValueCandidate[] = [];
  for (const d of diffs) {
    if (d.source_value === undefined && d.target_value === undefined) continue;
    const isPresentAbsent = d.source_value === undefined || d.target_value === undefined;
    const base = {
      path: d.path,
      severity: d.severity,
      source_value: d.source_value,
      target_value: d.target_value,
      description: d.description,
    };
    if (isPresentAbsent) {
      present_absent.push({ ...base, kind: 'present_absent' as const });
    } else {
      divergent_value.push({ ...base, kind: 'divergent_value' as const });
    }
  }
  return {
    present_absent,
    divergent_value,
    summary: {
      total: present_absent.length + divergent_value.length,
      present_absent: present_absent.length,
      divergent_value: divergent_value.length,
    },
  };
}

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
 * Machine-specific field patterns that are EXPECTED to differ between machines.
 * These get auto-downgraded from CRITICAL/IMPORTANT to INFO to reduce noise.
 * @see #2307 - False-positive filtering for cross-machine config comparison
 * @see #2963 - Extended to include system.os / system.architecture which are
 * material facts of each machine (the fleet runs mixed Win11/Win10 and x64/ARM64).
 * Previously these surfaced as 2 CRITICAL drifts that buried 8 IMPORTANT + 220 WARNING.
 */
const EXPECTED_MACHINE_FIELDS: RegExp[] = [
  /(^|\.)hostname$/,           // systemInfo.hostname — always different
  /(^|\.)uptime$/,             // systemInfo.uptime — monotonic clock, always different
  /(^|\.)machineId$/,          // machine identifier
  /(^|\.)(timestamp|collectedAt|lastUpdated|createdAt|firstSeen|lastHeartbeat|retrievedAt)$/, // timestamps
  /(^|\.)totalMemory$/,        // hardware — can differ
  /(^|\.)freeMemory$/,         // runtime memory — always different
  /(^|\.)cwd$/,                // process.cwd() — different install paths
  /\.envVars\.cwd$/,
  /\.systemInfo\./,            // all systemInfo subfields are machine-specific
  // #2963: OS / arch / OS version are material facts of each machine — reporting
  // them as CRITICAL drift buried the real signal under false-positive noise.
  /(^|\.)os$/,                 // system.os, systemInfo.os
  /(^|\.)architecture$/,       // system.architecture
  /(^|\.)osVersion$/,          // system.osVersion
  /(^|\.)platform$/,           // system.platform (win32/linux/darwin)
  /(^|\.)arch$/,               // system.arch (x64/arm64/ia32)
];

/**
 * Check if a diff path matches an expected machine-specific field.
 * If so, downgrade severity to INFO. Preserves VibeSync value fields (#3044).
 */
function applyMachineFieldFilter(diff: VibeSyncDiff): VibeSyncDiff {
  for (const pattern of EXPECTED_MACHINE_FIELDS) {
    if (pattern.test(diff.path)) {
      return {
        ...diff,
        severity: 'INFO',
        description: `[EXPECTED] ${diff.description}`,
        action: undefined,
      };
    }
  }
  return diff;
}

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
    .describe('Filtre optionnel sur les paths (ex: "jupyter" pour filtrer un MCP spécifique)'),
  detail: z.enum(['values', 'paths']).optional()
    .describe('Niveau de détail du rendu (#3044). values (défaut) — chaque diff inclut source_value/target_value (valeurs masquées + tronquées) + section harmonization_candidates regroupant les écarts par type. paths — rendu historique (paths + description seulement, moins volumineux).')
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
    action: z.string().optional().describe('Action recommandée'),
    source_value: z.string().optional().describe('Valeur côté source, formatée (secrets masqués, tronquée ~200 chars). Uniquement en detail=values (défaut). #3044'),
    target_value: z.string().optional().describe('Valeur côté cible, formatée (secrets masqués, tronquée ~200 chars). Uniquement en detail=values (défaut). #3044')
  })).describe('Liste des différences détectées'),
  summary: z.object({
    total: z.number().describe('Nombre total de différences'),
    critical: z.number().describe('Différences critiques'),
    important: z.number().describe('Différences importantes'),
    warning: z.number().describe('Avertissements'),
    info: z.number().describe('Informations')
  }).describe('Résumé des différences'),
  harmonization_candidates: z.object({
    present_absent: z.array(z.object({
      path: z.string(),
      kind: z.literal('present_absent'),
      severity: z.string(),
      source_value: z.string().optional(),
      target_value: z.string().optional(),
      description: z.string()
    })).describe('Écarts où un côté a la valeur et l\'autre non (ajout/suppression) — candidats « adopter ou pas »'),
    divergent_value: z.array(z.object({
      path: z.string(),
      kind: z.literal('divergent_value'),
      severity: z.string(),
      source_value: z.string().optional(),
      target_value: z.string().optional(),
      description: z.string()
    })).describe('Écarts où les deux côtés ont une valeur mais elle diffère — candidats « aligner sur A ou B »'),
    summary: z.object({
      total: z.number(),
      present_absent: z.number(),
      divergent_value: z.number()
    })
  }).optional().describe('Candidats d\'harmonisation regroupés par type (#3044). Uniquement en detail=values (défaut).')
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

    // #alias-validation: catch partial-alias typos before the misleading downstream
    // "inventory missing" CRITICAL. Only "local-machine" is a recognized alias (L181);
    // a literal "local"/"remote" resolves to nothing, then getInventory() looks for
    // inventories/local.json (absent) and returns a generic CRITICAL. This gives the
    // caller an actionable message instead.
    const PARTIAL_ALIASES: Record<string, string> = {
      'local': 'local-machine',
      'remote': 'remote-machine',
    };
    const aliasIssues: string[] = [];
    if (PARTIAL_ALIASES[sourceMachineId]) {
      aliasIssues.push(`source "${sourceMachineId}" — vouliez-vous l'alias "${PARTIAL_ALIASES[sourceMachineId]}" ?`);
    }
    if (PARTIAL_ALIASES[targetMachineId]) {
      aliasIssues.push(`target "${targetMachineId}" — vouliez-vous l'alias "${PARTIAL_ALIASES[targetMachineId]}" ?`);
    }
    if (aliasIssues.length > 0) {
      return {
        source: sourceMachineId,
        target: targetMachineId,
        granularity: args.granularity || 'full',
        differences: [{
          category: 'validation',
          severity: 'CRITICAL',
          path: 'input.machineId',
          description: `machineId inconnu: ${aliasIssues.join('; ')}. Le seul alias reconnu est "local-machine" (résolu vers la machine locale). Les machines distantes s'adressent par leur machineId (ex: "myia-ai-01", "myia-po-2024").`,
          action: 'Utiliser "local-machine" pour la machine locale, ou un vrai machineId pour une machine distante.'
        }],
        summary: { total: 1, critical: 1, important: 0, warning: 0, info: 0 }
      };
    }

    // Settings comparison: uses RooSettingsService + GDrive published settings
    if (args.granularity === 'settings') {
      const detail = args.detail ?? 'values';
      const settingsResult = await compareSettings(sourceMachineId, targetMachineId, service, args.filter, detail);
      return withRosterCheck(settingsResult, config, service);
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

      // #2963 (rule #2): Ne jamais rendre un diff contre une source absente.
      // Si la section comparée (ex: mcpServers) est vide {} d'un côté mais peuplée
      // de l'autre, le diff "X supprimés" est un artefact de collecte dégradée, pas
      // un vrai drift. On lève un statut au lieu de lister des suppressions fantômes
      // qui orienteraient une décision (cas historique: "7 MCP supprimés" dont
      // win-cli et roo-state-manager lorsque le mcp_settings.json cible n'était pas
      // lu). On ne déclenche ce statut QUE lorsqu'au moins un côté est non-vide,
      // pour préserver le vrai signal "les deux n'ont aucun MCP configuré".
      const preFlightSectionPaths: Record<string, string[]> = {
        mcp: ['inventory.mcpServers', 'roo.mcpServers', 'mcpServers'],
        mode: ['inventory.rooModes', 'roo.modes', 'rooModes'],
        'modes-yaml': ['inventory.rooModes', 'roo.modes', 'rooModes'],
        claude: ['inventory.claudeConfig', 'claudeConfig'],
      };
      const sectionPaths = preFlightSectionPaths[args.granularity];
      if (sectionPaths) {
        const resolveSectionSize = (inv: any): number => {
          for (const p of sectionPaths) {
            const segs = p.split('.');
            let cur: any = inv;
            for (const s of segs) cur = cur?.[s];
            if (cur && typeof cur === 'object') return Object.keys(cur).length;
          }
          return 0;
        };
        const sourceSectionSize = resolveSectionSize(sourceInventory);
        const targetSectionSize = resolveSectionSize(targetInventory);

        if (sourceSectionSize > 0 && targetSectionSize === 0) {
          return {
            source: sourceMachineId,
            target: targetMachineId,
            granularity: args.granularity,
            differences: [{
              category: 'inventory',
              severity: 'WARNING',
              path: sectionPaths.map(p => `target.${p}`).join(' | '),
              description: `Section "${args.granularity}" vide côté cible (${targetMachineId}) mais peuplée côté source (${sourceSectionSize} entrées). Le diff "suppression de ${sourceSectionSize} éléments" serait un artefact de collecte dégradée, pas un drift réel — très probablement mcp_settings.json / inventory non lu chez la cible. Aucun diff n'est émis tant que la collecte cible n'est pas restaurée.`,
              action: `Vérifier que l'inventaire de ${targetMachineId} est à jour (Get-MachineInventory.ps1) et que les sections ${args.granularity} sont bien peuplées avant de relancer la comparaison.`
            }],
            summary: { total: 1, critical: 0, important: 0, warning: 1, info: 0 }
          };
        }
        if (targetSectionSize > 0 && sourceSectionSize === 0) {
          return {
            source: sourceMachineId,
            target: targetMachineId,
            granularity: args.granularity,
            differences: [{
              category: 'inventory',
              severity: 'WARNING',
              path: sectionPaths.map(p => `source.${p}`).join(' | '),
              description: `Section "${args.granularity}" vide côté source (${sourceMachineId}) mais peuplée côté cible (${targetSectionSize} entrées). Le diff "ajout de ${targetSectionSize} éléments" serait un artefact de collecte dégradée. Aucun diff n'est émis tant que la collecte source n'est pas restaurée.`,
              action: `Vérifier que l'inventaire de ${sourceMachineId} est à jour (Get-MachineInventory.ps1) et que les sections ${args.granularity} sont bien peuplées avant de relancer la comparaison.`
            }],
            summary: { total: 1, critical: 0, important: 0, warning: 1, info: 0 }
          };
        }
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

      // #3044 — détail du rendu: values (défaut) surface source_value/target_value
      // + harmonization_candidates ; paths conserve le rendu historique.
      const detail = args.detail ?? 'values';

      // Convertir au format CompareConfigResult (avec comparaison model profiles #498)
      return withRosterCheck(
        formatGranularReport(
          granularReport,
          filteredDiffs,
          sourceMachineId,
          targetMachineId,
          args.granularity,
          sourceInventory,
          targetInventory,
          detail
        ),
        config,
        service
      );
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
    return withRosterCheck(formatComparisonReport(report, 'full'), config, service);
    
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
  filter?: string,
  detail: 'values' | 'paths' = 'values'
): Promise<CompareConfigResult> {
  const differences: VibeSyncDiff[] = [];

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
  const includeValues = detail === 'values';

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
      action: catInfo.severity === 'CRITICAL' ? 'Synchroniser ce paramètre' : undefined,
      // #3044 — expose structured values (masked + truncated) for direct arbitration
      source_value: includeValues ? formatValue(sourceVal, path) : undefined,
      target_value: includeValues ? formatValue(targetVal, path) : undefined,
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

  const result: CompareConfigResult = {
    source: sourceLabel,
    target: `${targetMachineId} (published)`,
    granularity: 'settings',
    host_id: config.machineId,
    differences,
    summary
  };

  if (includeValues) {
    result.harmonization_candidates = buildHarmonizationCandidates(differences);
  }

  return result;
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

  const rawDifferences = [
    ...report.differences.map((diff: any) => ({
      category: diff.category,
      severity: diff.severity,
      path: diff.path,
      description: diff.description,
      action: diff.recommendedAction
    })),
    ...envDiffs
  ];

  // #1410: Deduplicate — compareRealConfigurations compares each machine vs baseline,
  // then combines. Same diff on both machines produces duplicates.
  // Dedup key = (category, path, description).
  const seen = new Set<string>();
  const dedupedDiffs = rawDifferences.filter(diff => {
    const dedupKey = `${diff.category}|${diff.path}|${diff.description}`;
    if (seen.has(dedupKey)) return false;
    seen.add(dedupKey);
    return true;
  });

  // #2307: Downgrade machine-specific fields to INFO
  const allDifferences = dedupedDiffs.map(diff => applyMachineFieldFilter(diff));

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
  targetInventory?: any,
  detail: 'values' | 'paths' = 'values'
): CompareConfigResult {
  // Vérifier les variables d'environnement critiques manquantes (#495)
  const envDiffs = checkMissingEnvVars();

  // #498: Comparer les profils de modèle
  const modelProfileDiffs = compareModelProfiles(sourceInventory, targetInventory);

  // #3044 — For each granular diff, attach formatted source/target values.
  // GranularDiffDetector sets oldValue = source side, newValue = target side
  // (verified in performGranularComparison: 'added' = source→target où source
  // est undefined, 'removed' = source défini, 'modified' = les deux).
  const includeValues = detail === 'values';

  const allDifferences: VibeSyncDiff[] = [
    ...filteredDiffs.map(diff => applyMachineFieldFilter({
      category: diff.category,
      severity: diff.severity,
      path: diff.path,
      description: diff.description,
      action: getRecommendedAction(diff),
      source_value: includeValues ? formatValue(diff.oldValue, diff.path) : undefined,
      target_value: includeValues ? formatValue(diff.newValue, diff.path) : undefined,
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

  const result: CompareConfigResult = {
    source: sourceMachineId,
    target: targetMachineId,
    granularity,
    host_id: report.sourceLabel,
    differences: allDifferences,
    summary
  };

  if (includeValues) {
    result.harmonization_candidates = buildHarmonizationCandidates(allDifferences);
  }

  return result;
}

/**
 * Merge les diffs de cohérence roster (#2570) dans un CompareConfigResult déjà construit,
 * puis recalcule le summary. Garde les formatters synchrones — l'appelant (async) await ce helper.
 */
async function withRosterCheck(
  result: CompareConfigResult,
  config: any,
  service: any
): Promise<CompareConfigResult> {
  try {
    const rosterDiffs = await checkRosterConsistency(config, service);
    if (rosterDiffs.length === 0) return result;

    // Éviter le doublon si un diff roster existe déjà (path env.ROO_FLEET_ROSTER)
    const existingPaths = new Set(result.differences.map(d => d.path));
    const newDiffs = rosterDiffs.filter(d => !existingPaths.has(d.path));

    const allDifferences = [...result.differences, ...newDiffs];
    return {
      ...result,
      differences: allDifferences,
      summary: {
        total: allDifferences.length,
        critical: allDifferences.filter(d => d.severity === 'CRITICAL').length,
        important: allDifferences.filter(d => d.severity === 'IMPORTANT').length,
        warning: allDifferences.filter(d => d.severity === 'WARNING').length,
        info: allDifferences.filter(d => d.severity === 'INFO').length
      }
    };
  } catch {
    // Le check roster ne doit JAMAIS casser compare_config — c'est un diagnostic additionnel
    return result;
  }
}

/**
 * Check la cohérence du ROO_FLEET_ROSTER local contre les machines connues du dashboard (#2570).
 *
 * Le roster (env var) drive le hash-based task-space partitioning (task-partition.ts).
 * Il n'a aucune source-of-truth dans le repo ni dans les inventory snapshots GDrive,
 * donc le drift entre machines passe silencieusement (certaines 5-machine, d'autres unset).
 * Le dashboard partagé est la seule source canonique des machines vivantes de la flotte.
 *
 * @param config Config RooSync (contient fleetRoster parsé + machineId)
 * @param service RooSyncService (pour loadDashboard)
 * @returns Diff(s) si le roster local diverge des machines du dashboard, [] sinon
 */
async function checkRosterConsistency(
  config: any,
  service: any
): Promise<Array<{
  category: string;
  severity: string;
  path: string;
  description: string;
  action?: string;
}>> {
  const diffs: Array<{
    category: string;
    severity: string;
    path: string;
    description: string;
    action?: string;
  }> = [];

  const localRoster: string[] | null = config?.fleetRoster ?? null;

  // Charger les machines connues du dashboard (source canonique flotte)
  let dashboardMachines: string[] = [];
  try {
    const dashboard = await service.loadDashboard();
    dashboardMachines = Object.keys(dashboard.machines || {}).sort();
  } catch {
    // Dashboard injoignable (GDrive offline) — on ne peut pas comparer, skip silencieux
    return diffs;
  }

  if (dashboardMachines.length === 0) {
    return diffs; // Pas de machines de référence → rien à comparer
  }

  const dashSet = new Set(dashboardMachines);

  if (!localRoster) {
    // Roster unset → partitioning DISABLED (cette machine indexe tout l'espace)
    diffs.push({
      category: 'environment',
      severity: 'WARNING',
      path: 'env.ROO_FLEET_ROSTER',
      description: `ROO_FLEET_ROSTER non défini — partitioning DÉSACTIVÉ. Cette machine indexe la totalité du task-space (pas de shard filtering), tandis que le dashboard voit ${dashboardMachines.length} machines (${dashboardMachines.join(', ')}). Contributeur de redondance d'indexation silencieuse (#2570).`,
      action: `Définir ROO_FLEET_ROSTER="${dashboardMachines.join(',')}" dans ~/.claude.json mcpServers.roo-state-manager.env, puis restart MCP + roosync_indexing(rebuild)`
    });
    return diffs;
  }

  const rosterSet = new Set(localRoster);
  const rosterSorted = [...localRoster].sort();

  // Mismatch de taille (5 vs 6 décale ~tous les buckets — hash % size)
  if (rosterSorted.length !== dashboardMachines.length) {
    const missingFromRoster = dashboardMachines.filter(m => !rosterSet.has(m));
    const extraInRoster = rosterSorted.filter(m => !dashSet.has(m));
    const detail: string[] = [`roster=${rosterSorted.length} (${rosterSorted.join(', ')})`, `dashboard=${dashboardMachines.length} (${dashboardMachines.join(', ')})`];
    if (missingFromRoster.length) detail.push(`manquantes du roster: ${missingFromRoster.join(', ')}`);
    if (extraInRoster.length) detail.push(`absentes du dashboard: ${extraInRoster.join(', ')}`);
    diffs.push({
      category: 'environment',
      severity: 'CRITICAL',
      path: 'env.ROO_FLEET_ROSTER',
      description: `Mismatch taille ROO_FLEET_ROSTER — partition drift. ${detail.join(' | ')}. Un écart de taille (hash % roster.length) décale ~TOUS les buckets, pas seulement le shard de la machine manquante → recall/precision dégradés silencieusement (#2570).`,
      action: `Aligner sur le roster canonique "${dashboardMachines.join(',')}" sur TOUTES les machines simultanément, puis restart MCP + roosync_indexing(rebuild) sur chacune (migration task-partition.ts)`
    });
    return diffs;
  }

  // Même taille mais contenu diffère
  const sameContent = rosterSorted.every((m, i) => m === dashboardMachines[i]);
  if (!sameContent) {
    const missingFromRoster = dashboardMachines.filter(m => !rosterSet.has(m));
    const extraInRoster = rosterSorted.filter(m => !dashSet.has(m));
    diffs.push({
      category: 'environment',
      severity: 'CRITICAL',
      path: 'env.ROO_FLEET_ROSTER',
      description: `Mismatch contenu ROO_FLEET_ROSTER (même taille, membres différents). roster=${rosterSorted.join(', ')} vs dashboard=${dashboardMachines.join(', ')}. Manquantes du roster: ${missingFromRoster.join(',') || 'none'}. Absentes du dashboard: ${extraInRoster.join(',') || 'none'}. → partition drift (#2570).`,
      action: `Aligner sur le roster canonique "${dashboardMachines.join(',')}"`
    });
    return diffs;
  }

  // Roster consistant — signal positif INFO (utile pour l'audit flotte)
  diffs.push({
    category: 'environment',
    severity: 'INFO',
    path: 'env.ROO_FLEET_ROSTER',
    description: `ROO_FLEET_ROSTER consistant avec le dashboard flotte (${rosterSorted.length} machines: ${rosterSorted.join(', ')}). Partitioning sain.`
  });

  return diffs;
}

/**
 * Compare les profils de modèle entre deux machines (#498)
 * Détecte les différences dans model-configs.json
 */
export function compareModelProfiles(
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
  // Robustness: `.profiles` can be a truthy non-array (keyed object / partial
  // shape) when config sync is degraded (e.g. reverse-proxy outage). The `|| []`
  // fallback only guards against falsy, which made `.filter` below throw
  // `sourceProfiles.filter is not a function`. Array.isArray guards both falsy
  // and non-array shapes. (Crash reproduced fleet-wide 2026-06-21 during the
  // po-203 reverse-proxy outage on po-2024 / web1 / po-2026.)
  const sourceProfiles = Array.isArray(sourceProfile.profiles) ? sourceProfile.profiles : [];
  const targetProfiles = Array.isArray(targetProfile.profiles) ? targetProfile.profiles : [];
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
