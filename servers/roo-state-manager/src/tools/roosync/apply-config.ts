import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';

export const ApplyConfigArgsSchema = z.object({
  version: z.string().optional().describe('Version à appliquer (défaut: latest)'),
  machineId: z.string().optional().describe('ID de la machine source (optionnel, utilise ROOSYNC_MACHINE_ID par défaut)'),
  targets: z.array(z.string()).optional().describe('Filtre optionnel des cibles (modes, mcp, profiles)'),
  backup: z.boolean().optional().describe('Créer un backup local avant application (défaut: true)'),
  dryRun: z.boolean().optional().describe('Si true, simule l\'application sans modifier les fichiers')
});

export type ApplyConfigArgs = z.infer<typeof ApplyConfigArgsSchema>;

export async function roosyncApplyConfig(args: ApplyConfigArgs) {
  const { version, machineId, targets, backup = true, dryRun = false } = args;

  try {
    const rooSyncService = getRooSyncService();
    const configService = rooSyncService.getConfigService();
    const configSharingService = rooSyncService.getConfigSharingService();

    // Vérifier la version de configuration requise
    const currentVersion = await configService.getConfigVersion();

    if (version && version !== 'latest' && currentVersion) {
      // Comparer les versions majeures (premier chiffre)
      const currentMajor = parseInt(currentVersion.split('.')[0], 10);
      const requestedMajor = parseInt(version.split('.')[0], 10);

      if (currentMajor !== requestedMajor) {
        throw new Error(
          `Incompatibilité de version de configuration:\n` +
          `  - Version actuelle: ${currentVersion}\n` +
          `  - Version requise: ${version}\n\n` +
          `La version de configuration requise doit correspondre à la version majeure actuelle.\n` +
          `Utilisez 'latest' pour appliquer la dernière version compatible ou spécifiez une version compatible (v${currentMajor}.x.x).`
        );
      }
    }

    const result = await configSharingService.applyConfig({
      version,
      machineId, // CORRECTION SDDD : Passer le machineId au service
      targets: targets as ('modes' | 'mcp' | 'profiles')[],
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
    throw new Error(`Erreur lors de l'application de la configuration: ${error instanceof Error ? error.message : String(error)}`);
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
        description: 'Filtre optionnel des cibles (modes, mcp, profiles)'
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