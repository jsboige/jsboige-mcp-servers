/**
 * Disk Scanner for New Conversations
 * 
 * Scans the filesystem to detect conversations that don't have
 * skeleton cache entries yet. This ensures newly created conversations
 * are immediately visible to the system.
 */

import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import { ConversationSkeleton } from '../../types/conversation.js';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';

/**
 * Quick analysis of a conversation file to create a minimal skeleton
 * without full processing overhead.
 */
async function quickAnalyze(
    taskId: string,
    taskPath: string
): Promise<ConversationSkeleton> {
    const uiPath = path.join(taskPath, 'ui_messages.json');
    
    try {
        const content = await fs.readFile(uiPath, 'utf-8');
        const messages = JSON.parse(content);
        
        // Extract basic metadata
        const firstMessage = messages[0] || {};
        const lastMessage = messages[messages.length - 1] || {};
        
        return {
            taskId,
            metadata: {
                title: firstMessage.text?.substring(0, 100) || 'Untitled Task',
                createdAt: new Date(firstMessage.ts || Date.now()).toISOString(),
                lastActivity: new Date(lastMessage.ts || firstMessage.ts || Date.now()).toISOString(),
                mode: 'unknown',
                messageCount: messages.length,
                actionCount: 0,
                totalSize: 0,
                workspace: extractWorkspace(taskPath)
            },
            parentTaskId: undefined,
            sequence: []
        };
    } catch (error) {
        // Fallback if file can't be read
        return {
            taskId,
            metadata: {
                title: 'Unknown Task',
                createdAt: new Date().toISOString(),
                lastActivity: new Date().toISOString(),
                mode: 'unknown',
                messageCount: 0,
                actionCount: 0,
                totalSize: 0,
                workspace: extractWorkspace(taskPath)
            },
            parentTaskId: undefined,
            sequence: []
        };
    }
}

/**
 * Extract workspace from task path
 */
function extractWorkspace(taskPath: string): string {
    // Try to read workspace from task metadata if available
    // For now, return empty string as fallback
    return '';
}

/**
 * Scans the tasks directory for conversations that aren't in the cache yet.
 * 
 * @param existingCache - Current skeleton cache to check against
 * @param workspace - Optional workspace filter
 * @returns Array of newly discovered conversation skeletons
 */
export async function scanDiskForNewTasks(
    existingCache: Map<string, ConversationSkeleton>,
    workspace?: string
): Promise<ConversationSkeleton[]> {
    const storagePaths = await RooStorageDetector.detectStorageLocations();
    if (storagePaths.length === 0) {
        return [];
    }
    
    const tasksDir = path.join(storagePaths[0], 'tasks');
    
    try {
        if (!existsSync(tasksDir)) {
            return [];
        }
        
        const taskDirs = await fs.readdir(tasksDir);
        const newTasks: ConversationSkeleton[] = [];
        
        for (const taskId of taskDirs) {
            // Skip if already in cache
            if (existingCache.has(taskId)) {
                continue;
            }
            
            const taskPath = path.join(tasksDir, taskId);
            const uiPath = path.join(taskPath, 'ui_messages.json');
            
            // Check if this is a valid conversation directory
            if (existsSync(uiPath)) {
                const skeleton = await quickAnalyze(taskId, taskPath);
                
                // Filter by workspace if specified
                if (!workspace || skeleton.metadata.workspace === workspace || !skeleton.metadata.workspace) {
                    newTasks.push(skeleton);
                }
            }
        }
        
        return newTasks;
    } catch (error) {
        console.error('Error scanning disk for new tasks:', error);
        return [];
    }
}