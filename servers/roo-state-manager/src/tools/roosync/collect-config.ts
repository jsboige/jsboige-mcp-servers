import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
export const CollectConfigArgsSchema = z.object({
  targets: z.array(z.string()).optional().describe('Liste des cibles à collecter (modes, mcp, profiles). Défaut: ["modes", "mcp"]'),
  dryRun: z.boolean().optional().describe('Si true, simule la collecte sans créer de fichiers. Défaut: false')
});

export type CollectConfigArgs = z.infer<typeof CollectConfigArgsSchema>;

export async function roosyncCollectConfig(args: CollectConfigArgs) {
  const { targets = ['modes', 'mcp'], dryRun = false } = args;
  
  try {
    const rooSyncService = getRooSyncService();
    const configSharingService = rooSyncService.getConfigSharingService();
    
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
  } catch (error) {
    throw new Error(`Erreur lors de la collecte de configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const collectConfigToolMetadata = {
  name: 'roosync_collect_config',
  description: 'Collecte la configuration locale (modes, MCPs, profils) et prépare un package pour la synchronisation.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      targets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Liste des cibles à collecter (modes, mcp, profiles). Défaut: ["modes", "mcp"]'
      },
      dryRun: {
        type: 'boolean',
        description: 'Si true, simule la collecte sans créer de fichiers. Défaut: false'
      }
    },
    additionalProperties: false
  }
};