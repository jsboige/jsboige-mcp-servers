#!/usr/bin/env node
/**
 * Script de diagnostic pour analyser le filtrage des workspaces
 * et identifier pourquoi seulement 37 tâches sont trouvées pour roo-extensions
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Chemin de stockage Roo
const STORAGE_BASE = 'C:\\Users\\jsboi\\AppData\\Roaming\\Code\\User\\globalStorage\\rooveterinaryinc.roo-cline';
const TARGET_WORKSPACE = 'd:/dev/roo-extensions';

async function main() {
    console.log('🔍 DIAGNOSTIC: Analyse du filtrage par workspace\n');
    
    const tasksDir = path.join(STORAGE_BASE, 'tasks');
    
    // Stats globales
    let totalTasks = 0;
    let tasksWithWorkspace = 0;
    let tasksWithCwd = 0;
    let tasksWithNeither = 0;
    const workspaceCount = new Map();
    const cwdCount = new Map();
    
    // Stats pour roo-extensions
    let matchedByCurrentLogic = 0;
    let tasksWithUiMessages = 0;
    let totalNewTaskInstructions = 0;
    
    try {
        const conversationDirs = await fs.readdir(tasksDir, { withFileTypes: true });
        console.log(`📁 Scanning ${conversationDirs.length} directories in ${tasksDir}\n`);
        
        for (const convDir of conversationDirs) {
            if (!convDir.isDirectory() || convDir.name === '.skeletons') {
                continue;
            }
            
            totalTasks++;
            
            const metadataPath = path.join(tasksDir, convDir.name, 'task_metadata.json');
            
            try {
                const metadataContent = await fs.readFile(metadataPath, 'utf-8');
                const metadata = JSON.parse(metadataContent);
                
                const workspace = metadata.workspace || '';
                const cwd = metadata.cwd || '';
                
                if (workspace) {
                    tasksWithWorkspace++;
                    const normalized = path.normalize(workspace).toLowerCase();
                    workspaceCount.set(normalized, (workspaceCount.get(normalized) || 0) + 1);
                }
                
                if (cwd) {
                    tasksWithCwd++;
                    const normalized = path.normalize(cwd).toLowerCase();
                    cwdCount.set(normalized, (cwdCount.get(normalized) || 0) + 1);
                }
                
                if (!workspace && !cwd) {
                    tasksWithNeither++;
                }
                
                // Test du filtre actuel pour roo-extensions
                const taskWorkspace = workspace || cwd || '';
                const normalizedFilter = path.normalize(TARGET_WORKSPACE).toLowerCase();
                const normalizedWorkspace = path.normalize(taskWorkspace).toLowerCase();
                
                if (normalizedWorkspace.includes(normalizedFilter)) {
                    matchedByCurrentLogic++;
                    
                    // Vérifier ui_messages.json
                    const uiMessagesPath = path.join(tasksDir, convDir.name, 'ui_messages.json');
                    try {
                        await fs.stat(uiMessagesPath);
                        tasksWithUiMessages++;
                        
                        // Compter les newTask
                        const uiContent = await fs.readFile(uiMessagesPath, 'utf-8');
                        const uiMessages = JSON.parse(uiContent);
                        
                        if (Array.isArray(uiMessages)) {
                            // NOUVEAU: Pattern api_req_started - [new_task in X mode: 'Y']
                            uiMessages.forEach(msg => {
                                if (msg.type === 'say' && msg.say === 'api_req_started' && typeof msg.text === 'string') {
                                    const newTaskApiPattern = /\[new_task in ([^:]+):\s*['"]([^'"]+)['"]\]/g;
                                    let match;
                                    while ((match = newTaskApiPattern.exec(msg.text)) !== null) {
                                        totalNewTaskInstructions++;
                                    }
                                }
                            });
                            
                            // Ancien pattern (garder pour compatibilité)
                            const oldPatternCount = uiMessages.filter(msg =>
                                msg.type === 'ask' &&
                                msg.ask === 'tool' &&
                                msg.tool?.approvalState === 'approved' &&
                                msg.tool?.name === 'new_task'
                            ).length;
                            
                            totalNewTaskInstructions += oldPatternCount;
                        }
                    } catch {
                        // ui_messages.json n'existe pas
                    }
                }
            } catch (error) {
                // Métadonnées corrompues ou manquantes - ignorer
            }
            
            if (totalTasks % 500 === 0) {
                console.log(`   Processed ${totalTasks} tasks...`);
            }
        }
        
        // Affichage des résultats
        console.log('\n' + '='.repeat(80));
        console.log('📊 STATISTIQUES GLOBALES');
        console.log('='.repeat(80));
        console.log(`Total tasks: ${totalTasks}`);
        console.log(`Tasks with workspace field: ${tasksWithWorkspace} (${((tasksWithWorkspace/totalTasks)*100).toFixed(1)}%)`);
        console.log(`Tasks with cwd field: ${tasksWithCwd} (${((tasksWithCwd/totalTasks)*100).toFixed(1)}%)`);
        console.log(`Tasks with neither: ${tasksWithNeither} (${((tasksWithNeither/totalTasks)*100).toFixed(1)}%)`);
        
        console.log('\n' + '='.repeat(80));
        console.log('📁 TOP 10 WORKSPACES (via workspace field)');
        console.log('='.repeat(80));
        const topWorkspaces = Array.from(workspaceCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
        topWorkspaces.forEach(([ws, count]) => {
            console.log(`${count.toString().padStart(5)} tasks: ${ws}`);
        });
        
        console.log('\n' + '='.repeat(80));
        console.log('📁 TOP 10 WORKSPACES (via cwd field)');
        console.log('='.repeat(80));
        const topCwds = Array.from(cwdCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
        topCwds.forEach(([cwd, count]) => {
            console.log(`${count.toString().padStart(5)} tasks: ${cwd}`);
        });
        
        console.log('\n' + '='.repeat(80));
        console.log(`🎯 ANALYSE POUR '${TARGET_WORKSPACE}'`);
        console.log('='.repeat(80));
        console.log(`Tasks matched by current logic: ${matchedByCurrentLogic}`);
        console.log(`Tasks with ui_messages.json: ${tasksWithUiMessages}`);
        console.log(`Total newTask instructions: ${totalNewTaskInstructions}`);
        if (tasksWithUiMessages > 0) {
            console.log(`Average newTask per task: ${(totalNewTaskInstructions/tasksWithUiMessages).toFixed(2)}`);
        }
        
        console.log('\n' + '='.repeat(80));
        console.log('🔍 DIAGNOSTIC');
        console.log('='.repeat(80));
        
        if (matchedByCurrentLogic === 37) {
            console.log('✅ Le filtre actuel trouve exactement 37 tâches (confirmé)');
        } else {
            console.log(`⚠️  Le filtre trouve ${matchedByCurrentLogic} tâches (attendu: 37)`);
        }
        
        if (tasksWithUiMessages < matchedByCurrentLogic * 0.3) {
            console.log(`⚠️  Seulement ${tasksWithUiMessages}/${matchedByCurrentLogic} tâches ont ui_messages.json (${((tasksWithUiMessages/matchedByCurrentLogic)*100).toFixed(1)}%)`);
            console.log('    → Cela limite le nombre de parents potentiels dans la hiérarchie');
        }
        
        if (totalNewTaskInstructions < 50) {
            console.log(`⚠️  Seulement ${totalNewTaskInstructions} instructions newTask trouvées au total`);
            console.log('    → Index RadixTree sera petit, matching limité');
        }
        
        const orphanRate = (tasksWithNeither / totalTasks) * 100;
        if (orphanRate > 50) {
            console.log(`⚠️  ${orphanRate.toFixed(1)}% des tâches n'ont ni workspace ni cwd`);
            console.log('    → Ces tâches sont exclues du filtrage par workspace');
        }
        
    } catch (error) {
        console.error('❌ Erreur:', error);
        process.exit(1);
    }
}

main();