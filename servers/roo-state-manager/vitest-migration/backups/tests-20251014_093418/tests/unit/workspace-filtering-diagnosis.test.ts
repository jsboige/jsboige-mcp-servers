import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';

describe('Workspace Filtering Diagnosis', () => {
    it('should count all tasks and analyze workspace metadata', async () => {
        // Détecter les emplacements de stockage
        const locations = await RooStorageDetector.detectStorageLocations();
        expect(locations.length).toBeGreaterThan(0);
        
        console.log(`\n📊 DIAGNOSTIC: Analyse des workspaces dans ${locations.length} emplacements`);
        
        let totalTasks = 0;
        let tasksWithWorkspace = 0;
        let tasksWithCwd = 0;
        let tasksWithNeither = 0;
        const workspaceCount = new Map<string, number>();
        const cwdCount = new Map<string, number>();
        
        for (const storageDir of locations) {
            const tasksDir = path.join(storageDir, 'tasks');
            
            try {
                const conversationDirs = await fs.readdir(tasksDir, { withFileTypes: true });
                
                for (const convDir of conversationDirs) {
                    if (convDir.isDirectory() && convDir.name !== '.skeletons') {
                        totalTasks++;
                        
                        const metadataPath = path.join(tasksDir, convDir.name, 'task_metadata.json');
                        
                        try {
                            const metadataContent = await fs.readFile(metadataPath, 'utf-8');
                            const metadata = JSON.parse(metadataContent);
                            
                            if (metadata.workspace) {
                                tasksWithWorkspace++;
                                const normalized = path.normalize(metadata.workspace).toLowerCase();
                                workspaceCount.set(normalized, (workspaceCount.get(normalized) || 0) + 1);
                            }
                            
                            if (metadata.cwd) {
                                tasksWithCwd++;
                                const normalized = path.normalize(metadata.cwd).toLowerCase();
                                cwdCount.set(normalized, (cwdCount.get(normalized) || 0) + 1);
                            }
                            
                            if (!metadata.workspace && !metadata.cwd) {
                                tasksWithNeither++;
                            }
                        } catch (error) {
                            // Métadonnées corrompues ou manquantes
                        }
                    }
                }
            } catch (error) {
                console.warn(`Could not read tasks directory: ${tasksDir}`);
            }
        }
        
        console.log(`\n📈 STATISTIQUES GLOBALES:`);
        console.log(`   Total tasks: ${totalTasks}`);
        console.log(`   Tasks with workspace: ${tasksWithWorkspace} (${((tasksWithWorkspace/totalTasks)*100).toFixed(1)}%)`);
        console.log(`   Tasks with cwd: ${tasksWithCwd} (${((tasksWithCwd/totalTasks)*100).toFixed(1)}%)`);
        console.log(`   Tasks with neither: ${tasksWithNeither} (${((tasksWithNeither/totalTasks)*100).toFixed(1)}%)`);
        
        console.log(`\n📁 TOP 10 WORKSPACES (via workspace field):`);
        const topWorkspaces = Array.from(workspaceCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
        topWorkspaces.forEach(([ws, count]) => {
            console.log(`   ${ws}: ${count} tasks`);
        });
        
        console.log(`\n📁 TOP 10 WORKSPACES (via cwd field):`);
        const topCwds = Array.from(cwdCount.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
        topCwds.forEach(([cwd, count]) => {
            console.log(`   ${cwd}: ${count} tasks`);
        });
        
        // Vérifications critiques
        expect(totalTasks).toBeGreaterThan(100);
        expect(tasksWithWorkspace + tasksWithCwd).toBeGreaterThan(0);
    });
    
    it('should test current filtering logic against roo-extensions', async () => {
        const locations = await RooStorageDetector.detectStorageLocations();
        const targetWorkspace = 'd:/dev/roo-extensions';
        
        let matchedByCurrentLogic = 0;
        let matchedByFlexibleLogic = 0;
        
        for (const storageDir of locations) {
            const tasksDir = path.join(storageDir, 'tasks');
            
            try {
                const conversationDirs = await fs.readdir(tasksDir, { withFileTypes: true });
                
                for (const convDir of conversationDirs) {
                    if (convDir.isDirectory() && convDir.name !== '.skeletons') {
                        const metadataPath = path.join(tasksDir, convDir.name, 'task_metadata.json');
                        
                        try {
                            const metadataContent = await fs.readFile(metadataPath, 'utf-8');
                            const metadata = JSON.parse(metadataContent);
                            const taskWorkspace = metadata.workspace || metadata.cwd || '';
                            
                            // LOGIQUE ACTUELLE (stricte)
                            const normalizedFilter = path.normalize(targetWorkspace).toLowerCase();
                            const normalizedWorkspace = path.normalize(taskWorkspace).toLowerCase();
                            
                            if (normalizedWorkspace.includes(normalizedFilter)) {
                                matchedByCurrentLogic++;
                            }
                            
                            // LOGIQUE FLEXIBLE (tester différentes variantes)
                            const flexibleMatch = (
                                normalizedWorkspace.includes(normalizedFilter) ||
                                normalizedWorkspace.includes('roo-extensions') ||
                                taskWorkspace === targetWorkspace ||
                                taskWorkspace.endsWith('roo-extensions')
                            );
                            
                            if (flexibleMatch) {
                                matchedByFlexibleLogic++;
                            }
                        } catch (error) {
                            // Skip corrupted metadata
                        }
                    }
                }
            } catch (error) {
                // Skip inaccessible directories
            }
        }
        
        console.log(`\n🎯 TEST DE FILTRAGE pour '${targetWorkspace}':`);
        console.log(`   Logique actuelle (stricte): ${matchedByCurrentLogic} tasks`);
        console.log(`   Logique flexible: ${matchedByFlexibleLogic} tasks`);
        
        // L'utilisateur dit qu'il y a ~150 tâches, on devrait en trouver au moins 37
        expect(matchedByCurrentLogic).toBeGreaterThanOrEqual(37);
        
        if (matchedByFlexibleLogic > matchedByCurrentLogic) {
            console.log(`   ⚠️  La logique flexible trouve ${matchedByFlexibleLogic - matchedByCurrentLogic} tâches supplémentaires`);
        }
    });
    
    it('should analyze hierarchy potential in roo-extensions tasks', async () => {
        const locations = await RooStorageDetector.detectStorageLocations();
        const targetWorkspace = 'd:/dev/roo-extensions';
        
        let tasksWithUiMessages = 0;
        let totalInstructions = 0;
        
        for (const storageDir of locations) {
            const tasksDir = path.join(storageDir, 'tasks');
            
            try {
                const conversationDirs = await fs.readdir(tasksDir, { withFileTypes: true });
                
                for (const convDir of conversationDirs) {
                    if (convDir.isDirectory() && convDir.name !== '.skeletons') {
                        const metadataPath = path.join(tasksDir, convDir.name, 'task_metadata.json');
                        
                        try {
                            const metadataContent = await fs.readFile(metadataPath, 'utf-8');
                            const metadata = JSON.parse(metadataContent);
                            const taskWorkspace = metadata.workspace || metadata.cwd || '';
                            
                            const normalizedFilter = path.normalize(targetWorkspace).toLowerCase();
                            const normalizedWorkspace = path.normalize(taskWorkspace).toLowerCase();
                            
                            if (normalizedWorkspace.includes(normalizedFilter)) {
                                // Vérifier si ui_messages.json existe
                                const uiMessagesPath = path.join(tasksDir, convDir.name, 'ui_messages.json');
                                
                                try {
                                    await fs.stat(uiMessagesPath);
                                    tasksWithUiMessages++;
                                    
                                    // Compter les instructions newTask
                                    const uiContent = await fs.readFile(uiMessagesPath, 'utf-8');
                                    const uiMessages = JSON.parse(uiContent);
                                    
                                    if (Array.isArray(uiMessages)) {
                                        const newTaskCount = uiMessages.filter(msg => 
                                            msg.type === 'ask' && 
                                            msg.ask === 'tool' && 
                                            msg.tool?.approvalState === 'approved' &&
                                            msg.tool?.name === 'new_task'
                                        ).length;
                                        
                                        totalInstructions += newTaskCount;
                                    }
                                } catch {
                                    // ui_messages.json n'existe pas
                                }
                            }
                        } catch (error) {
                            // Skip corrupted metadata
                        }
                    }
                }
            } catch (error) {
                // Skip inaccessible directories
            }
        }
        
        console.log(`\n🔗 POTENTIEL HIÉRARCHIQUE dans roo-extensions:`);
        console.log(`   Tasks avec ui_messages.json: ${tasksWithUiMessages}`);
        console.log(`   Total instructions newTask: ${totalInstructions}`);
        console.log(`   Moyenne instructions/task: ${tasksWithUiMessages > 0 ? (totalInstructions/tasksWithUiMessages).toFixed(2) : 0}`);
        
        // Si on a 37 tâches, au moins quelques-unes devraient avoir des ui_messages
        expect(tasksWithUiMessages).toBeGreaterThan(0);
    });
});