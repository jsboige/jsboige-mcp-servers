/**
 * Outil MCP : debug_task_parsing
 * Analyse en détail le parsing d'une tâche spécifique pour diagnostiquer les problèmes hiérarchiques
 */

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { RooStorageDetector } from '../../utils/roo-storage-detector.js';

export interface DebugTaskParsingArgs {
    task_id: string;
}

/**
 * Définition de l'outil debug_task_parsing
 */
export const debugTaskParsingTool = {
    name: 'debug_task_parsing',
    description: 'Analyse en détail le parsing d\'une tâche spécifique pour diagnostiquer les problèmes hiérarchiques.',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: { 
                type: 'string', 
                description: 'ID de la tâche à analyser en détail.' 
            }
        },
        required: ['task_id']
    }
};

/**
 * Handler pour debug_task_parsing
 * Analyse le parsing d'une tâche et retourne des informations de diagnostic
 */
export async function handleDebugTaskParsing(
    args: DebugTaskParsingArgs
): Promise<CallToolResult> {
    const { task_id } = args;
    
    console.log(`🔍 DEBUG: Starting detailed analysis of task ${task_id}`);
    const debugInfo: string[] = [];
    
    try {
        // Trouver le chemin de la tâche
        const locations = await RooStorageDetector.detectStorageLocations();
        let taskPath = null;
        
        for (const baseDir of locations) {
            const tasksDir = path.join(baseDir, 'tasks');
            const potentialPath = path.join(tasksDir, task_id);
            if (existsSync(potentialPath)) {
                taskPath = potentialPath;
                break;
            }
        }
        
        if (!taskPath) {
            return { content: [{ type: 'text', text: `Task ${task_id} not found in any storage location` }] };
        }
        
        debugInfo.push(`📁 Task path: ${taskPath}`);
        
        // Analyser les fichiers
        const uiMessagesPath = path.join(taskPath, 'ui_messages.json');
        const apiHistoryPath = path.join(taskPath, 'api_conversation_history.json');
        
        debugInfo.push(`📄 UI Messages: ${existsSync(uiMessagesPath) ? '✅ EXISTS' : '❌ MISSING'}`);
        debugInfo.push(`📄 API History: ${existsSync(apiHistoryPath) ? '✅ EXISTS' : '❌ MISSING'}`);
        
        // Analyser le contenu pour les balises <task>
        if (existsSync(uiMessagesPath)) {
            let content = await fs.readFile(uiMessagesPath, 'utf-8');
            if (content.charCodeAt(0) === 0xFEFF) {
                content = content.slice(1);
            }
            
            const messages = JSON.parse(content);
            debugInfo.push(`📊 UI Messages count: ${messages.length}`);
            
            let taskTagCount = 0;
            let newTaskTagCount = 0;
            
            for (let i = 0; i < messages.length; i++) {
                const message = messages[i];
                let contentText = '';
                
                if (typeof message.content === 'string') {
                    contentText = message.content;
                } else if (Array.isArray(message.content)) {
                    for (const item of message.content) {
                        if (item.type === 'text' && typeof item.text === 'string') {
                            contentText += item.text + '\n';
                        }
                    }
                }
                
                const taskMatches = contentText.match(/<task>/g);
                const newTaskMatches = contentText.match(/<new_task>/g);
                
                if (taskMatches) {
                    taskTagCount += taskMatches.length;
                    debugInfo.push(`🎯 Message ${i} (${message.role}): Found ${taskMatches.length} <task> tags`);
                    
                    // Extraire le contenu de la première balise <task>
                    const taskPattern = /<task>([\s\S]*?)<\/task>/gi;
                    const match = taskPattern.exec(contentText);
                    if (match) {
                        debugInfo.push(`   Content preview: "${match[1].trim().substring(0, 100)}..."`);
                    }
                }
                
                if (newTaskMatches) {
                    newTaskTagCount += newTaskMatches.length;
                    debugInfo.push(`🎯 Message ${i} (${message.role}): Found ${newTaskMatches.length} <new_task> tags`);
                }
            }
            
            debugInfo.push(`📈 Total <task> tags found: ${taskTagCount}`);
            debugInfo.push(`📈 Total <new_task> tags found: ${newTaskTagCount}`);
        }
        
        // Test du parsing avec RooStorageDetector
        debugInfo.push(`\n🧪 TESTING RooStorageDetector.analyzeConversation...`);
        const skeleton = await RooStorageDetector.analyzeConversation(task_id, taskPath);
        
        if (skeleton) {
            debugInfo.push(`✅ Analysis complete:`);
            debugInfo.push(`   - TaskId: ${skeleton.taskId}`);
            debugInfo.push(`   - ParentTaskId: ${skeleton.parentTaskId || 'NONE'}`);
            debugInfo.push(`   - TruncatedInstruction: ${skeleton.truncatedInstruction ? `"${skeleton.truncatedInstruction.substring(0, 100)}..."` : 'NONE'}`);
            debugInfo.push(`   - ChildTaskInstructionPrefixes: ${skeleton.childTaskInstructionPrefixes?.length || 0} prefixes`);
            
            if (skeleton.childTaskInstructionPrefixes && skeleton.childTaskInstructionPrefixes.length > 0) {
                debugInfo.push(`   - Prefixes preview:`);
                skeleton.childTaskInstructionPrefixes.slice(0, 3).forEach((prefix, i) => {
                    debugInfo.push(`     ${i+1}. "${prefix.substring(0, 80)}..."`);
                });
            }
        } else {
            debugInfo.push(`❌ Analysis returned null`);
        }
        
    } catch (error: any) {
        debugInfo.push(`❌ ERROR: ${error?.message || 'Unknown error'}`);
    }
    
    return { content: [{ type: 'text', text: debugInfo.join('\n') }] };
}