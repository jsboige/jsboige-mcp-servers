/**
 * Outil MCP : roosync_init
 * 
 * Initialise l'infrastructure RooSync pour une nouvelle installation.
 * 
 * @module tools/roosync/init
 * @version 2.0.0
 */

import { z } from 'zod';
import { getRooSyncService, RooSyncServiceError } from '../../services/RooSyncService.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Schema de validation pour roosync_init
 */
export const InitArgsSchema = z.object({
  force: z.boolean().optional()
    .describe('Forcer la réinitialisation même si les fichiers existent (défaut: false)'),
  createRoadmap: z.boolean().optional()
    .describe('Créer un fichier sync-roadmap.md initial (défaut: true)')
});

export type InitArgs = z.infer<typeof InitArgsSchema>;

/**
 * Schema de retour pour roosync_init
 */
export const InitResultSchema = z.object({
  success: z.boolean().describe('Succès de l\'initialisation'),
  machineId: z.string().describe('ID de la machine initialisée'),
  sharedPath: z.string().describe('Chemin du répertoire partagé'),
  filesCreated: z.array(z.string()).describe('Fichiers créés'),
  filesSkipped: z.array(z.string()).describe('Fichiers ignorés (déjà existants)'),
  message: z.string().describe('Message de résultat')
});

export type InitResult = z.infer<typeof InitResultSchema>;

/**
 * Template pour un dashboard v2.0.0 initial
 */
function createInitialDashboard(machineId: string): string {
  const now = new Date().toISOString();
  
  return JSON.stringify({
    version: '2.0.0',
    lastUpdate: now,
    overallStatus: 'synced',
    machines: {
      [machineId]: {
        lastSync: now,
        status: 'online',
        diffsCount: 0,
        pendingDecisions: 0
      }
    },
    stats: {
      totalDiffs: 0,
      totalDecisions: 0,
      appliedDecisions: 0,
      pendingDecisions: 0
    }
  }, null, 2);
}

/**
 * Template pour un sync-roadmap.md initial
 */
function createInitialRoadmap(machineId: string): string {
  const now = new Date().toISOString();
  
  return `# RooSync - Roadmap de Synchronisation

**Version** : 2.0.0  
**Dernière mise à jour** : ${now}  
**Machine d'initialisation** : ${machineId}

## 📋 Décisions en Attente

_Aucune décision en attente pour le moment._

---

## ✅ Décisions Approuvées

_Aucune décision approuvée pour le moment._

---

## ❌ Décisions Rejetées

_Aucune décision rejetée pour le moment._

---

## 🔄 Décisions Appliquées

_Aucune décision appliquée pour le moment._

---

## 📝 Guide d'Utilisation

Les décisions de synchronisation sont structurées selon ce format :

\`\`\`markdown
<!-- DECISION_BLOCK_START -->
**ID:** \`uuid-unique\`  
**Titre:** Description de la décision  
**Statut:** pending | approved | rejected | applied | rolled_back  
**Type:** config | file | setting  
**Machine Source:** nom-machine-source  
**Machines Cibles:** machine1, machine2  
**Créé:** ISO8601-timestamp  

**Description:**
Description détaillée du changement à synchroniser.

**Détails Techniques:**
Informations techniques (diff, chemin, etc.)
<!-- DECISION_BLOCK_END -->
\`\`\`

### Workflow de Synchronisation

1. **Détection** : Les divergences sont détectées automatiquement ou manuellement
2. **Création** : Une décision est créée avec le statut \`pending\`
3. **Validation** : L'utilisateur approuve (\`approved\`) ou rejette (\`rejected\`) la décision
4. **Application** : Une décision approuvée est appliquée (\`applied\`)
5. **Rollback** : Si nécessaire, une décision peut être annulée (\`rolled_back\`)

### Outils MCP Disponibles

- \`roosync_get_status\` : Obtenir l'état global de synchronisation
- \`roosync_compare_config\` : Comparer les configurations entre machines
- \`roosync_list_diffs\` : Lister les différences détectées
- \`roosync_get_decision_details\` : Obtenir les détails d'une décision
- \`roosync_approve_decision\` : Approuver une décision
- \`roosync_reject_decision\` : Rejeter une décision
- \`roosync_apply_decision\` : Appliquer une décision approuvée
- \`roosync_rollback_decision\` : Annuler une décision appliquée
- \`roosync_init\` : Initialiser l'infrastructure RooSync

---

_Fichier généré automatiquement par roosync_init_
`;
}

/**
 * Outil roosync_init
 * 
 * Initialise l'infrastructure RooSync en créant les fichiers nécessaires
 * dans le répertoire partagé configuré.
 * 
 * @param args Arguments validés
 * @returns Résultat de l'initialisation
 * @throws {RooSyncServiceError} En cas d'erreur
 */
export async function roosyncInit(args: InitArgs): Promise<InitResult> {
  try {
    const service = getRooSyncService();
    const config = service.getConfig();
    
    const filesCreated: string[] = [];
    const filesSkipped: string[] = [];
    
    // 1. Vérifier/créer le répertoire .shared-state
    const sharedPath = config.sharedPath;
    if (!existsSync(sharedPath)) {
      mkdirSync(sharedPath, { recursive: true });
      filesCreated.push(`${sharedPath}/ (répertoire)`);
    } else {
      filesSkipped.push(`${sharedPath}/ (déjà existant)`);
    }
    
    // 2. Créer/vérifier sync-dashboard.json
    const dashboardPath = join(sharedPath, 'sync-dashboard.json');
    if (!existsSync(dashboardPath) || args.force) {
      const dashboardContent = createInitialDashboard(config.machineId);
      writeFileSync(dashboardPath, dashboardContent, 'utf-8');
      filesCreated.push('sync-dashboard.json');
    } else {
      // Dashboard existe : vérifier si machine est enregistrée
      const existingDashboard = JSON.parse(readFileSync(dashboardPath, 'utf-8'));
      if (!existingDashboard.machines[config.machineId]) {
        // Ajouter la machine au dashboard existant
        const now = new Date().toISOString();
        existingDashboard.machines[config.machineId] = {
          lastSync: now,
          status: 'online',
          diffsCount: 0,
          pendingDecisions: 0
        };
        existingDashboard.lastUpdate = now;
        writeFileSync(dashboardPath, JSON.stringify(existingDashboard, null, 2), 'utf-8');
        filesCreated.push('sync-dashboard.json (machine ajoutée)');
      } else {
        filesSkipped.push('sync-dashboard.json (déjà existant)');
      }
    }
    
    // 3. Créer/vérifier sync-roadmap.md (optionnel)
    if (args.createRoadmap !== false) {
      const roadmapPath = join(sharedPath, 'sync-roadmap.md');
      if (!existsSync(roadmapPath) || args.force) {
        const roadmapContent = createInitialRoadmap(config.machineId);
        writeFileSync(roadmapPath, roadmapContent, 'utf-8');
        filesCreated.push('sync-roadmap.md');
      } else {
        filesSkipped.push('sync-roadmap.md (déjà existant)');
      }
    }
    
    // 4. Créer le répertoire .rollback s'il n'existe pas
    const rollbackDir = join(sharedPath, '.rollback');
    if (!existsSync(rollbackDir)) {
      mkdirSync(rollbackDir, { recursive: true });
      filesCreated.push('.rollback/ (répertoire)');
    } else {
      filesSkipped.push('.rollback/ (déjà existant)');
    }
    
    // Message de résultat
    let message = `Infrastructure RooSync initialisée pour la machine '${config.machineId}'`;
    if (filesCreated.length > 0) {
      message += `\n✅ Fichiers créés : ${filesCreated.length}`;
    }
    if (filesSkipped.length > 0) {
      message += `\n⏭️  Fichiers ignorés : ${filesSkipped.length}`;
    }
    if (args.force) {
      message += '\n⚠️  Mode force activé : fichiers existants remplacés';
    }
    
    return {
      success: true,
      machineId: config.machineId,
      sharedPath: config.sharedPath,
      filesCreated,
      filesSkipped,
      message
    };
  } catch (error) {
    if (error instanceof RooSyncServiceError) {
      throw error;
    }
    
    throw new RooSyncServiceError(
      `Erreur lors de l'initialisation: ${(error as Error).message}`,
      'ROOSYNC_INIT_ERROR'
    );
  }
}

/**
 * Métadonnées de l'outil pour l'enregistrement MCP
 */
export const initToolMetadata = {
  name: 'roosync_init',
  description: 'Initialiser l\'infrastructure RooSync (dashboard, roadmap, répertoires)',
  inputSchema: {
    type: 'object' as const,
    properties: {
      force: {
        type: 'boolean',
        description: 'Forcer la réinitialisation même si les fichiers existent (défaut: false)'
      },
      createRoadmap: {
        type: 'boolean',
        description: 'Créer un fichier sync-roadmap.md initial (défaut: true)'
      }
    },
    additionalProperties: false
  }
};