import { z } from 'zod';
import { getRooSyncService } from '../../services/lazy-roosync.js';
import { ConfigSharingServiceError, ConfigSharingServiceErrorCode } from '../../types/errors.js';
import type { ConfigTarget } from '../../types/config-sharing.js';
import { EnvRotationService } from '../../services/EnvRotationService.js';

/**
 * Claude Code scope pour les configurations MCP
 * Issue #601 - Support scopes officiels Claude Code
 */
export type ClaudeCodeScope = 'user' | 'project' | 'settings';

/**
 * Schema Zod pour roosync_config - Outil unifié de gestion de configuration
 * Issue #601 - Ajout support scope Claude Code
 */
export const ConfigArgsSchema = z.object({
  // Action requise
  action: z.enum(['collect', 'publish', 'apply', 'apply_profile']).describe('Action: collect, publish, apply, or apply_profile'),

  // Paramètres communs
  machineId: z.string().optional().describe('Machine ID (default: ROOSYNC_MACHINE_ID)'),
  dryRun: z.boolean().optional().describe('Simulate without modifying files (default: false)'),

  // Scope Claude Code (#601)
  scope: z.enum(['user', 'project', 'settings']).optional().describe('Claude Code config scope: user (~/.claude.json), project (.mcp.json), settings (~/.claude/settings.json). Default: user'),

  // Pour collect et apply
  targets: z.array(z.string()).optional().refine(
    (targets) => {
      if (!targets) return true;
      return targets.every(target => {
        if (target === 'modes' || target === 'mcp' || target === 'profiles' || target === 'roomodes' || target === 'model-configs' || target === 'rules' || target === 'settings' || target === 'claude-config' || target === 'modes-yaml') {
          return true;
        }
        if (target.startsWith('mcp:')) {
          const serverName = target.slice(4);
          return serverName && serverName.trim() !== '';
        }
        // #2409 — services:<name> target
        if (target.startsWith('services:')) {
          const serviceName = target.slice(9);
          return serviceName && serviceName.trim() !== '';
        }
        // #2410 — env:<service> target for secret rotation
        if (target.startsWith('env:')) {
          const serviceName = target.slice(4);
          return serviceName && serviceName.trim() !== '';
        }
        return false;
      });
    },
    {
      message: "Target invalide. Valeurs acceptées: modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, mcp:<server>, services:<name>, env:<service>"
    }
  ).describe('Targets: modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, mcp:<server>, services:<name>, env:<service>. Default: ["modes", "mcp"]'),

  // Pour publish (requiert collect préalable OU packagePath)
  packagePath: z.string().optional().describe('Package path from collect. If omitted with publish+targets, does collect+publish atomically'),
  version: z.string().optional().describe('Config version (e.g., "2.3.0"). Required for publish'),
  description: z.string().optional().describe('Change description. Required for publish'),

  // Pour apply
  backup: z.boolean().optional().describe('Create local backup before apply (default: true). For apply and apply_profile'),

  // #2413 — Pour apply et apply_profile : validation post-apply
  validate: z.boolean().optional().describe('Validate config is effectively applied after write (default: false). For apply and apply_profile. Profile validation reads .roomodes and state.vscdb.currentApiConfigName.'),

  // Pour apply_profile (#498 Phase 2)
  profileName: z.string().optional().describe('Profile name (required for apply_profile). E.g. "Production (Qwen 3.5 + GLM-5)"'),
  sourceMachineId: z.string().optional().describe('Source machine ID for model-configs.json (default: local file)')
}).refine(
  (data) => {
    // Validation spécifique par action
    if (data.action === 'publish') {
      // publish requiert version et description
      if (!data.version || !data.description) {
        return false;
      }
      // publish requiert soit packagePath, soit targets (pour collect+publish atomique)
      if (!data.packagePath && !data.targets) {
        return false;
      }
    }
    if (data.action === 'apply_profile') {
      // apply_profile requiert profileName
      if (!data.profileName) {
        return false;
      }
    }
    return true;
  },
  {
    message: "Pour action=publish: 'version' et 'description' requis + 'packagePath' OU 'targets'. Pour action=apply_profile: 'profileName' requis."
  }
);

export type ConfigArgs = z.infer<typeof ConfigArgsSchema>;

/**
 * Parse et valide les targets de configuration
 * @param targets - Liste des targets à parser
 * @returns Liste des targets validés
 * @throws ConfigSharingServiceError si un target est invalide
 */
function parseTargets(targets?: string[]): ('modes' | 'mcp' | 'profiles' | `mcp:${string}` | `services:${string}` | `env:${string}`)[] {
  if (!targets) return [];

  return targets.map(target => {
    if (target.startsWith('mcp:')) {
      const serverName = target.slice(4);
      if (!serverName || serverName.trim() === '') {
        throw new ConfigSharingServiceError(
          `Format de target MCP invalide: '${target}'. Le nom du serveur ne peut pas être vide.`,
          ConfigSharingServiceErrorCode.INVALID_TARGET_FORMAT,
          { target }
        );
      }
      return target as `mcp:${string}`;
    }

    // #2409 — services:<name> target
    if (target.startsWith('services:')) {
      const serviceName = target.slice(9);
      if (!serviceName || serviceName.trim() === '') {
        throw new ConfigSharingServiceError(
          `Format de target services invalide: '${target}'. Le nom du service ne peut pas être vide.`,
          ConfigSharingServiceErrorCode.INVALID_TARGET_FORMAT,
          { target }
        );
      }
      return target as `services:${string}`;
    }

    // #2410 — env:<service> target for secret rotation
    if (target.startsWith('env:')) {
      const serviceName = target.slice(4);
      if (!serviceName || serviceName.trim() === '') {
        throw new ConfigSharingServiceError(
          `Format de target env invalide: '${target}'. Le nom du service ne peut pas être vide.`,
          ConfigSharingServiceErrorCode.INVALID_TARGET_FORMAT,
          { target }
        );
      }
      return target as `env:${string}`;
    }

    if (target === 'modes' || target === 'mcp' || target === 'profiles' || target === 'roomodes' || target === 'model-configs' || target === 'rules' || target === 'settings' || target === 'claude-config' || target === 'modes-yaml') {
      return target as any;
    }

    throw new ConfigSharingServiceError(
      `Target invalide: '${target}'. Valeurs acceptées: modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, mcp:<nomServeur>, services:<nomService>, env:<nomService>`,
      ConfigSharingServiceErrorCode.INVALID_TARGET_FORMAT,
      { target }
    );
  });
}

/**
 * Gestion de configuration RooSync (collect, publish, apply)
 *
 * @param args - Arguments avec action ('collect', 'publish', ou 'apply')
 * @returns Résultat de l'opération avec status et données spécifiques à l'action
 * @throws ConfigSharingServiceError en cas d'erreur
 */
export async function roosyncConfig(args: ConfigArgs) {
  const { action, machineId, dryRun = false, scope } = args;

  try {
    const rooSyncService = await getRooSyncService();
    const configSharingService = rooSyncService.getConfigSharingService();

    // #2410 — Env rotation short-circuit (different workflow: encrypt direct, no file collect)
    const envTargets = (args.targets || []).filter((t: string) => t.startsWith('env:'));
    if (envTargets.length > 0) {
      const envService = new EnvRotationService();
      const configService = rooSyncService.getConfigService();
      const sharedStatePath = configService.getSharedStatePath();

      if (action === 'publish') {
        const { version, description } = args;
        if (!version || !description) {
          throw new ConfigSharingServiceError(
            "env: publish requiert 'version' et 'description'",
            ConfigSharingServiceErrorCode.INVALID_TARGET_FORMAT,
            { targets: envTargets }
          );
        }
        const results = [];
        for (const target of envTargets) {
          const serviceName = target.slice(4);
          // Default .env path: same directory as roo-state-manager
          const envPath = process.env[`${serviceName.toUpperCase()}_ENV_PATH`]
            || `config/${serviceName}/.env`;
          const result = await envService.publish({
            service: serviceName,
            envPath,
            sharedStatePath,
            version,
            description,
            machineId: machineId || process.env.ROOSYNC_MACHINE_ID || process.env.COMPUTERNAME || 'unknown',
            dryRun,
          });
          results.push(result);
        }
        return { status: 'success', results };
      }

      if (action === 'apply') {
        const { backup = true } = args;
        const results = [];
        for (const target of envTargets) {
          const serviceName = target.slice(4);
          const targetEnvPath = process.env[`${serviceName.toUpperCase()}_ENV_PATH`]
            || `config/${serviceName}/.env`;
          const result = await envService.apply({
            service: serviceName,
            targetEnvPath,
            sharedStatePath,
            backup,
            dryRun,
          });
          results.push(result);
        }
        return { status: 'success', results };
      }

      // collect not applicable for env (use publish directly)
      return {
        status: 'warning',
        message: 'env: targets use publish/apply only. Collect is not applicable for encrypted secrets.',
      };
    }

    switch (action) {
      case 'collect': {
        // Action collect: Collecte la configuration locale
        const { targets = ['modes', 'mcp'] } = args;

        const result = await configSharingService.collectConfig({
          targets: targets as ConfigTarget[],
          dryRun,
          scope // Issue #601 - Pass scope to collect
        });

        if (result.filesCount === 0) {
          return {
            status: 'warning',
            message: `Aucun fichier collecté pour les targets: ${targets.join(', ')}. Vérifiez que les répertoires sources existent.`,
            packagePath: result.packagePath,
            totalSize: result.totalSize,
            manifest: result.manifest
          };
        }

        return {
          status: 'success',
          message: `Configuration collectée avec succès (${result.filesCount} fichiers)`,
          packagePath: result.packagePath,
          totalSize: result.totalSize,
          manifest: result.manifest
        };
      }

      case 'publish': {
        // Action publish: Publie vers le stockage partagé
        const { version, description, packagePath, targets } = args;

        // Workflow atomique collect+publish si targets fourni sans packagePath
        let finalPackagePath = packagePath;
        if (!packagePath && targets) {
          // Collect automatique
          const collectResult = await configSharingService.collectConfig({
            targets: targets as ConfigTarget[],
            dryRun,
            scope // Issue #601 - Pass scope to collect
          });
          finalPackagePath = collectResult.packagePath;
        }

        if (!finalPackagePath) {
          throw new ConfigSharingServiceError(
            'packagePath requis pour publish (ou fournir targets pour collect+publish atomique)',
            ConfigSharingServiceErrorCode.PUBLISH_FAILED,
            { args }
          );
        }

        const result = await configSharingService.publishConfig({
          packagePath: finalPackagePath,
          version: version!,
          description: description!,
          machineId
        });

        return {
          status: 'success',
          message: `Configuration publiée avec succès pour la machine ${result.machineId || 'locale'}`,
          version: result.version,
          targetPath: result.path,
          machineId: result.machineId
        };
      }

      case 'apply': {
        // Action apply: Applique une configuration depuis le stockage
        const { version, targets, backup = true, validate } = args;

        // Vérifier la version de configuration requise
        const configService = rooSyncService.getConfigService();
        const currentVersion = await configService.getConfigVersion();

        // Bug #305: Gérer le cas où currentVersion est null
        if (version && version !== 'latest') {
          if (currentVersion) {
            // Comparer les versions majeures (premier chiffre)
            const currentMajor = parseInt(currentVersion.split('.')[0], 10);
            const requestedMajor = parseInt(version.split('.')[0], 10);

            if (currentMajor !== requestedMajor) {
              throw new ConfigSharingServiceError(
                `Incompatibilité de version de configuration: actuelle=${currentVersion}, requise=${version}`,
                ConfigSharingServiceErrorCode.COLLECTION_FAILED,
                {
                  currentVersion,
                  requestedVersion: version,
                  currentMajor,
                  requestedMajor,
                  suggestion: `Utilisez 'latest' ou une version compatible (v${currentMajor}.x.x)`
                }
              );
            }
          }
        }

        const result = await configSharingService.applyConfig({
          version,
          machineId,
          targets: parseTargets(targets),
          backup,
          dryRun,
          scope, // Issue #601 - Pass scope to apply
          validate // #2413 - Propagate validate flag
        });

        // #2413 — Si validation activée et drift détecté, marquer le statut comme drift
        const validationFailed = !!result.validation && result.validation.success === false;
        const overallSuccess = result.success && !validationFailed;

        return {
          status: overallSuccess ? 'success' : (validationFailed ? 'drift' : 'error'),
          message: overallSuccess
            ? (result.validation ? 'Configuration appliquée et validée avec succès' : 'Configuration appliquée avec succès')
            : (validationFailed ? 'Configuration appliquée mais drift détecté lors de la validation' : 'Échec de l\'application de la configuration'),
          filesApplied: result.filesApplied,
          backupPath: result.backupPath,
          errors: result.errors,
          validation: result.validation
        };
      }

      case 'apply_profile': {
        // Action apply_profile: Applique un profil de modèle (#498 Phase 2)
        const { profileName, sourceMachineId, backup = true, validate } = args;

        if (!profileName) {
          throw new ConfigSharingServiceError(
            'profileName est requis pour action=apply_profile',
            ConfigSharingServiceErrorCode.COLLECTION_FAILED,
            { args }
          );
        }

        const result = await configSharingService.applyProfile({
          profileName,
          sourceMachineId,
          backup,
          dryRun,
          validate // #2413 - Propagate validate flag
        });

        const modesMsg = result.roomodesGenerated
          ? ` + .roomodes régénéré`
          : result.errors?.some(e => e.includes('génération') || e.includes('generation'))
            ? ` (⚠️ .roomodes non régénéré)`
            : '';

        // #2413 — Si validation activée et drift détecté, statut "drift" (pas pure error)
        const validationFailed = !!result.validation && result.validation.success === false;
        const validationMsg = result.validation
          ? (result.validation.success ? ' + validation OK' : ` + drift détecté (${result.validation.drift?.length || 0} entrées)`)
          : '';

        return {
          status: !result.success
            ? 'error'
            : (validationFailed ? 'drift' : 'success'),
          message: result.success
            ? `Profil '${result.profileName}' appliqué avec succès (${result.modesConfigured} modes, ${result.apiConfigsCount} configs API${modesMsg}${validationMsg})`
            : `Échec de l'application du profil '${result.profileName}'`,
          profileName: result.profileName,
          modesConfigured: result.modesConfigured,
          apiConfigsCount: result.apiConfigsCount,
          backupPath: result.backupPath,
          changes: result.changes,
          roomodesGenerated: result.roomodesGenerated,
          errors: result.errors,
          validation: result.validation
        };
      }

      default:
        throw new ConfigSharingServiceError(
          `Action invalide: ${action}. Valeurs acceptées: collect, publish, apply, apply_profile`,
          ConfigSharingServiceErrorCode.COLLECTION_FAILED,
          { action }
        );
    }
  } catch (error) {
    if (error instanceof ConfigSharingServiceError) {
      throw error;
    }
    const errorCode = action === 'publish' ? ConfigSharingServiceErrorCode.PUBLISH_FAILED
      : ConfigSharingServiceErrorCode.COLLECTION_FAILED;
    throw new ConfigSharingServiceError(
      `Erreur lors de l'opération ${action}: ${error instanceof Error ? error.message : String(error)}`,
      errorCode,
      { originalError: error instanceof Error ? error.message : String(error), args }
    );
  }
}
