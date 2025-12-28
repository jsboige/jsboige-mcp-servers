import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';

export const ApplyConfigArgsSchema = z.object({
  version: z.string().optional().describe('Version à appliquer (défaut: latest baseline)'),
  targets: z.array(z.string()).optional().describe('Filtre optionnel des cibles (modes, mcp, profiles)'),
  backup: z.boolean().optional().describe('Créer un backup local avant application (défaut: true)'),
  dryRun: z.boolean().optional().describe('Si true, simule l\'application sans modifier les fichiers')
});

export type ApplyConfigArgs = z.infer<typeof ApplyConfigArgsSchema>;

export async function roosyncApplyConfig(args: ApplyConfigArgs) {
  const { version, targets, backup = true, dryRun = false } = args;
  
  try {
    const rooSyncService = getRooSyncService();
    const configSharingService = rooSyncService.getConfigSharingService();
    
    const result = await configSharingService.applyConfig({
      version,
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
  description: 'Applique une configuration partagée sur la machine locale.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      version: {
        type: 'string',
        description: 'Version à appliquer (défaut: latest baseline)'
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