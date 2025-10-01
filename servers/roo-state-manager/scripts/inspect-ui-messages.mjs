#!/usr/bin/env node
/**
 * Script pour inspecter le format réel des ui_messages.json
 * et comprendre pourquoi aucune instruction newTask n'est détectée
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const STORAGE_BASE = 'C:\\Users\\jsboi\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline';
const TARGET_WORKSPACE = 'd:/dev/roo-extensions';

async function main() {
    console.log('🔍 INSPECTION: Format des ui_messages.json\n');
    
    const tasksDir = path.join(STORAGE_BASE, 'tasks');
    const conversationDirs = await fs.readdir(tasksDir, { withFileTypes: true });
    
    let inspected = 0;
    
    for (const convDir of conversationDirs) {
        if (!convDir.isDirectory() || convDir.name === '.skeletons') {
            continue;
        }
        
        // Vérifier si c'est une tâche roo-extensions
        const metadataPath = path.join(tasksDir, convDir.name, 'task_metadata.json');
        try {
            const metadataContent = await fs.readFile(metadataPath, 'utf-8');
            const metadata = JSON.parse(metadataContent);
            const taskWorkspace = metadata.workspace || metadata.cwd || '';
            
            const normalizedFilter = path.normalize(TARGET_WORKSPACE).toLowerCase();
            const normalizedWorkspace = path.normalize(taskWorkspace).toLowerCase();
            
            if (!normalizedWorkspace.includes(normalizedFilter)) {
                continue;
            }
            
            // Inspecter ui_messages.json
            const uiMessagesPath = path.join(tasksDir, convDir.name, 'ui_messages.json');
            try {
                const uiContent = await fs.readFile(uiMessagesPath, 'utf-8');
                const uiMessages = JSON.parse(uiContent);
                
                console.log('='.repeat(80));
                console.log(`📄 Task: ${convDir.name}`);
                console.log('='.repeat(80));
                console.log(`Type: ${Array.isArray(uiMessages) ? 'Array' : typeof uiMessages}`);
                console.log(`Length: ${Array.isArray(uiMessages) ? uiMessages.length : 'N/A'}`);
                
                if (Array.isArray(uiMessages) && uiMessages.length > 0) {
                    // Analyser les types de messages
                    const messageTypes = new Map();
                    const askTypes = new Map();
                    const toolNames = new Map();
                    
                    uiMessages.forEach(msg => {
                        const type = msg.type || 'unknown';
                        messageTypes.set(type, (messageTypes.get(type) || 0) + 1);
                        
                        if (msg.ask) {
                            askTypes.set(msg.ask, (askTypes.get(msg.ask) || 0) + 1);
                        }
                        
                        if (msg.tool?.name) {
                            toolNames.set(msg.tool.name, (toolNames.get(msg.tool.name) || 0) + 1);
                        }
                    });
                    
                    console.log('\nMessage types:');
                    Array.from(messageTypes.entries()).forEach(([type, count]) => {
                        console.log(`  ${type}: ${count}`);
                    });
                    
                    console.log('\nAsk types:');
                    Array.from(askTypes.entries()).forEach(([ask, count]) => {
                        console.log(`  ${ask}: ${count}`);
                    });
                    
                    console.log('\nTool names:');
                    Array.from(toolNames.entries()).forEach(([name, count]) => {
                        console.log(`  ${name}: ${count}`);
                    });
                    
                    // Chercher des exemples de newTask
                    const newTaskMessages = uiMessages.filter(msg =>
                        msg.type === 'ask' &&
                        msg.ask === 'tool' &&
                        msg.tool?.name === 'new_task'
                    );
                    
                    console.log(`\nNew task messages found: ${newTaskMessages.length}`);
                    
                    if (newTaskMessages.length > 0) {
                        console.log('\n📋 Example new_task message:');
                        console.log(JSON.stringify(newTaskMessages[0], null, 2).substring(0, 500));
                    }
                    
                    // Chercher d'autres patterns possibles
                    const alternativePatterns = uiMessages.filter(msg =>
                        (msg.tool?.name === 'new_task') ||
                        (msg.text && msg.text.includes('new_task')) ||
                        (JSON.stringify(msg).includes('new_task'))
                    );
                    
                    if (alternativePatterns.length > 0 && newTaskMessages.length === 0) {
                        console.log(`\n⚠️  Found ${alternativePatterns.length} messages mentioning 'new_task' but not matching expected pattern`);
                        console.log('\n📋 Example alternative pattern:');
                        console.log(JSON.stringify(alternativePatterns[0], null, 2).substring(0, 500));
                    }
                }
                
                inspected++;
                if (inspected >= 3) {
                    console.log('\n' + '='.repeat(80));
                    console.log(`Inspected ${inspected} files (stopping for brevity)`);
                    break;
                }
                
            } catch (error) {
                console.error(`Error reading ui_messages.json: ${error.message}`);
            }
            
        } catch (error) {
            // Skip tasks with invalid metadata
        }
    }
    
    if (inspected === 0) {
        console.log('⚠️  No ui_messages.json files found for roo-extensions tasks');
    }
}

main();