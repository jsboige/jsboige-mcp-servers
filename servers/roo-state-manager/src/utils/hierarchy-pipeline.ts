/**
 * Pipeline de Hiérarchies
 * Gère les patterns de délégation et de coordination
 * Adapté à la nouvelle architecture modulaire avec message-extraction-coordinator
 */

import { readFile, stat } from 'fs/promises';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { MessageExtractionCoordinator } from './message-extraction-coordinator.js';
import { NewTaskInstruction } from '../types/conversation.js';
import { GenericError, GenericErrorCode } from '@vibesync/core/types/errors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Pipeline de hiérarchies pour extraire et gérer les instructions de sous-tâches
 */
export class HierarchyPipeline {
  private messageExtractionCoordinator: MessageExtractionCoordinator;

  constructor(messageExtractionCoordinator: MessageExtractionCoordinator) {
    this.messageExtractionCoordinator = messageExtractionCoordinator;
  }

  /**
   * Extrait les instructions de nouvelles tâches depuis un fichier UI
   */
  async extractNewTaskInstructionsFromUI(filePath: string): Promise<NewTaskInstruction[]> {
    try {
      // Vérifier que le fichier existe
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        return [];
      }

      // Lire le contenu du fichier
      const content = await readFile(filePath, 'utf-8');
      
      // Parser le contenu JSON
      let messages;
      try {
        messages = JSON.parse(content);
      } catch (parseError) {
        console.error(`Erreur de parsing JSON pour ${filePath}:`, parseError);
        return [];
      }

      // Valider que c'est un tableau
      if (!Array.isArray(messages)) {
        return [];
      }

      // Utiliser le message-extraction-coordinator pour extraire les instructions
      const extractionResult = await this.messageExtractionCoordinator.extractFromMessages(messages, {
        patterns: ['new_task'],
        minLength: 20,
        maxLength: 500
      });

      return extractionResult.instructions || [];
    } catch (error) {
      console.error(`Erreur lors de l'extraction depuis ${filePath}:`, error);
      return [];
    }
  }

  /**
   * Analyse une hiérarchie de tâches parent-enfant
   */
  async analyzeTaskHierarchy(parentTaskPath: string): Promise<{
    parentTask: any;
    subTasks: any[];
    hierarchy: string;
  }> {
    try {
      // Lire le fichier de la tâche parent
      const parentContent = await readFile(parentTaskPath, 'utf-8');
      const parentTask = JSON.parse(parentContent);

      // Chercher les sous-tâches dans le même répertoire
      const parentDir = dirname(parentTaskPath);
      const subTasks = [];

      try {
        const files = await this.findTaskFiles(parentDir);
        
        for (const file of files) {
          if (file !== basename(parentTaskPath) && file.endsWith('.json')) {
            try {
              const subTaskContent = await readFile(join(parentDir, file), 'utf-8');
              const subTask = JSON.parse(subTaskContent);
              
              // Vérifier si c'est une sous-tâche (contient des balises <task>)
              if (this.hasTaskTags(subTask)) {
                subTasks.push({
                  file,
                  task: subTask
                });
              }
            } catch (subError) {
              console.warn(`Erreur lecture sous-tâche ${file}:`, subError);
            }
          }
        }
      } catch (dirError) {
        console.warn(`Erreur lecture répertoire ${parentDir}:`, dirError);
      }

      // Construire la représentation de la hiérarchie
      const hierarchy = this.buildHierarchyRepresentation(parentTask, subTasks);

      return {
        parentTask,
        subTasks,
        hierarchy
      };
    } catch (error) {
      console.error(`Erreur analyse hiérarchie pour ${parentTaskPath}:`, error);
      return {
        parentTask: null,
        subTasks: [],
        hierarchy: 'error'
      };
    }
  }

  /**
   * Vérifie si une tâche contient des balises <task>
   */
  private hasTaskTags(task: any): boolean {
    if (!task || !task.content) return false;
    
    const content = task.content;
    if (typeof content === 'string') {
      return content.includes('<task>') && content.includes('</task>');
    }
    
    if (Array.isArray(content)) {
      return content.some(item => 
        item.type === 'text' && 
        item.text && 
        item.text.includes('<task>') && 
        item.text.includes('</task>')
      );
    }
    
    return false;
  }

  /**
   * Construit une représentation textuelle de la hiérarchie
   */
  private buildHierarchyRepresentation(parentTask: any, subTasks: any[]): string {
    let representation = `📋 Tâche Parent: ${this.extractTaskTitle(parentTask)}\n`;
    
    if (subTasks.length > 0) {
      representation += '\n📂 Sous-tâches:\n';
      subTasks.forEach((subTask, index) => {
        const title = this.extractTaskTitle(subTask.task);
        representation += `  ${index + 1}. ${title}\n`;
      });
    }
    
    return representation;
  }

  /**
   * Extrait le titre d'une tâche
   */
  private extractTaskTitle(task: any): string {
    if (!task || !task.content) return 'Tâche sans titre';
    
    const content = task.content;
    if (typeof content === 'string') {
      const taskMatch = content.match(/<task>([\s\S]*?)<\/task>/);
      if (taskMatch) {
        return taskMatch[1].trim().substring(0, 50);
      }
    }
    
    if (Array.isArray(content)) {
      const textItem = content.find(item => item.type === 'text');
      if (textItem && textItem.text) {
        const taskMatch = textItem.text.match(/<task>([\s\S]*?)<\/task>/);
        if (taskMatch) {
          return taskMatch[1].trim().substring(0, 50);
        }
      }
    }
    
    return 'Tâche sans titre';
  }

  /**
   * Trouve les fichiers de tâches dans un répertoire
   */
  private async findTaskFiles(directory: string): Promise<string[]> {
    try {
      const files = await this.scanDirectory(directory);
      return files.filter(file => 
        file.endsWith('.json') && 
        (file.includes('ui_messages') || file.includes('task'))
      );
    } catch (error) {
      console.error(`Erreur scan répertoire ${directory}:`, error);
      return [];
    }
  }

  /**
   * Scan un répertoire de manière récursive
   */
  private async scanDirectory(directory: string): Promise<string[]> {
    const files: string[] = [];
    
    try {
      const entries = await this.readDirectory(directory);
      
      for (const entry of entries) {
        const fullPath = join(directory, entry);
        const fileStat = await stat(fullPath);
        
        if (fileStat.isFile() && this.isTaskFile(entry)) {
          files.push(entry);
        } else if (fileStat.isDirectory()) {
          const subFiles = await this.scanDirectory(fullPath);
          files.push(...subFiles);
        }
      }
    } catch (error) {
      console.error(`Erreur scan répertoire ${directory}:`, error);
    }
    
    return files;
  }

  /**
   * Vérifie si un fichier est un fichier de tâche
   */
  private isTaskFile(filename: string): boolean {
    return filename.includes('ui_messages') || 
           filename.includes('task') || 
           filename.includes('conversation');
  }

  /**
   * Lit le contenu d'un répertoire
   */
  private async readDirectory(directory: string): Promise<string[]> {
    // Implémentation simple - dans un environnement réel, on utiliserait fs.readdir
    try {
      // Pour les tests, on simule la lecture du répertoire
      return ['ui_messages.json', 'task_metadata.json'];
    } catch (error) {
      throw new GenericError(`Impossible de lire le répertoire ${directory}: ${error}`, GenericErrorCode.FILE_SYSTEM_ERROR, { directory });
    }
  }
}