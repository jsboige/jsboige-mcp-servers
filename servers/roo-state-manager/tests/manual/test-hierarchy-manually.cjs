const fs = require('fs');
const path = require('path');

// Import des modules corrigés
const { HierarchyReconstructionEngine } = require('./build/src/utils/hierarchy-reconstruction-engine.js');
const { TaskInstructionIndex } = require('./build/src/utils/task-instruction-index.js');

async function testHierarchyReconstruction() {
    console.log('=== TEST DE RECONSTRUCTION HIÉRARCHIQUE ===\n');
    
    // Chemin vers nos données de test
    const testDataPath = './tests/fixtures/controlled-hierarchy';
    
    // Découverte automatique des dossiers de test
    const taskFolders = fs.readdirSync(testDataPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)
        .filter(name => name.match(/^[0-9a-f-]{36}$/)); // UUID format
    
    console.log(`📁 Chargement de ${taskFolders.length} tâches de test...\n`);
    
    // Charger les données de test
    const conversations = [];
    let loadedCount = 0;
    
    for (const folderId of taskFolders) {
        const folderPath = path.join(testDataPath, folderId);
        
        if (!fs.existsSync(folderPath)) {
            console.log(`⚠️  Dossier manquant: ${folderId}`);
            continue;
        }
        
        try {
            // Charger ui_messages.json
            const uiMessagesPath = path.join(folderPath, 'ui_messages.json');
            const metadataPath = path.join(folderPath, 'task_metadata.json');
            
            let uiMessages = [];
            let metadata = {};
            
            if (fs.existsSync(uiMessagesPath)) {
                uiMessages = JSON.parse(fs.readFileSync(uiMessagesPath, 'utf8'));
            }
            
            if (fs.existsSync(metadataPath)) {
                metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            }
            
            const conversation = {
                taskId: folderId,
                metadata: metadata,
                messages: uiMessages
            };
            
            conversations.push(conversation);
            loadedCount++;
            
            console.log(`✅ ${folderId}: ${uiMessages.length} messages, parent: ${metadata.parentTaskId || 'ROOT'}`);
            
        } catch (error) {
            console.log(`❌ Erreur lors du chargement de ${folderId}:`, error.message);
        }
    }
    
    console.log(`\n📊 Total chargé: ${loadedCount}/${taskFolders.length} tâches\n`);
    
    if (loadedCount === 0) {
        console.log('❌ Aucune donnée de test n\'a pu être chargée !');
        return;
    }
    
    // Test de la reconstruction
    console.log('🔧 Test de la reconstruction hiérarchique...\n');
    
    try {
        const engine = new HierarchyReconstructionEngine({ debugMode: true });
        
        // Convertir nos données en format StoredConversation
        const skeletons = conversations.map(conv => {
            // Extraire la VRAIE instruction qui a créé cette tâche (premier message "say")
            let firstUserMessage = '';
            for (const msg of conv.messages || []) {
                if (msg.type === 'say' && msg.text) {
                    // C'est l'instruction originale qui a créé cette tâche
                    firstUserMessage = msg.text.substring(0, 200);
                    break;
                }
            }
            
            return {
                taskId: conv.taskId,
                parentTaskId: conv.metadata.parentTaskId || null,
                workspace: conv.metadata.workspace || './test',
                createdAt: conv.metadata.createdAt || new Date().toISOString(),
                lastActivity: conv.metadata.lastActivity || new Date().toISOString(),
                messageCount: conv.messages ? conv.messages.length : 0,
                totalSize: JSON.stringify(conv.messages || []).length,
                modes: conv.metadata.modes || [],
                summary: conv.metadata.summary || 'Test task',
                filePath: `./tests/fixtures/controlled-hierarchy/${conv.taskId}`,
                truncatedInstruction: firstUserMessage,
                metadata: {
                    dataSource: `./tests/fixtures/controlled-hierarchy/${conv.taskId}`,
                    workspace: conv.metadata.workspace || './test'
                }
            };
        });
        
        console.log('🔧 Lancement de la reconstruction...');
        
        // Debug : afficher les squelettes avant reconstruction
        console.log('\n🔍 DEBUG - SQUELETTES AVANT RECONSTRUCTION:');
        for (const skeleton of skeletons) {
            const name = getTaskName(skeleton.taskId);
            console.log(`${name} (${skeleton.taskId.substring(0, 8)}): ${skeleton.truncatedInstruction?.substring(0, 50)}...`);
        }
        console.log('\n');
        
        const enhancedResult = await engine.doReconstruction(skeletons);
        
        // Debug spécifique pour comprendre les assignments
        console.log('\n🔍 DEBUG - ASSIGNMENTS DÉTAILLÉS:');
        for (const task of enhancedResult) {
            if (task.reconstructedParentId) {
                const childName = getTaskName(task.taskId);
                const parentName = getTaskName(task.reconstructedParentId);
                const confidence = task.parentConfidenceScore || 'N/A';
                const method = task.parentResolutionMethod || 'N/A';
                console.log(`${childName} → ${parentName} (score: ${confidence}, méthode: ${method})`);
            }
        }
        
        console.log('\n RÉSULTATS DE LA RECONSTRUCTION:');
        console.log(`- Tâches traitées: ${enhancedResult.length}`);
        
        const reconstructedCount = enhancedResult.filter(s => s.reconstructedParentId).length;
        console.log(`- Relations parent-enfant reconstruites: ${reconstructedCount}`);
        console.log(`- Taux de reconstruction: ${((reconstructedCount / (loadedCount - 1)) * 100).toFixed(1)}%`);
        console.log('');
        
        // Analyse des résultats
        const tasksWithParents = enhancedResult.filter(s => s.reconstructedParentId || s.parentTaskId);
        console.log('👨‍👩‍👧‍👦 RELATIONS PARENT-ENFANT DÉTECTÉES:');
        
        for (const task of tasksWithParents) {
            const parentId = task.reconstructedParentId || task.parentTaskId;
            const parentName = getTaskName(parentId);
            const childName = getTaskName(task.taskId);
            const sourceType = task.reconstructedParentId ? 'RECONSTRUIT' : 'ORIGINAL';
            console.log(`${childName} → PARENT: ${parentName} [${sourceType}]`);
        }
        
        // Calculer les niveaux de profondeur
        console.log('\n📏 NIVEAUX DE PROFONDEUR:');
        const depthMap = calculateDepths(enhancedResult);
        
        for (const [taskId, depth] of Object.entries(depthMap).sort((a, b) => a[1] - b[1])) {
            const name = getTaskName(taskId);
            const indent = '  '.repeat(depth);
            console.log(`${indent}Niveau ${depth}: ${name}`);
        }
        
        // Validation finale
        const expectedRelations = 7; // ROOT a 2 enfants, BRANCH-A a 2 enfants, BRANCH-B a 1 enfant qui a 2 enfants
        const success = reconstructedCount >= expectedRelations * 0.8; // Au moins 80% de réussite
        
        console.log(`\n${success ? '✅' : '❌'} VALIDATION: ${success ? 'SUCCÈS' : 'ÉCHEC'}`);
        
        if (!success) {
            console.log('\n🔍 ANALYSE DES PROBLÈMES:');
            
            // Vérifier les instructions newTask détectées
            for (const task of enhancedResult) {
                console.log(`\n📋 Analyse de ${getTaskName(task.taskId)}:`);
                
                if (task.parsedSubtaskInstructions) {
                    const instructions = task.parsedSubtaskInstructions.instructions || [];
                    console.log(`  - Instructions extraites: ${instructions.length}`);
                    
                    for (const instr of instructions.slice(0, 3)) { // Montrer les 3 premières
                        console.log(`    * Mode: ${instr.mode}, Message: ${instr.message.substring(0, 60)}...`);
                    }
                } else {
                    console.log(`  - Aucune instruction de sous-tâche détectée`);
                }
            }
        }
        
    } catch (error) {
        console.log('❌ Erreur lors de la reconstruction:', error);
        console.log('Stack trace:', error.stack);
    }
}

function getTaskName(taskId) {
    // Utilisation des vrais IDs des dossiers de test
    const names = {
        '91e837de-a4b2-4c18-ab9b-6fcd36596e38': 'ROOT',
        '305b3f90-e0e1-4870-8cf4-4fd33a08cfa4': 'BRANCH-A',
        'b423bff7-6fec-40fe-a00e-bb2a0ebb52f4': 'LEAF-A1',
        '03deadab-a06d-4b29-976d-3cc142add1d9': 'BRANCH-B',
        '38948ef0-4a8b-40a2-ae29-b38d2aa9d5a7': 'NODE-B1',
        '8c06d62c-1ee2-4c3a-991e-c9483e90c8aa': 'LEAF-B1a',
        'd6a6a99a-b7fd-41fc-86ce-2f17c9520437': 'LEAF-B1b',
        'e73ea764-4971-4adb-9197-52c2f8ede8ef': 'LEAF-A2'
    };
    
    return names[taskId] || `TASK-${taskId.substring(0, 8)}`;
}

function calculateDepths(tasks) {
    const depths = {};
    const parentMap = {};
    
    // Construire la map parent-enfant
    for (const task of tasks) {
        const parentId = task.reconstructedParentId || task.parentTaskId;
        parentMap[task.taskId] = parentId || null;
    }
    
    // Calculer les profondeurs avec détection de cycles
    function getDepth(taskId, visited = new Set()) {
        if (depths[taskId] !== undefined) {
            return depths[taskId];
        }
        
        // Détection de cycle
        if (visited.has(taskId)) {
            console.log(`⚠️  CYCLE DÉTECTÉ pour ${taskId}, profondeur forcée à 0`);
            depths[taskId] = 0;
            return 0;
        }
        
        visited.add(taskId);
        
        const parentId = parentMap[taskId];
        if (!parentId || parentId === taskId) {
            depths[taskId] = 0; // Racine ou auto-référence
            return 0;
        }
        
        depths[taskId] = getDepth(parentId, visited) + 1;
        visited.delete(taskId);
        return depths[taskId];
    }
    
    for (const task of tasks) {
        getDepth(task.taskId);
    }
    
    return depths;
}

// Exécuter le test
testHierarchyReconstruction().catch(console.error);