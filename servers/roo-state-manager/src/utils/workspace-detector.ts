/**
 * WorkspaceDetector : Détection intelligente du workspace avec architecture dual
 * 
 * Implémente la stratégie dual :
 * 1. Priorité : Métadonnées récentes (task_metadata.json)  
 * 2. Fallback : Analyse environment_details dans ui_messages.json
 * 
 * Critical pour la hiérarchisation des tâches par "forêts étanches"
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { UIMessage } from './message-types.js';

export interface WorkspaceDetectionResult {
  workspace: string | null;
  source: 'metadata' | 'environment_details' | 'none';
  confidence: number;
  detectedAt: string;
}

export interface WorkspaceDetectorOptions {
  /** Cache les résultats de détection pour éviter les re-analyses */
  enableCache?: boolean;
  /** Mode strict qui valide l'existence du workspace sur le filesystem */
  validateExistence?: boolean;
  /** Patterns de normalisation de chemins */
  normalizePaths?: boolean;
}

export class WorkspaceDetector {
  private cache = new Map<string, WorkspaceDetectionResult>();
  private options: Required<WorkspaceDetectorOptions>;

  constructor(options: WorkspaceDetectorOptions = {}) {
    this.options = {
      enableCache: options.enableCache ?? true,
      validateExistence: options.validateExistence ?? false,
      normalizePaths: options.normalizePaths ?? true,
    };
  }

  /**
   * Orchestrateur principal : Détection dual avec métadonnées → environment_details fallback
   */
  async detect(taskDir: string): Promise<WorkspaceDetectionResult> {
    const cacheKey = taskDir;
    
    // Cache hit
    if (this.options.enableCache && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    let result: WorkspaceDetectionResult;

    try {
      // STRATÉGIE 1 : Priorité aux métadonnées récentes
      const metadataResult = await this.detectFromMetadata(taskDir);
      if (metadataResult) {
        result = metadataResult;
      } else {
        // STRATÉGIE 2 : Fallback vers environment_details
        const environmentResult = await this.detectFromEnvironmentDetails(taskDir);
        result = environmentResult || {
          workspace: null,
          source: 'none',
          confidence: 0,
          detectedAt: new Date().toISOString(),
        };
      }

      // Validation optionnelle de l'existence
      if (result.workspace && this.options.validateExistence) {
        result = await this.validateWorkspaceExistence(result);
      }

      // Normalisation optionnelle
      if (result.workspace && this.options.normalizePaths) {
        result.workspace = this.normalizePath(result.workspace);
      }

    } catch (error) {
      console.warn(`[WorkspaceDetector] Erreur lors de la détection pour ${taskDir}:`, error);
      result = {
        workspace: null,
        source: 'none',
        confidence: 0,
        detectedAt: new Date().toISOString(),
      };
    }

    // Cache du résultat
    if (this.options.enableCache) {
      this.cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * STRATÉGIE 1 : Détection depuis task_metadata.json (métadonnées récentes)
   */
  async detectFromMetadata(taskDir: string): Promise<WorkspaceDetectionResult | null> {
    const metadataPath = path.join(taskDir, 'task_metadata.json');
    
    try {
      const exists = await fs.access(metadataPath).then(() => true).catch(() => false);
      if (!exists) {
        return null;
      }

      const content = await fs.readFile(metadataPath, 'utf8');
      
      // Gérer le BOM UTF-8 si présent
      const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
      const metadata = JSON.parse(cleanContent);

      if (metadata.workspace && typeof metadata.workspace === 'string' && metadata.workspace.trim()) {
        return {
          workspace: metadata.workspace.trim(),
          source: 'metadata',
          confidence: 0.95, // Haute confiance pour métadonnées explicites
          detectedAt: new Date().toISOString(),
        };
      }

      return null;
    } catch (error) {
      console.warn(`[WorkspaceDetector] Erreur lecture metadata ${metadataPath}:`, error);
      return null;
    }
  }

  /**
   * STRATÉGIE 2 : Détection depuis environment_details dans ui_messages.json (fallback)
   */
  async detectFromEnvironmentDetails(taskDir: string): Promise<WorkspaceDetectionResult | null> {
    const uiMessagesPath = path.join(taskDir, 'ui_messages.json');
    
    try {
      const exists = await fs.access(uiMessagesPath).then(() => true).catch(() => false);
      if (!exists) {
        return null;
      }

      const content = await fs.readFile(uiMessagesPath, 'utf8');
      
      // Gérer le BOM UTF-8 si présent
      const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
      const messages: UIMessage[] = JSON.parse(cleanContent);

      // Chercher les environment_details dans les messages
      for (const message of messages) {
        const workspace = this.extractWorkspaceFromMessage(message);
        if (workspace) {
          return {
            workspace,
            source: 'environment_details',
            confidence: 0.85, // Bonne confiance pour environment_details
            detectedAt: new Date().toISOString(),
          };
        }
      }

      return null;
    } catch (error) {
      console.warn(`[WorkspaceDetector] Erreur lecture ui_messages ${uiMessagesPath}:`, error);
      return null;
    }
  }

  /**
   * Extraction du workspace depuis un message UI
   * Pattern: "# Current Workspace Directory (d:/dev/roo-extensions) Files"
   */
  private extractWorkspaceFromMessage(message: UIMessage): string | null {
    let textContent = '';

    // Extraire le texte selon le type de message
    if (message.type === 'say' && typeof message.text === 'string') {
      textContent = message.text;
    } else if (message.type === 'ask' && typeof message.text === 'string') {
      textContent = message.text;
    }

    if (!textContent) {
      return null;
    }

    // Pattern pour environment_details avec "Current Workspace Directory"
    const patterns = [
      // Pattern principal: "# Current Workspace Directory (d:/dev/roo-extensions) Files"
      /# Current Workspace Directory \(([^)]+)\) Files/i,
      // Pattern de sauvegarde: "Current Workspace Directory: d:/dev/roo-extensions"
      /Current Workspace Directory:\s*([^\s\n]+)/i,
      // Pattern JSON: '"workspace": "d:/dev/roo-extensions"'
      /"workspace":\s*"([^"]+)"/i,
    ];

    for (const pattern of patterns) {
      const match = textContent.match(pattern);
      if (match && match[1]) {
        const workspace = match[1].trim();
        // Validation basique du format chemin
        if (this.isValidWorkspacePath(workspace)) {
          return workspace;
        }
      }
    }

    return null;
  }

  /**
   * Validation basique du format d'un chemin workspace
   */
  private isValidWorkspacePath(workspace: string): boolean {
    if (!workspace || workspace.length < 3) {
      return false;
    }

    // Patterns valides: C:/, d:/, /home/, ./relative, etc.
    const validPathPatterns = [
      /^[a-zA-Z]:[\/\\]/,    // Windows: C:/ ou D:\
      /^\/[^\/]/,           // Unix: /home, /usr, etc.
      /^\.{1,2}[\/\\]/,     // Relatif: ./ ou ../
    ];

    return validPathPatterns.some(pattern => pattern.test(workspace));
  }

  /**
   * Validation de l'existence du workspace sur le filesystem
   */
  private async validateWorkspaceExistence(result: WorkspaceDetectionResult): Promise<WorkspaceDetectionResult> {
    if (!result.workspace) {
      return result;
    }

    try {
      const stats = await fs.stat(result.workspace);
      if (stats.isDirectory()) {
        return {
          ...result,
          confidence: Math.min(result.confidence + 0.1, 1.0), // Boost confiance si existe
        };
      } else {
        return {
          ...result,
          confidence: result.confidence * 0.5, // Réduire confiance si pas un dossier
        };
      }
    } catch {
      return {
        ...result,
        confidence: result.confidence * 0.3, // Forte réduction si n'existe pas
      };
    }
  }

  /**
   * Normalisation des chemins pour cohérence
   */
  private normalizePath(workspace: string): string {
    // Convertir les séparateurs vers le standard de la plateforme
    let normalized = workspace.replace(/[\/\\]/g, path.sep);
    
    // Supprimer le slash final si présent
    if (normalized.endsWith(path.sep) && normalized.length > 1) {
      normalized = normalized.slice(0, -1);
    }

    return normalized;
  }

  /**
   * Nettoyage du cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Statistiques du cache pour debugging
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

/**
 * Instance singleton pour utilisation globale
 */
export const workspaceDetector = new WorkspaceDetector({
  enableCache: true,
  validateExistence: false, // Désactivé par défaut pour performance
  normalizePaths: true,
});

/**
 * Fonction utilitaire pour détection rapide
 */
export async function detectWorkspace(taskDir: string): Promise<string | null> {
  const result = await workspaceDetector.detect(taskDir);
  return result.workspace;
}

/**
 * Fonction utilitaire pour détection avec détails
 */
export async function detectWorkspaceWithDetails(taskDir: string): Promise<WorkspaceDetectionResult> {
  return workspaceDetector.detect(taskDir);
}