/**
 * Détecteur automatique du stockage Roo
 * Identifie et analyse les emplacements de stockage des conversations Roo
 */

import * as fs from 'fs/promises';
import * as fsSyncExists from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  RooStorageLocation,
  ConversationSummary,
  RooStorageDetectionResult,
  TaskMetadata,
  RooStorageError,
  InvalidStoragePathError
} from '../types/conversation.js';

export class RooStorageDetector {
  private static readonly COMMON_ROO_PATHS = [
    // Chemins VSCode typiques
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-insiders', 'extensions'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Code - Insiders', 'User', 'globalStorage'),
    // Chemins Linux/Mac
    path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
  ];

  private static readonly ROO_EXTENSION_PATTERNS = [
    '**/saoudrizwan.claude-dev-*',
    '**/claude-dev*',
    '**/roo*',
    '**/cline*'
  ];

  /**
   * Détecte automatiquement les emplacements de stockage Roo
   * Lit le fichier d'index conversations.json au lieu de scanner le système de fichiers
   */
  public static async detectRooStorage(): Promise<RooStorageDetectionResult> {
    console.log('[RooStorageDetector] Début de la détection du stockage Roo via les fichiers d\'index.');
    const storagePath = process.env.ROO_STORAGE_PATH;

    if (!storagePath || !fsSyncExists.existsSync(storagePath)) {
      console.log('[RooStorageDetector] ROO_STORAGE_PATH non défini ou invalide.');
      return { found: false, locations: [], conversations: [], totalConversations: 0, totalSize: 0, errors: ['ROO_STORAGE_PATH not set or invalid'] };
    }

    const conversationsDir = path.join(storagePath, '.roo', 'conversations');
    const summaries: ConversationSummary[] = [];
    const errors: string[] = [];

    let location: RooStorageLocation = {
      globalStoragePath: storagePath,
      tasksPath: conversationsDir,
      settingsPath: path.join(storagePath, '.roo', 'settings.json'),
      exists: true
    };

    try {
      if (!fsSyncExists.existsSync(conversationsDir)) {
        console.log(`[RooStorageDetector] Le répertoire des conversations n'existe pas: ${conversationsDir}`);
        return { found: true, locations: [location], conversations: [], totalConversations: 0, totalSize: 0, errors: [] };
      }
      
      const taskDirs = await fs.readdir(conversationsDir, { withFileTypes: true });

      for (const taskDir of taskDirs) {
        if (taskDir.isDirectory()) {
          const indexPath = path.join(conversationsDir, taskDir.name, 'conversation.json.index');
          if (fsSyncExists.existsSync(indexPath)) {
            try {
              const indexContent = await fs.readFile(indexPath, 'utf-8');
              const metadata: ConversationSummary = JSON.parse(indexContent);
              summaries.push(metadata);
            } catch (err: any) {
              const errorMessage = `Erreur de lecture ou de parsing de l'index ${indexPath}: ${err.message}`;
              console.error(`[RooStorageDetector] ${errorMessage}`);
              errors.push(errorMessage);
            }
          }
        }
      }

      const totalSize = summaries.reduce((acc, s) => acc + (s.size || 0), 0);
      console.log(`[RooStorageDetector] ${summaries.length} résumés de conversation chargés. Taille totale: ${totalSize}`);
      
      return {
        found: true,
        locations: [location],
        conversations: summaries,
        totalConversations: summaries.length,
        totalSize: totalSize,
        errors: errors
      };
    } catch (error: any) {
      const errorMessage = `Erreur lors de la détection des conversations: ${error.message}`;
      console.error(`[RooStorageDetector] ${errorMessage}`);
      errors.push(errorMessage);
      return { found: true, locations: [location], conversations: [], totalConversations: 0, totalSize: 0, errors: errors };
    }
  }

 public static async findConversation(taskId: string): Promise<ConversationSummary | null> {
   const result = await this.detectRooStorage();
   const foundConversation = result.conversations.find(c => c.taskId === taskId);
   return foundConversation || null;
 }

 public static async getStorageStats(): Promise<{
   totalConversations: number;
   totalSize: number;
 }> {
   const result = await this.detectRooStorage();
   return {
     totalConversations: result.totalConversations,
     totalSize: result.totalSize,
   };
 }

  /**
   * Valide un chemin de stockage personnalisé
   */
  public static async validateCustomPath(customPath: string): Promise<boolean> {
    try {
      const normalizedPath = path.resolve(customPath);
      const conversationsFilePath = path.join(normalizedPath, '.roo', 'conversations.json');
      
      return fsSyncExists.existsSync(conversationsFilePath);
    } catch (error) {
      return false;
    }
  }
}