import { z } from 'zod';
import { getRooSyncService } from '../../services/RooSyncService.js';
export const PublishConfigArgsSchema = z.object({
  packagePath: z.string().describe('Chemin du package temporaire créé par roosync_collect_config'),
  version: z.string().describe('Version de la configuration (ex: "2.2.0")'),
  description: z.string().describe('Description des changements')
});

export type PublishConfigArgs = z.infer<typeof PublishConfigArgsSchema>;

export async function roosyncPublishConfig(args: PublishConfigArgs) {
  const { packagePath, version, description } = args;
  
  try {
    const rooSyncService = getRooSyncService();
    const configSharingService = rooSyncService.getConfigSharingService();
    
    const result = await configSharingService.publishConfig({
      packagePath,
      version,
      description
    });
    
    return {
      status: 'success',
      message: `Configuration publiée avec succès`,
      version: result.version,
      targetPath: result.path
    };
  } catch (error) {
    throw new Error(`Erreur lors de la publication de configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const publishConfigToolMetadata = {
  name: 'roosync_publish_config',
  description: 'Publie un package de configuration collecté vers le stockage partagé.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      packagePath: {
        type: 'string',
        description: 'Chemin du package temporaire créé par roosync_collect_config'
      },
      version: {
        type: 'string',
        description: 'Version de la configuration (ex: "2.2.0")'
      },
      description: {
        type: 'string',
        description: 'Description des changements'
      }
    },
    required: ['packagePath', 'version', 'description'],
    additionalProperties: false
  }
};