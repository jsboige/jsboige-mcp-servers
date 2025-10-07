/**
 * Test spécialisé pour l'extraction des instructions new_task
 * Recherche dans les fichiers ui_messages.json pour identifier les patterns
 */

import { RooStorageDetector } from './build/src/utils/roo-storage-detector.js';
import * as fs from 'fs/promises';
import * as path from 'path';

async function testNewTaskExtraction() {
    console.log('🔍 === TEST EXTRACTION INSTRUCTIONS NEW_TASK ===\n');

    try {
        // Obtenir les emplacements de stockage
        const storageLocations = await RooStorageDetector.detectStorageLocations();
        if (storageLocations.length === 0) {
            console.log('❌ Aucun emplacement de stockage trouvé');
            return;
        }

        console.log(`📂 Scanning ${storageLocations.length} emplacements...\n`);

        let totalFiles = 0;
        let filesWithNewTask = 0;
        let extractionTests = [];

        for (const locationPath of storageLocations) {
            const tasksPath = path.join(locationPath, 'tasks');
            
            try {
                const taskDirs = await fs.readdir(tasksPath);
                console.log(`📁 Analysant ${taskDirs.length} tâches dans ${locationPath}`);

                // Limiter à 10 tâches pour les tests
                const limitedTasks = taskDirs.slice(0, 10);

                for (const taskId of limitedTasks) {
                    const taskPath = path.join(tasksPath, taskId);
                    const uiMessagesPath = path.join(taskPath, 'ui_messages.json');

                    try {
                        await fs.access(uiMessagesPath);
                        totalFiles++;

                        // Lire le fichier et chercher des patterns new_task
                        const content = await fs.readFile(uiMessagesPath, 'utf-8');
                        const hasNewTask = await searchForNewTaskPatterns(content, taskId);
                        
                        if (hasNewTask) {
                            filesWithNewTask++;
                            console.log(`✅ ${taskId}: Instructions new_task trouvées`);
                        }

                        extractionTests.push({
                            taskId,
                            hasUiMessages: true,
                            hasNewTask,
                            fileSize: content.length
                        });

                    } catch (error) {
                        extractionTests.push({
                            taskId,
                            hasUiMessages: false,
                            hasNewTask: false,
                            error: error.message
                        });
                    }
                }
            } catch (error) {
                console.log(`⚠️ Erreur scanning ${tasksPath}: ${error.message}`);
            }
        }

        // Résultats
        console.log(`\n📊 === RÉSULTATS ===`);
        console.log(`   📄 Fichiers ui_messages.json trouvés: ${totalFiles}`);
        console.log(`   🎯 Fichiers avec instructions new_task: ${filesWithNewTask}`);
        console.log(`   📈 Taux de détection: ${totalFiles > 0 ? ((filesWithNewTask/totalFiles)*100).toFixed(1) : 0}%`);

        // Détails des tests
        console.log(`\n🔬 === DÉTAILS DES TESTS ===`);
        extractionTests.forEach(test => {
            console.log(`   ${test.taskId}:`);
            console.log(`      - UI Messages: ${test.hasUiMessages ? '✅' : '❌'}`);
            console.log(`      - New Task: ${test.hasNewTask ? '🎯' : '⭕'}`);
            if (test.fileSize) console.log(`      - Taille: ${(test.fileSize/1024).toFixed(1)} KB`);
            if (test.error) console.log(`      - Erreur: ${test.error}`);
        });

        // Si on a trouvé des exemples, montrons les détails
        if (filesWithNewTask > 0) {
            console.log(`\n🎭 === EXEMPLES D'INSTRUCTIONS TROUVÉES ===`);
            await showExampleInstructions(storageLocations, extractionTests.filter(t => t.hasNewTask).slice(0, 2));
        }

    } catch (error) {
        console.error('❌ ERREUR:', error);
    }
}

async function searchForNewTaskPatterns(content, taskId) {
    try {
        // Rechercher les patterns possibles
        const patterns = [
            /new_task/gi,
            /newTask/gi,
            /"tool":"new_task"/gi,
            /"tool":"newTask"/gi,
            /finishTask/gi  // Pattern alternatif vu dans les logs
        ];

        for (const pattern of patterns) {
            if (pattern.test(content)) {
                console.log(`   🔍 Pattern trouvé dans ${taskId}: ${pattern.source}`);
                return true;
            }
        }

        // Recherche plus avancée dans le contenu JSON
        try {
            let cleanContent = content;
            if (content.charCodeAt(0) === 0xFEFF) {
                cleanContent = content.slice(1);
            }

            const data = JSON.parse(cleanContent);
            if (Array.isArray(data)) {
                for (const message of data) {
                    if (message.type === 'ask' && message.ask === 'tool') {
                        if (typeof message.text === 'string') {
                            try {
                                const toolData = JSON.parse(message.text);
                                if (toolData.tool && (toolData.tool === 'new_task' || toolData.tool === 'newTask')) {
                                    console.log(`   🎯 Instruction new_task trouvée dans ${taskId}: ${toolData.tool}`);
                                    return true;
                                }
                            } catch (e) {
                                // Ignore les erreurs de parsing des outils individuels
                            }
                        }
                    }

                    if (message.type === 'tool_call' && message.content?.tool) {
                        if (message.content.tool === 'new_task' || message.content.tool === 'newTask') {
                            console.log(`   🎯 Tool call new_task trouvé dans ${taskId}`);
                            return true;
                        }
                    }
                }
            }
        } catch (e) {
            // Continuer avec la recherche textuelle si JSON parsing échoue
        }

        return false;
    } catch (error) {
        console.warn(`   ⚠️ Erreur recherche patterns pour ${taskId}: ${error.message}`);
        return false;
    }
}

async function showExampleInstructions(storageLocations, successfulTests) {
    for (const test of successfulTests) {
        console.log(`\n📋 Exemple: ${test.taskId}`);
        
        for (const locationPath of storageLocations) {
            const uiMessagesPath = path.join(locationPath, 'tasks', test.taskId, 'ui_messages.json');
            
            try {
                await fs.access(uiMessagesPath);
                const content = await fs.readFile(uiMessagesPath, 'utf-8');
                
                // Montrer les premiers éléments pertinents
                let cleanContent = content;
                if (content.charCodeAt(0) === 0xFEFF) {
                    cleanContent = content.slice(1);
                }

                const data = JSON.parse(cleanContent);
                if (Array.isArray(data)) {
                    const relevantMessages = data.filter(msg => {
                        if (msg.type === 'ask' && msg.ask === 'tool' && msg.text) {
                            try {
                                const toolData = JSON.parse(msg.text);
                                return toolData.tool === 'new_task' || toolData.tool === 'newTask';
                            } catch (e) { return false; }
                        }
                        return msg.type === 'tool_call' && (msg.content?.tool === 'new_task' || msg.content?.tool === 'newTask');
                    });

                    if (relevantMessages.length > 0) {
                        console.log(`   📝 ${relevantMessages.length} instruction(s) trouvée(s):`);
                        relevantMessages.slice(0, 2).forEach((msg, i) => {
                            console.log(`      ${i+1}. Type: ${msg.type}, Timestamp: ${new Date(msg.ts || 0).toISOString()}`);
                            if (msg.text) console.log(`         Text: ${msg.text.substring(0, 100)}...`);
                            if (msg.content) console.log(`         Content: ${JSON.stringify(msg.content).substring(0, 100)}...`);
                        });
                    }
                }
                break; // Trouvé le fichier, on arrête
            } catch (e) {
                // Continuer avec le prochain emplacement
            }
        }
    }
}

// Lancer le test
testNewTaskExtraction().then(() => {
    console.log('\n🏁 Test extraction terminé');
    process.exit(0);
}).catch(error => {
    console.error('💥 Erreur test:', error);
    process.exit(1);
});