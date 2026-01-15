import { create } from 'xmlbuilder2';
import { ConversationSkeleton, MessageSkeleton, ActionMetadata } from '../types/conversation.js';
import { StateManagerError } from '../types/errors.js';

/**
 * Options pour l'export XML
 */
export interface XmlExportOptions {
    prettyPrint?: boolean;
    includeContent?: boolean;
    maxDepth?: number;
    compression?: 'none' | 'zip';
}

/**
 * Options pour l'export de projet
 */
export interface ProjectExportOptions extends XmlExportOptions {
    startDate?: string;
    endDate?: string;
}

/**
 * Service responsable de la génération de fichiers XML à partir des données ConversationSkeleton
 */
export class XmlExporterService {
    
    /**
     * Génère le XML pour une tâche individuelle
     */
    generateTaskXml(skeleton: ConversationSkeleton, options: XmlExportOptions = {}): string {
        const { prettyPrint = true, includeContent = false } = options;
        
        const root = create({ version: '1.0', encoding: 'UTF-8' })
            .ele('task', {
                taskId: skeleton.taskId,
                ...(skeleton.parentTaskId && { parentTaskId: skeleton.parentTaskId })
            });

        // Ajout des métadonnées
        const metadata = root.ele('metadata');
        
        if (skeleton.metadata.title) {
            metadata.ele('title').txt(skeleton.metadata.title);
        }
        
        metadata.ele('lastActivity').txt(skeleton.metadata.lastActivity);
        metadata.ele('createdAt').txt(skeleton.metadata.createdAt);
        
        if (skeleton.metadata.mode) {
            metadata.ele('mode').txt(skeleton.metadata.mode);
        }
        
        metadata.ele('messageCount').txt(skeleton.metadata.messageCount.toString());
        metadata.ele('actionCount').txt(skeleton.metadata.actionCount.toString());
        metadata.ele('totalSize').txt(skeleton.metadata.totalSize.toString());

        // Ajout de la séquence
        const sequence = root.ele('sequence');
        
        for (const item of skeleton.sequence) {
            if ('role' in item) {
                // C'est un message
                const messageElement = sequence.ele('message', {
                    role: item.role,
                    timestamp: item.timestamp,
                    ...(item.isTruncated && { isTruncated: 'true' })
                });
                
                if (includeContent) {
                    messageElement.txt(item.content);
                } else {
                    // Contenu tronqué pour l'aperçu
                    const truncatedContent = item.content.length > 100 
                        ? item.content.substring(0, 100) + '...'
                        : item.content;
                    messageElement.txt(truncatedContent);
                }
            } else {
                // C'est une action
                const actionElement = sequence.ele('action', {
                    type: item.type,
                    name: item.name,
                    status: item.status,
                    timestamp: item.timestamp,
                    ...(item.file_path && { filePath: item.file_path }),
                    ...(item.line_count && { lineCount: item.line_count.toString() }),
                    ...(item.content_size && { contentSize: item.content_size.toString() })
                });
                
                if (item.parameters && Object.keys(item.parameters).length > 0) {
                    actionElement.ele('parameters').txt(JSON.stringify(item.parameters));
                }
            }
        }

        return root.end({ prettyPrint });
    }

    /**
     * Génère le XML pour une conversation complète (tâche racine + enfants)
     */
    generateConversationXml(rootSkeleton: ConversationSkeleton, children: ConversationSkeleton[], options: XmlExportOptions = {}): string {
        const { prettyPrint = true, maxDepth = Infinity } = options;
        
        const root = create({ version: '1.0', encoding: 'UTF-8' })
            .ele('conversation', {
                conversationId: rootSkeleton.taskId,
                exportTimestamp: new Date().toISOString()
            });

        // Générer l'arbre hiérarchique des tâches
        const taskMap = new Map<string, ConversationSkeleton>();
        taskMap.set(rootSkeleton.taskId, rootSkeleton);
        children.forEach(child => taskMap.set(child.taskId, child));

        const addTaskToXml = (parentElement: any, skeleton: ConversationSkeleton, depth: number) => {
            if (depth > maxDepth) return;

            const taskElement = parentElement.ele('task', {
                taskId: skeleton.taskId,
                ...(skeleton.parentTaskId && { parentTaskId: skeleton.parentTaskId })
            });

            // Métadonnées (même logique que generateTaskXml)
            const metadata = taskElement.ele('metadata');
            
            if (skeleton.metadata.title) {
                metadata.ele('title').txt(skeleton.metadata.title);
            }
            
            metadata.ele('lastActivity').txt(skeleton.metadata.lastActivity);
            metadata.ele('createdAt').txt(skeleton.metadata.createdAt);
            
            if (skeleton.metadata.mode) {
                metadata.ele('mode').txt(skeleton.metadata.mode);
            }
            
            metadata.ele('messageCount').txt(skeleton.metadata.messageCount.toString());
            metadata.ele('actionCount').txt(skeleton.metadata.actionCount.toString());
            metadata.ele('totalSize').txt(skeleton.metadata.totalSize.toString());

            // Séquence (même logique que generateTaskXml)
            const sequence = taskElement.ele('sequence');
            
            for (const item of skeleton.sequence) {
                if ('role' in item) {
                    const messageElement = sequence.ele('message', {
                        role: item.role,
                        timestamp: item.timestamp,
                        ...(item.isTruncated && { isTruncated: 'true' })
                    });
                    
                    const truncatedContent = options.includeContent 
                        ? item.content
                        : (item.content.length > 100 ? item.content.substring(0, 100) + '...' : item.content);
                    messageElement.txt(truncatedContent);
                } else {
                    const actionElement = sequence.ele('action', {
                        type: item.type,
                        name: item.name,
                        status: item.status,
                        timestamp: item.timestamp,
                        ...(item.file_path && { filePath: item.file_path }),
                        ...(item.line_count && { lineCount: item.line_count.toString() }),
                        ...(item.content_size && { contentSize: item.content_size.toString() })
                    });
                    
                    if (item.parameters && Object.keys(item.parameters).length > 0) {
                        actionElement.ele('parameters').txt(JSON.stringify(item.parameters));
                    }
                }
            }

            // Ajouter les enfants
            const childTasks = children.filter(child => child.parentTaskId === skeleton.taskId);
            if (childTasks.length > 0) {
                const childrenElement = taskElement.ele('children');
                childTasks.forEach(childTask => {
                    addTaskToXml(childrenElement, childTask, depth + 1);
                });
            }
        };

        // Commencer par la tâche racine
        const rootTaskElement = root.ele('rootTask');
        addTaskToXml(rootTaskElement, rootSkeleton, 1);

        return root.end({ prettyPrint });
    }

    /**
     * Génère le XML pour un projet complet (résumé de toutes les conversations)
     */
    generateProjectXml(skeletons: ConversationSkeleton[], projectPath: string, options: ProjectExportOptions = {}): string {
        const { prettyPrint = true, startDate, endDate } = options;
        
        // Filtrer par date si spécifié
        let filteredSkeletons = [...skeletons];
        
        if (startDate) {
            const start = new Date(startDate);
            filteredSkeletons = filteredSkeletons.filter(s => 
                new Date(s.metadata.lastActivity) >= start
            );
        }
        
        if (endDate) {
            const end = new Date(endDate);
            filteredSkeletons = filteredSkeletons.filter(s => 
                new Date(s.metadata.lastActivity) <= end
            );
        }

        // Identifier les conversations racines (sans parentTaskId)
        const rootConversations = filteredSkeletons.filter(s => !s.parentTaskId);
        
        // Calculer les statistiques
        const totalTasks = filteredSkeletons.length;
        const totalSize = filteredSkeletons.reduce((sum, s) => sum + s.metadata.totalSize, 0);
        
        const dates = filteredSkeletons.map(s => new Date(s.metadata.lastActivity));
        const minDate = dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))) : new Date();
        const maxDate = dates.length > 0 ? new Date(Math.max(...dates.map(d => d.getTime()))) : new Date();

        const root = create({ version: '1.0', encoding: 'UTF-8' })
            .ele('projectExport');

        // Section de résumé
        const summary = root.ele('summary');
        summary.ele('projectPath').txt(projectPath);
        summary.ele('exportTimestamp').txt(new Date().toISOString());
        summary.ele('conversationCount').txt(rootConversations.length.toString());
        summary.ele('totalTasks').txt(totalTasks.toString());
        summary.ele('totalSize').txt(totalSize.toString());
        
        const dateRange = summary.ele('dateRange', {
            start: minDate.toISOString(),
            end: maxDate.toISOString()
        });

        // Liste des conversations
        const conversations = root.ele('conversations');
        
        rootConversations.forEach(rootConv => {
            // Compter les tâches enfants de cette conversation
            const childCount = filteredSkeletons.filter(s => s.parentTaskId === rootConv.taskId).length;
            const taskCount = 1 + childCount; // La tâche racine + ses enfants
            
            conversations.ele('conversation', {
                rootTaskId: rootConv.taskId,
                ...(rootConv.metadata.title && { title: rootConv.metadata.title }),
                taskCount: taskCount.toString(),
                lastActivity: rootConv.metadata.lastActivity
            });
        });

        return root.end({ prettyPrint });
    }

    /**
     * Valide un chemin de fichier pour éviter les attaques de path traversal
     */
    private validateFilePath(filePath: string): void {
        // Vérifie les patterns dangereux
        const dangerousPatterns = [
            /\.\./,  // Directory traversal
            /^[\/\\]/,  // Absolute paths
            /[<>:"|?*]/,  // Caractères interdits sur Windows
        ];

        if (dangerousPatterns.some(pattern => pattern.test(filePath))) {
            throw new StateManagerError(
                `Unsafe file path: ${filePath}`,
                'PATH_TRAVERSAL_DETECTED',
                'XmlExporterService',
                { filePath, method: 'validateFilePath' }
            );
        }

        // Vérifie que le chemin n'est pas trop long
        if (filePath.length > 260) {
            throw new StateManagerError(
                `File path too long: ${filePath}`,
                'PATH_TOO_LONG',
                'XmlExporterService',
                { filePath, length: filePath.length, maxLength: 260 }
            );
        }
    }

    /**
     * Sauvegarde le XML dans un fichier (si un chemin est fourni)
     */
    async saveXmlToFile(xmlContent: string, filePath: string): Promise<void> {
        this.validateFilePath(filePath);
        
        const fs = await import('fs/promises');
        const path = await import('path');
        
        // Créer le répertoire parent si nécessaire
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        
        // Écrire le fichier
        await fs.writeFile(filePath, xmlContent, 'utf-8');
    }
}