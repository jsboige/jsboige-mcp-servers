/**
 * Outil MCP : roosync_update_baseline
 *
 * Met à jour la configuration baseline.
 * Supporte deux modes :
 * 1. Mode standard : utilise une machine spécifique comme référence
 * 2. Mode profil : utilise une agrégation de configurations (non-nominatif)
 *
 * @module tools/roosync/update-baseline
 * @version 2.2.0
 */

import { z } from 'zod';
import { getRooSyncService, RooSyncServiceError } from '../../services/lazy-roosync.js';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join } from 'path';
import { createLogger, Logger } from '../../utils/logger.js';
import { BaselineService } from '../../services/BaselineService.js';
import { ConfigService } from '../../services/ConfigService.js';
import { InventoryCollector, type MachineInventory } from '../../services/InventoryCollector.js';
import { DiffDetector } from '../../services/DiffDetector.js';
import type { BaselineConfig } from '../../types/baseline.js';
import { readJSONFileSyncWithoutBOM } from '../../utils/encoding-helpers.js';

// Logger instance for update baseline tool
const logger: Logger = createLogger('UpdateBaselineTool');

/**
 * Schema de validation pour roosync_update_baseline
 */
export const UpdateBaselineArgsSchema = z.object({
  machineId: z.string()
    .describe('ID de la machine à utiliser comme nouvelle baseline (ou nom du profil en mode profile)'),
  mode: z.enum(['standard', 'profile']).optional().default('standard')
    .describe('Mode de mise à jour: standard (machine) ou profile (agrégation)'),
  aggregationConfig: z.object({
    sources: z.array(z.any()).optional(),
    categoryRules: z.record(z.any()).optional(),
    thresholds: z.record(z.any()).optional()
  }).optional().describe('Configuration d\'agrégation (uniquement pour mode=profile)'),
  version: z.string().optional()
    .describe('Version de la baseline (défaut: auto-généré)'),
  createBackup: z.boolean().optional()
    .describe('Créer une sauvegarde de l\'ancienne baseline (défaut: true)'),
  updateReason: z.string().optional()
    .describe('Raison de la mise à jour (pour documentation)'),
  updatedBy: z.string().optional()
    .describe('Auteur de la mise à jour (défaut: machine actuelle)')
});

export type UpdateBaselineArgs = z.infer<typeof UpdateBaselineArgsSchema>;

/**
 * Schema de retour pour roosync_update_baseline
 */
export const UpdateBaselineResultSchema = z.object({
  success: z.boolean().describe('Succès de la mise à jour'),
  previousBaseline: z.object({
    machineId: z.string(),
    version: z.string(),
    lastUpdated: z.string().optional()
  }).optional().describe('Ancienne baseline'),
  newBaseline: z.object({
    machineId: z.string(),
    version: z.string(),
    lastUpdated: z.string()
  }).describe('Nouvelle baseline'),
  backupCreated: z.boolean().describe('Si une sauvegarde a été créée'),
  backupPath: z.string().optional().describe('Chemin de la sauvegarde si créée'),
  message: z.string().describe('Message de résultat')
});

export type UpdateBaselineResult = z.infer<typeof UpdateBaselineResultSchema>;

/**
 * Génère une version de baseline automatiquement
 */
function generateBaselineVersion(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  
  return `${year}.${month}.${day}-${hours}${minutes}`;
}

/**
 * Crée une configuration baseline à partir de l'inventaire d'une machine
 */
function createBaselineFromInventory(
  machineId: string, 
  inventory: any, 
  version: string
): any {
  return {
    machineId,
    version,
    lastUpdated: new Date().toISOString(),
    config: {
      roo: {
        modes: inventory.config?.roo?.modes || [],
        mcpSettings: inventory.config?.roo?.mcpSettings || {},
        userSettings: inventory.config?.roo?.userSettings || {}
      },
      hardware: {
        cpu: inventory.config?.hardware?.cpu || 'Unknown',
        ram: inventory.config?.hardware?.ram || 'Unknown',
        disks: inventory.config?.hardware?.disks || []
      },
      software: {
        powershell: inventory.config?.software?.powershell || 'Unknown',
        node: inventory.config?.software?.node || 'N/A',
        python: inventory.config?.software?.python || 'N/A'
      },
      system: {
        os: inventory.config?.system?.os || 'Unknown',
        architecture: inventory.config?.system?.architecture || 'Unknown'
      }
    }
  };
}

/**
 * Outil roosync_update_baseline
 *
 * @deprecated Utilisez roosync_baseline avec action: 'update' à la place.
 * Cet outil est conservé pour compatibilité mais sera supprimé dans une version future.
 *
 * Met à jour la configuration baseline en utilisant une machine spécifique
 * comme nouvelle référence.
 *
 * @param args Arguments validés
 * @returns Résultat de la mise à jour
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncUpdateBaseline(args: UpdateBaselineArgs): Promise<UpdateBaselineResult> {
  try {
    logger.info('🔄 Starting baseline update', {
      machineId: args.machineId,
      mode: args.mode,
      version: args.version,
      createBackup: args.createBackup
    });

    const service = await getRooSyncService();
    const config = service.getConfig();
    
    // 1. Initialiser les services nécessaires
    const configService = new ConfigService();
    const inventoryCollector = new InventoryCollector();
    const diffDetector = new DiffDetector();
    const baselineService = new BaselineService(configService, inventoryCollector as any, diffDetector);
    
    // 2. Charger l'ancienne baseline
    const oldBaseline = await baselineService.loadBaseline();
    let previousBaseline = null;
    let backupPath = undefined;
    
    if (oldBaseline) {
      previousBaseline = {
        machineId: oldBaseline.machineId,
        version: oldBaseline.version,
        lastUpdated: oldBaseline.lastUpdated || ''
      };
      
      // 3. Créer une sauvegarde si demandé
      if (args.createBackup !== false) {
        const baselinePath = join(config.sharedPath, 'sync-config.ref.json');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupPath = join(config.sharedPath, '.rollback', `sync-config.ref.backup.${timestamp}.json`);
        
        try {
          copyFileSync(baselinePath, backupPath);
          logger.info('✅ Baseline backup created', { backupPath });
        } catch (backupError) {
          logger.warn('⚠️ Could not create backup', { error: backupError });
          // Continuer sans sauvegarde
        }
      }
    }
    
    let newBaseline;
    const version = args.version || generateBaselineVersion();

    // 4. Créer la nouvelle baseline selon le mode
    if (args.mode === 'profile') {
      logger.info('📊 Creating non-nominative baseline', { name: args.machineId });
      
      // En mode profile, on utilise createNonNominativeBaseline du service
      const nonNominativeBaseline = await service.createNonNominativeBaseline(
        args.machineId, // Utilisé comme nom de la baseline
        args.updateReason || 'Baseline créée par agrégation',
        args.aggregationConfig
      );

      // Adapter le format pour BaselineService
      // Note: BaselineService attend un format spécifique, ici on simule une structure compatible
      newBaseline = {
        machineId: `profile:${nonNominativeBaseline.baselineId}`, // ID virtuel pour le profil
        version: nonNominativeBaseline.version,
        lastUpdated: new Date().toISOString(),
        config: {
          // Structure minimale pour compatibilité, les vraies données sont dans les profils
          roo: { modes: [], mcpSettings: {}, userSettings: {} },
          hardware: { cpu: 'Profile', ram: 'Profile', disks: [] },
          software: { powershell: 'N/A', node: 'N/A', python: 'N/A' },
          system: { os: 'Profile', architecture: 'N/A' }
        },
        // Attacher les métadonnées non-nominatives
        isNonNominative: true,
        profiles: nonNominativeBaseline.profiles
      };
    } else {
      // Mode standard (machine)
      logger.info('📊 Collecting inventory for target machine', { machineId: args.machineId });
      const inventory = await inventoryCollector.collectInventory(args.machineId, true);
      
      if (!inventory) {
        throw new RooSyncServiceError(
          `Impossible de collecter l'inventaire pour la machine ${args.machineId}`,
          'INVENTORY_COLLECTION_FAILED'
        );
      }
      
      newBaseline = createBaselineFromInventory(args.machineId, inventory, version);
    }
    
    // 5. Mettre à jour la baseline via le service
    const updateSuccess = await baselineService.updateBaseline(newBaseline, {
      createBackup: false, // Déjà géré manuellement
      updateReason: args.updateReason || `Baseline mise à jour (${args.mode})`,
      updatedBy: args.updatedBy || config.machineId
    });
    
    if (!updateSuccess) {
      throw new RooSyncServiceError(
        'Échec de la mise à jour de la baseline',
        'BASELINE_UPDATE_FAILED'
      );
    }
    
    // 7. Mettre à jour le dashboard pour refléter le changement
    const dashboardPath = join(config.sharedPath, 'sync-dashboard.json');
    if (existsSync(dashboardPath)) {
      try {
        // BOM-safe read #664
        const dashboard = readJSONFileSyncWithoutBOM<any>(dashboardPath);
        
        // Mettre à jour les informations de baseline
        dashboard.baselineMachine = args.machineId;
        dashboard.baselineVersion = version;
        dashboard.lastBaselineUpdate = new Date().toISOString();
        dashboard.lastUpdate = new Date().toISOString();
        
        // Mettre à jour le statut de la machine baseline
        if (dashboard.machines[args.machineId]) {
          dashboard.machines[args.machineId].isBaseline = true;
          dashboard.machines[args.machineId].lastBaselineUpdate = new Date().toISOString();
        }
        
        // Retirer le statut baseline de l'ancienne machine si elle existe
        if (previousBaseline && dashboard.machines[previousBaseline.machineId]) {
          dashboard.machines[previousBaseline.machineId].isBaseline = false;
        }
        
        writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2), 'utf-8');
        logger.info('✅ Dashboard updated with new baseline');
      } catch (dashboardError) {
        logger.warn('⚠️ Could not update dashboard', { error: dashboardError });
        // Continuer sans bloquer
      }
    }
    
    // 8. Ajouter une entrée dans le roadmap
    const roadmapPath = join(config.sharedPath, 'sync-roadmap.md');
    if (existsSync(roadmapPath)) {
      try {
        let roadmapContent = readFileSync(roadmapPath, 'utf-8');
        
        const baselineUpdateEntry = `
## 🔄 Mise à Jour Baseline - ${new Date().toISOString()}

**Machine baseline précédente :** ${previousBaseline ? `${previousBaseline.machineId} (v${previousBaseline.version})` : 'Aucune'}
**Nouvelle machine baseline :** ${args.machineId} (v${version})
**Raison :** ${args.updateReason || 'Mise à jour manuelle'}
**Effectuée par :** ${args.updatedBy || config.machineId}
**Sauvegarde créée :** ${backupPath ? 'Oui' : 'Non'}

---

`;
        
        roadmapContent += baselineUpdateEntry;
        writeFileSync(roadmapPath, roadmapContent, 'utf-8');
        logger.info('✅ Roadmap updated with baseline change');
      } catch (roadmapError) {
        logger.warn('⚠️ Could not update roadmap', { error: roadmapError });
        // Continuer sans bloquer
      }
    }
    
    // 9. Préparer le message de résultat
    let message = `Baseline mise à jour avec succès vers la machine '${args.machineId}' (v${version})`;
    if (previousBaseline) {
      message += `\nAncienne baseline : ${previousBaseline.machineId} (v${previousBaseline.version})`;
    }
    if (backupPath) {
      message += `\nSauvegarde créée : ${backupPath}`;
    }
    if (args.updateReason) {
      message += `\nRaison : ${args.updateReason}`;
    }
    
    logger.info('✅ Baseline update completed successfully', {
      newMachineId: args.machineId,
      newVersion: version,
      previousMachineId: previousBaseline?.machineId
    });
    
    return {
      success: true,
      previousBaseline: previousBaseline || undefined,
      newBaseline: {
        machineId: newBaseline.machineId,
        version: newBaseline.version,
        lastUpdated: newBaseline.lastUpdated
      },
      backupCreated: !!backupPath,
      backupPath,
      message
    };
    
  } catch (error) {
    logger.error('❌ Baseline update failed', error);
    
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors de la mise à jour de la baseline: ${(error as Error).message}`,
      'BASELINE_UPDATE_ERROR'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const updateBaselineToolMetadata = {
  name: 'roosync_update_baseline',
  description: '[DEPRECATED] Met à jour la configuration baseline avec une nouvelle machine cible ou un profil. Utilisez roosync_baseline avec action: \'update\' à la place.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      machineId: {
        type: 'string',
        description: 'ID de la machine ou nom du profil'
      },
      mode: {
        type: 'string',
        enum: ['standard', 'profile'],
        description: 'Mode de mise à jour (défaut: standard)'
      },
      aggregationConfig: {
        type: 'object',
        description: 'Configuration d\'agrégation (mode profile uniquement)',
        properties: {
          sources: { type: 'array', items: { type: 'any' } },
          categoryRules: { type: 'object' },
          thresholds: { type: 'object' }
        }
      },
      version: {
        type: 'string',
        description: 'Version de la baseline (défaut: auto-généré au format YYYY.MM.DD-HHMM)'
      },
      createBackup: {
        type: 'boolean',
        description: 'Créer une sauvegarde de l\'ancienne baseline (défaut: true)'
      },
      updateReason: {
        type: 'string',
        description: 'Raison de la mise à jour (pour documentation)'
      },
      updatedBy: {
        type: 'string',
        description: 'Auteur de la mise à jour (défaut: machine actuelle)'
      }
    },
    required: ['machineId'],
    additionalProperties: false
  }
};