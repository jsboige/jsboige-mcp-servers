import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
import { ConfigSharingServiceError, ConfigSharingServiceErrorCode } from '../../types/errors.js';

export const ApplyConfigArgsSchema = z.object({
  version: z.string().optional().describe('Version à appliquer (défaut: latest)'),
  machineId: z.string().optional().describe('ID de la machine source (optionnel, utilise ROOSYNC_MACHINE_ID par défaut)'),
  targets: z.array(z.string()).optional().refine(
    (targets) => {
      if (!targets) return true;
      return targets.every(target => {
        if (target === 'modes' || target === 'mcp' || target === 'profiles') {
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
      message: "Target invalide. Valeurs acceptées: modes, mcp, profiles, ou mcp:<nomServeur>"
    }
  ).describe('Filtre optionnel des cibles (modes, mcp, profiles, ou mcp:<nomServeur>)'),
  backup: z.boolean().optional().describe('Créer un backup local avant application (défaut: true)'),
  dryRun: z.boolean().optional().describe('Si true, simule l\'application sans modifier les fichiers')
});

export type ApplyConfigArgs = z.infer<typeof ApplyConfigArgsSchema>;

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
    
    if (target === 'modes' || target === 'mcp' || target === 'profiles') {
      return target;
    }
    
    throw new ConfigSharingServiceError(
      `Target invalide: '${target}'. Valeurs acceptées: modes, mcp, profiles, ou mcp:<nomServeur>`,
      ConfigSharingServiceErrorCode.INVALID_TARGET_FORMAT,
      { target }
    );
  });
}

export async function roosyncApplyConfig(args: ApplyConfigArgs) {
  const { version, machineId, targets, backup = true, dryRun = false } = args;

  try {
    const rooSyncService = getRooSyncService();
    const configService = rooSyncService.getConfigService();
    const configSharingService = rooSyncService.getConfigSharingService();

    // Vérifier la version de configuration requise
    const currentVersion = await configService.getConfigVersion();

    // Bug #305: Gérer le cas où currentVersion est null (fichier sync-config.json inexistant ou sans champ version)
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
      // Si currentVersion est null, on ne peut pas valider la version demandée
      // On continue avec la version demandée (ou 'latest' par défaut)
    }

    const result = await configSharingService.applyConfig({
      version,
      machineId, // CORRECTION SDDD : Passer le machineId au service
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
  } catch (error) {
    if (error instanceof ConfigSharingServiceError) {
      throw error;
    }
    throw new ConfigSharingServiceError(
      `Erreur lors de l'application de la configuration: ${error instanceof Error ? error.message : String(error)}`,
      ConfigSharingServiceErrorCode.COLLECTION_FAILED,
      { originalError: error instanceof Error ? error.message : String(error), args }
    );
  }
}

export const applyConfigToolMetadata = {
  name: 'roosync_apply_config',
  description: 'Applique une configuration partagée sur la machine locale. CORRECTION SDDD : Supporte les configs par machineId.\n\nNOTE: La version de configuration doit correspondre à la version majeure actuelle du système (ex: v1.x.x pour un système en v1.0.0). Utilisez "latest" pour appliquer la dernière version compatible.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      version: {
        type: 'string',
        description: 'Version à appliquer (défaut: latest). La version doit correspondre à la version majeure actuelle du système. Utilisez "latest" pour la dernière version compatible.'
      },
      machineId: {
        type: 'string',
        description: 'ID de la machine source (optionnel, utilise ROOSYNC_MACHINE_ID par défaut)'
      },
      targets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filtre optionnel des cibles (modes, mcp, profiles, ou mcp:<nomServeur>)'
      },
      backup: {
        type: 'boolean',
        description: 'Créer un backup local avant application (défaut: true)'
      },
      dryRun: {
        type: 'boolean',
        description: 'Si true, simule l\'application sans modifier les fichiers'
      }
    },
    additionalProperties: false
  }
};