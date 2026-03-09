import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { ConfigSharingServiceError, ConfigSharingServiceErrorCode } from '../../types/errors.js';

/**
 * Schema Zod pour roosync_config - Outil unifié de gestion de configuration
 */
export const ConfigArgsSchema = z.object({
  // Action requise
  action: z.enum(['collect', 'publish', 'apply', 'apply_profile']).describe('Action à effectuer: collect (collecte config locale), publish (publication vers GDrive), apply (application depuis GDrive), apply_profile (appliquer un profil de modèle)'),

  // Paramètres communs
  machineId: z.string().optional().describe('ID de la machine (optionnel, utilise ROOSYNC_MACHINE_ID par défaut)'),
  dryRun: z.boolean().optional().describe('Si true, simule l\'opération sans modifier les fichiers. Défaut: false'),

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
        return false;
      });
    },
    {
      message: "Target invalide. Valeurs acceptées: modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, ou mcp:<nomServeur>"
    }
  ).describe('Liste des cibles à collecter/appliquer (modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, ou mcp:<nomServeur>). Défaut: ["modes", "mcp"]'),

  // Pour publish (requiert collect préalable OU packagePath)
  packagePath: z.string().optional().describe('Chemin du package créé par collect. Si omis avec action=publish et targets fourni, fait collect+publish atomique'),
  version: z.string().optional().describe('Version de la configuration (ex: "2.3.0"). Requis pour action=publish'),
  description: z.string().optional().describe('Description des changements. Requis pour action=publish'),

  // Pour apply
  backup: z.boolean().optional().describe('Créer un backup local avant application (défaut: true). Pour action=apply et apply_profile'),

  // Pour apply_profile (#498 Phase 2)
  profileName: z.string().optional().describe('Nom du profil à appliquer (requis pour action=apply_profile). Ex: "Production (Qwen 3.5 local + GLM-5 cloud)"'),
  sourceMachineId: z.string().optional().describe('ID de la machine source pour charger model-configs.json depuis sa config publiée (optionnel, défaut: fichier local)')
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
function parseTargets(targets?: string[]): ('modes' | 'mcp' | 'profiles' | `mcp:${string}`)[] {
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

    if (target === 'modes' || target === 'mcp' || target === 'profiles' || target === 'roomodes' || target === 'model-configs' || target === 'rules' || target === 'settings' || target === 'claude-config' || target === 'modes-yaml') {
      return target as any;
    }

    throw new ConfigSharingServiceError(
      `Target invalide: '${target}'. Valeurs acceptées: modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, ou mcp:<nomServeur>`,
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
  const { action, machineId, dryRun = false } = args;

  try {
    const rooSyncService = getRooSyncService();
    const configSharingService = rooSyncService.getConfigSharingService();

    switch (action) {
      case 'collect': {
        // Action collect: Collecte la configuration locale
        const { targets = ['modes', 'mcp'] } = args;

        const result = await configSharingService.collectConfig({
          targets: targets as ('modes' | 'mcp' | 'profiles')[],
          dryRun
        });

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
            targets: targets as ('modes' | 'mcp' | 'profiles')[],
            dryRun
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
        const { version, targets, backup = true } = args;

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
          dryRun
        });

        return {
          status: result.success ? 'success' : 'error',
          message: result.success ? 'Configuration appliquée avec succès' : 'Échec de l\'application de la configuration',
          filesApplied: result.filesApplied,
          backupPath: result.backupPath,
          errors: result.errors
        };
      }

      case 'apply_profile': {
        // Action apply_profile: Applique un profil de modèle (#498 Phase 2)
        const { profileName, sourceMachineId, backup = true } = args;

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
          dryRun
        });

        const modesMsg = result.roomodesGenerated
          ? ` + .roomodes régénéré`
          : result.errors?.some(e => e.includes('génération') || e.includes('generation'))
            ? ` (⚠️ .roomodes non régénéré)`
            : '';

        return {
          status: result.success ? 'success' : 'error',
          message: result.success
            ? `Profil '${result.profileName}' appliqué avec succès (${result.modesConfigured} modes, ${result.apiConfigsCount} configs API${modesMsg})`
            : `Échec de l'application du profil '${result.profileName}'`,
          profileName: result.profileName,
          modesConfigured: result.modesConfigured,
          apiConfigsCount: result.apiConfigsCount,
          backupPath: result.backupPath,
          changes: result.changes,
          roomodesGenerated: result.roomodesGenerated,
          errors: result.errors
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
    throw new ConfigSharingServiceError(
      `Erreur lors de l'opération ${action}: ${error instanceof Error ? error.message : String(error)}`,
      ConfigSharingServiceErrorCode.COLLECTION_FAILED,
      { originalError: error instanceof Error ? error.message : String(error), args }
    );
  }
}

/**
 * Metadata pour l'enregistrement MCP de roosync_config
 */
export const configToolMetadata = {
  name: 'roosync_config',
  description: 'Gestion de configuration RooSync. Actions : collect (collecte locale), publish (publication GDrive), apply (application depuis GDrive), apply_profile (appliquer un profil de modèle). Cibles : modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, mcp:<nomServeur>. Stocke par machineId.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['collect', 'publish', 'apply', 'apply_profile'],
        description: 'Action à effectuer: collect (collecte config locale), publish (publication vers GDrive), apply (application depuis GDrive), apply_profile (appliquer un profil de modèle)'
      },
      machineId: {
        type: 'string',
        description: 'ID de la machine (optionnel, utilise ROOSYNC_MACHINE_ID par défaut)'
      },
      dryRun: {
        type: 'boolean',
        description: 'Si true, simule l\'opération sans modifier les fichiers. Défaut: false'
      },
      targets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Liste des cibles à collecter/appliquer (modes, mcp, profiles, roomodes, model-configs, rules, settings, claude-config, modes-yaml, ou mcp:<nomServeur>). Défaut: ["modes", "mcp"]'
      },
      packagePath: {
        type: 'string',
        description: 'Chemin du package créé par collect. Pour action=publish uniquement. Si omis avec targets fourni, fait collect+publish atomique'
      },
      version: {
        type: 'string',
        description: 'Version de la configuration (ex: "2.3.0"). Requis pour action=publish. Pour action=apply, défaut: "latest"'
      },
      description: {
        type: 'string',
        description: 'Description des changements. Requis pour action=publish'
      },
      backup: {
        type: 'boolean',
        description: 'Créer un backup local avant application (défaut: true). Pour action=apply et apply_profile'
      },
      profileName: {
        type: 'string',
        description: 'Nom du profil à appliquer (requis pour action=apply_profile). Ex: "Production (Qwen 3.5 local + GLM-5 cloud)"'
      },
      sourceMachineId: {
        type: 'string',
        description: 'ID de la machine source pour charger model-configs.json depuis sa config publiée (optionnel, défaut: fichier local)'
      }
    },
    required: ['action'],
    additionalProperties: false
  }
};
