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
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    
    // 3. Collecter l'inventaire machine via script PowerShell
    console.error('[INVENTORY] 📋 Début intégration inventaire PowerShell...');
    try {
      // Remonter depuis le répertoire du serveur MCP vers la racine du projet
      // __dirname en production = .../roo-state-manager/build/src/tools/roosync/
      // Il faut remonter 8 niveaux pour arriver à c:/dev/roo-extensions
      const projectRoot = join(__dirname, '..', '..', '..', '..', '..', '..', '..', '..');
      console.error(`[INVENTORY] 📂 Project root: ${projectRoot}`);
      console.error(`[INVENTORY] 📂 __dirname actuel: ${__dirname}`);
      
      const inventoryScriptPath = join(projectRoot, 'scripts', 'inventory', 'Get-MachineInventory.ps1');
      console.error(`[INVENTORY] 📄 Script path calculé: ${inventoryScriptPath}`);
      
      // Vérifier que le script existe
      if (!existsSync(inventoryScriptPath)) {
        console.warn(`[INVENTORY] ⚠️ Script NON TROUVÉ à: ${inventoryScriptPath}`);
        console.warn('[INVENTORY] Continuing without inventory integration...');
      } else {
        console.error(`[INVENTORY] ✅ Script trouvé, préparation exécution...`);
        
        // Construire la commande PowerShell (le script retourne le chemin du fichier via Write-Output)
        const inventoryCmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${inventoryScriptPath}" -MachineId "${config.machineId}"`;
        console.error(`[INVENTORY] 🔧 Commande: ${inventoryCmd}`);
        console.error(`[INVENTORY] 📂 Working directory: ${projectRoot}`);
        
        try {
          console.error('[INVENTORY] ⏳ Exécution du script PowerShell...');
          const { stdout, stderr } = await execAsync(inventoryCmd, {
            timeout: 30000, // 30 secondes max
            cwd: projectRoot
          });
          
          console.error(`[INVENTORY] 📊 stdout length: ${stdout.length} bytes`);
          if (stderr && stderr.trim()) {
            console.warn(`[INVENTORY] ⚠️ stderr: ${stderr}`);
          }
          
          // Le script retourne le chemin du fichier JSON (relatif ou absolu)
          const lines = stdout.trim().split('\n').filter(l => l.trim());
          const inventoryFilePathRaw = lines[lines.length - 1]?.trim();
          console.error(`[INVENTORY] 📄 Dernière ligne stdout: ${inventoryFilePathRaw}`);
          console.error(`[INVENTORY] 📝 Total lignes stdout: ${lines.length}`);
          
          // Si le chemin est relatif, le joindre avec projectRoot
          const inventoryFilePath = inventoryFilePathRaw.includes(':') 
            ? inventoryFilePathRaw 
            : join(projectRoot, inventoryFilePathRaw);
          console.error(`[INVENTORY] 📁 Chemin absolu calculé: ${inventoryFilePath}`);
          
          if (inventoryFilePath && existsSync(inventoryFilePath)) {
            console.error(`[INVENTORY] ✅ Fichier JSON trouvé: ${inventoryFilePath}`);
            // Lire l'inventaire généré (en enlevant le BOM UTF-8 si présent)
            let inventoryContent = readFileSync(inventoryFilePath, 'utf-8');
            if (inventoryContent.charCodeAt(0) === 0xFEFF) {
              inventoryContent = inventoryContent.slice(1);
              console.error('[INVENTORY] 🔧 BOM UTF-8 détecté et supprimé');
            }
            const inventoryData = JSON.parse(inventoryContent);
            
            // Créer ou enrichir sync-config.json avec l'inventaire
            const configPath = join(sharedPath, 'sync-config.json');
            let syncConfig: any;
            
            if (existsSync(configPath) && !args.force) {
              syncConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
            } else {
              syncConfig = {
                version: '2.0.0',
                machines: {}
              };
            }
            
            // Ajouter l'inventaire pour cette machine
            syncConfig.machines[config.machineId] = {
              ...inventoryData.inventory,
              lastInventoryUpdate: inventoryData.timestamp,
              paths: inventoryData.paths
            };
            
            // Sauvegarder sync-config.json
            writeFileSync(configPath, JSON.stringify(syncConfig, null, 2), 'utf-8');
            filesCreated.push('sync-config.json (inventaire intégré)');
            
            console.error('[INVENTORY] ✅ Inventaire machine intégré avec succès dans sync-config.json');
            
            // Nettoyer le fichier temporaire d'inventaire
            try {
              unlinkSync(inventoryFilePath);
              console.error(`[INVENTORY] 🗑️ Fichier temporaire supprimé: ${inventoryFilePath}`);
            } catch (unlinkError) {
              // Ignorer si échec du nettoyage
              console.warn(`[INVENTORY] ⚠️ Impossible de supprimer le fichier temporaire: ${inventoryFilePath}`);
            }
          } else {
            console.warn(`[INVENTORY] ❌ Fichier JSON non trouvé ou invalide: '${inventoryFilePath}'`);
            console.warn('[INVENTORY] Le script n\'a pas généré de fichier JSON valide');
          }
        } catch (execError: any) {
          console.error(`[INVENTORY] ❌ ERREUR EXÉCUTION: ${execError.message}`);
          if (execError.stack) {
            console.error(`[INVENTORY] Stack trace: ${execError.stack}`);
          }
          if (execError.stderr) {
            console.error(`[INVENTORY] PowerShell stderr: ${execError.stderr}`);
          }
          // Continuer sans bloquer l'init - l'inventaire est optionnel
        }
      }
    } catch (error: any) {
      console.error(`[INVENTORY] ❌ ERREUR GLOBALE: ${error.message}`);
      if (error.stack) {
        console.error(`[INVENTORY] Stack trace: ${error.stack}`);
      }
      // Continuer sans bloquer l'init - l'inventaire est optionnel
    }
    console.error('[INVENTORY] 🏁 Fin de l\'intégration inventaire (success ou skip)');
    
    // 4. Créer/vérifier sync-roadmap.md (optionnel)
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
    
    // 5. Créer le répertoire .rollback s'il n'existe pas
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