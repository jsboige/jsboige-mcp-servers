/**
 * Parsers pour les fichiers RooSync
 * 
 * Ce module contient les utilitaires de parsing pour les différents
 * formats de fichiers utilisés par RooSync (Markdown avec marqueurs HTML, JSON).
 * 
 * @module roosync-parsers
 * @version 2.0.0
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Interface pour une décision RooSync
 */
export interface RooSyncDecision {
  /** Identifiant unique de la décision (UUID ou hash) */
  id: string;
  
  /** Titre/description de la décision */
  title: string;
  
  /** État de la décision */
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'rolled_back';
  
  /** Type de changement */
  type: 'config' | 'file' | 'setting';
  
  /** Chemin du fichier concerné (si applicable) */
  path?: string;
  
  /** Machine source de la décision */
  sourceMachine: string;
  
  /** Machines cibles */
  targetMachines: string[];
  
  /** Date de création */
  createdAt: string;
  
  /** Date de dernière modification */
  updatedAt?: string;
  
  /** Utilisateur ayant créé la décision */
  createdBy?: string;
  
  /** Détails du changement (diff, description) */
  details?: string;
  
  /** Chemin du backup (si appliqué) */
  backupPath?: string;
}

/**
 * Interface pour le dashboard RooSync
 */
export interface RooSyncDashboard {
  /** Version du format du dashboard */
  version: string;
  
  /** Date de dernière mise à jour */
  lastUpdate: string;
  
  /** État global de synchronisation */
  overallStatus: 'synced' | 'diverged' | 'conflict' | 'unknown';
  
  /** Machines enregistrées */
  machines: {
    [machineId: string]: {
      /** Dernière synchronisation réussie */
      lastSync: string;
      
      /** État de la machine */
      status: 'online' | 'offline' | 'unknown';
      
      /** Nombre de différences détectées */
      diffsCount: number;
      
      /** Nombre de décisions en attente */
      pendingDecisions: number;
    };
  };
  
  /** Statistiques globales */
  stats?: {
    totalDiffs: number;
    totalDecisions: number;
    appliedDecisions: number;
    pendingDecisions: number;
  };
}

/**
 * Erreur de parsing RooSync
 */
export class RooSyncParseError extends Error {
  constructor(message: string, public readonly filePath?: string) {
    super(`[RooSync Parse] ${message}`);
    this.name = 'RooSyncParseError';
  }
}

/**
 * Parse un fichier Markdown contenant des décisions RooSync
 * 
 * Les décisions sont encadrées par des marqueurs HTML :
 * <!-- DECISION_BLOCK_START -->
 * ...
 * <!-- DECISION_BLOCK_END -->
 * 
 * @param filePath Chemin vers le fichier Markdown
 * @returns Tableau de décisions parsées
 * @throws {RooSyncParseError} Si le parsing échoue
 */
export function parseRoadmapMarkdown(filePath: string): RooSyncDecision[] {
  try {
    const content = readFileSync(resolve(filePath), 'utf-8');
    const decisions: RooSyncDecision[] = [];
    
    // Regex pour extraire les blocs de décisions
    const blockRegex = /<!-- DECISION_BLOCK_START -->([\s\S]*?)<!-- DECISION_BLOCK_END -->/g;
    
    let match;
    while ((match = blockRegex.exec(content)) !== null) {
      const blockContent = match[1].trim();
      
      // Parser le contenu du bloc
      const decision = parseDecisionBlock(blockContent);
      if (decision) {
        decisions.push(decision);
      }
    }
    
    return decisions;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new RooSyncParseError(
      `Erreur lors du parsing de ${filePath}: ${errorMessage}`,
      filePath
    );
  }
}

/**
 * Parse le contenu d'un bloc de décision Markdown
 * 
 * @param blockContent Contenu Markdown du bloc
 * @returns Décision parsée ou null si invalide
 */
function parseDecisionBlock(blockContent: string): RooSyncDecision | null {
  try {
    // Extraire les champs du bloc Markdown
    const idMatch = blockContent.match(/\*\*ID:\*\*\s*`(.+?)`/);
    const titleMatch = blockContent.match(/\*\*Titre:\*\*\s*(.+?)$/m);
    const statusMatch = blockContent.match(/\*\*Statut:\*\*\s*(.+?)$/m);
    const typeMatch = blockContent.match(/\*\*Type:\*\*\s*(.+?)$/m);
    const pathMatch = blockContent.match(/\*\*Chemin:\*\*\s*`(.+?)`/);
    const sourceMachineMatch = blockContent.match(/\*\*Machine Source:\*\*\s*(.+?)$/m);
    const targetMachinesMatch = blockContent.match(/\*\*Machines Cibles:\*\*\s*(.+?)$/m);
    const createdAtMatch = blockContent.match(/\*\*Créé:\*\*\s*(.+?)$/m);
    const updatedAtMatch = blockContent.match(/\*\*Mis à jour:\*\*\s*(.+?)$/m);
    const createdByMatch = blockContent.match(/\*\*Créé par:\*\*\s*(.+?)$/m);
    const detailsMatch = blockContent.match(/\*\*Détails:\*\*\s*([\s\S]*?)(?:\n\*\*|$)/);
    
    if (!idMatch || !titleMatch || !statusMatch || !sourceMachineMatch) {
      return null; // Champs obligatoires manquants
    }
    
    // Parser le statut
    const statusStr = statusMatch[1].trim().toLowerCase();
    const validStatuses = ['pending', 'approved', 'rejected', 'applied', 'rolled_back'];
    const status = validStatuses.includes(statusStr) 
      ? statusStr as RooSyncDecision['status']
      : 'pending';
    
    // Parser le type
    const typeStr = typeMatch ? typeMatch[1].trim().toLowerCase() : 'config';
    const validTypes = ['config', 'file', 'setting'];
    const type = validTypes.includes(typeStr)
      ? typeStr as RooSyncDecision['type']
      : 'config';
    
    // Parser les machines cibles
    const targetMachinesStr = targetMachinesMatch ? targetMachinesMatch[1].trim() : '';
    const targetMachines = targetMachinesStr
      .split(',')
      .map(m => m.trim())
      .filter(m => m.length > 0);
    
    return {
      id: idMatch[1].trim(),
      title: titleMatch[1].trim(),
      status,
      type,
      path: pathMatch ? pathMatch[1].trim() : undefined,
      sourceMachine: sourceMachineMatch[1].trim(),
      targetMachines,
      createdAt: createdAtMatch ? createdAtMatch[1].trim() : new Date().toISOString(),
      updatedAt: updatedAtMatch ? updatedAtMatch[1].trim() : undefined,
      createdBy: createdByMatch ? createdByMatch[1].trim() : undefined,
      details: detailsMatch ? detailsMatch[1].trim() : undefined
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`Erreur lors du parsing d'un bloc de décision: ${errorMessage}`);
    return null;
  }
}

/**
 * Parse un fichier JSON dashboard RooSync
 * 
 * @param filePath Chemin vers le fichier JSON
 * @returns Dashboard parsé
 * @throws {RooSyncParseError} Si le parsing échoue
 */
export function parseDashboardJson(filePath: string): RooSyncDashboard {
  try {
    const content = readFileSync(resolve(filePath), 'utf-8');
    const data = JSON.parse(content);
    
    // Validation basique de la structure
    if (!data.version || !data.machines) {
      throw new Error('Structure de dashboard invalide (version ou machines manquant)');
    }
    
    return data as RooSyncDashboard;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new RooSyncParseError(
      `Erreur lors du parsing du dashboard ${filePath}: ${errorMessage}`,
      filePath
    );
  }
}

/**
 * Parse un fichier JSON de configuration RooSync
 * 
 * @param filePath Chemin vers le fichier JSON
 * @returns Configuration parsée
 * @throws {RooSyncParseError} Si le parsing échoue
 */
export function parseConfigJson(filePath: string): any {
  try {
    const content = readFileSync(resolve(filePath), 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new RooSyncParseError(
      `Erreur lors du parsing de la config ${filePath}: ${errorMessage}`,
      filePath
    );
  }
}

/**
 * Filtre les décisions par statut
 * 
 * @param decisions Tableau de décisions
 * @param status Statut à filtrer
 * @returns Décisions filtrées
 */
export function filterDecisionsByStatus(
  decisions: RooSyncDecision[],
  status: RooSyncDecision['status']
): RooSyncDecision[] {
  return decisions.filter(d => d.status === status);
}

/**
 * Filtre les décisions par machine cible
 * 
 * @param decisions Tableau de décisions
 * @param machineId ID de la machine
 * @returns Décisions filtrées
 */
export function filterDecisionsByMachine(
  decisions: RooSyncDecision[],
  machineId: string
): RooSyncDecision[] {
  return decisions.filter(d => 
    d.targetMachines.includes(machineId) || 
    d.targetMachines.includes('all') ||
    d.targetMachines.length === 0
  );
}

/**
 * Trouve une décision par ID
 * 
 * @param decisions Tableau de décisions
 * @param id ID de la décision
 * @returns Décision trouvée ou undefined
 */
export function findDecisionById(
  decisions: RooSyncDecision[],
  id: string
): RooSyncDecision | undefined {
  return decisions.find(d => d.id === id);
}