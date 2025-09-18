import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

// Copie des fonctions d'inférence depuis task-indexer.ts
function extractTaskIdFromText(text) {
    if (!text) return undefined;

    // Pattern 1: UUIDs v4 explicites
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
    const uuids = text.match(uuidPattern);
    
    if (uuids && uuids.length > 0) {
        console.log(`[extractTaskIdFromText] UUID trouvé: ${uuids[0]}`);
        return uuids[0];
    }

    // Pattern 2: Références contextuelles
    const contextPatterns = [
        /CONTEXTE HÉRITÉ.*?([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i,
        /ORCHESTRATEUR.*?([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i,
        /tâche parent.*?([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i
    ];

    for (const pattern of contextPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            console.log(`[extractTaskIdFromText] Parent trouvé via pattern: ${match[1]}`);
            return match[1];
        }
    }

    return undefined;
}

async function extractParentFromApiHistory(apiHistoryPath) {
    try {
        const content = await fs.readFile(apiHistoryPath, 'utf-8');
        const data = JSON.parse(content);
        const messages = Array.isArray(data) ? data : (data?.messages || []);
        
        const firstUserMessage = messages.find(msg => msg.role === 'user');
        if (!firstUserMessage?.content) return undefined;

        const messageText = Array.isArray(firstUserMessage.content)
            ? firstUserMessage.content.find(c => c.type === 'text')?.text || ''
            : firstUserMessage.content;

        return extractTaskIdFromText(messageText);
    } catch (error) {
        console.log(`[extractParentFromApiHistory] Erreur: ${error.message}`);
        return undefined;
    }
}

async function extractParentFromUiMessages(uiMessagesPath) {
    try {
        const content = await fs.readFile(uiMessagesPath, 'utf-8');
        const data = JSON.parse(content);
        const messages = Array.isArray(data) ? data : [];
        
        const firstMessage = messages.find(msg => msg.type === 'user');
        if (!firstMessage?.content) return undefined;

        return extractTaskIdFromText(firstMessage.content);
    } catch (error) {
        console.log(`[extractParentFromUiMessages] Erreur: ${error.message}`);
        return undefined;
    }
}

async function inferParentTaskIdFromContent(apiHistoryPath, uiMessagesPath, rawMetadata) {
    try {
        console.log(`[inferParentTaskIdFromContent] Début de l'inférence...`);
        
        let parentId = await extractParentFromApiHistory(apiHistoryPath);
        if (parentId) {
            console.log(`[inferParentTaskIdFromContent] ✅ Parent trouvé via API History: ${parentId}`);
            return parentId;
        }

        parentId = await extractParentFromUiMessages(uiMessagesPath);
        if (parentId) {
            console.log(`[inferParentTaskIdFromContent] ✅ Parent trouvé via UI Messages: ${parentId}`);
            return parentId;
        }

        console.log(`[inferParentTaskIdFromContent] ❌ Aucun parent trouvé`);
        return undefined;
    } catch (error) {
        console.error(`[inferParentTaskIdFromContent] Erreur:`, error);
        return undefined;
    }
}

// Fonction pour trouver le répertoire de stockage Roo
async function findRooStorageDir() {
    const possiblePaths = [
        path.join(os.homedir(), '.vscode', 'User', 'workspaceStorage'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
        path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
        path.join(os.homedir(), '.config', 'Code', 'User', 'workspaceStorage')
    ];

    for (const basePath of possiblePaths) {
        try {
            const entries = await fs.readdir(basePath);
            for (const entry of entries) {
                const fullPath = path.join(basePath, entry);
                const stat = await fs.stat(fullPath);
                if (stat.isDirectory()) {
                    const rooPath = path.join(fullPath, '.roo');
                    try {
                        await fs.access(rooPath);
                        console.log(`💾 Trouvé stockage Roo: ${rooPath}`);
                        return rooPath;
                    } catch {
                        // Continue searching
                    }
                }
            }
        } catch (error) {
            // Path not found, continue
        }
    }
    
    console.log(`❌ Aucun stockage Roo trouvé`);
    return null;
}

// Fonction pour trouver une tâche spécifique
async function findTaskPath(taskId, rooStorageDir) {
    if (!rooStorageDir) return null;

    const conversationsDir = path.join(rooStorageDir, 'conversations');
    
    try {
        const entries = await fs.readdir(conversationsDir);
        
        for (const entry of entries) {
            if (entry === taskId) {
                const taskPath = path.join(conversationsDir, entry);
                const stat = await fs.stat(taskPath);
                if (stat.isDirectory()) {
                    console.log(`📁 Trouvé tâche ${taskId}: ${taskPath}`);
                    return taskPath;
                }
            }
        }
    } catch (error) {
        console.log(`❌ Erreur lors de la recherche de la tâche ${taskId}: ${error.message}`);
    }
    
    console.log(`❌ Tâche ${taskId} non trouvée`);
    return null;
}

// Fonction principale de test
async function testRealTasks() {
    console.log('🎯 === TEST D\'INFÉRENCE SUR TÂCHES RÉELLES ===\n');

    // Trouver le stockage Roo
    const rooStorageDir = await findRooStorageDir();
    if (!rooStorageDir) {
        console.log('❌ Impossible de continuer sans accès au stockage Roo');
        return;
    }

    // Test 1: Tâche connue - sous-tâche OpenAI
    const testTask1 = '7a1d20ca-3d90-45d1-8aca-de1573c430bb';
    const expectedParent1 = '0bd0c95e-37ca-4aab-873a-edf72672351a';
    
    console.log(`📝 Test 1: Tâche ${testTask1}`);
    console.log(`   Parent attendu: ${expectedParent1}`);
    
    const taskPath1 = await findTaskPath(testTask1, rooStorageDir);
    if (taskPath1) {
        const apiPath1 = path.join(taskPath1, 'api_conversation_history.json');
        const uiPath1 = path.join(taskPath1, 'ui_messages.json');
        
        const inferredParent1 = await inferParentTaskIdFromContent(apiPath1, uiPath1, {});
        console.log(`   Parent inféré: ${inferredParent1}`);
        console.log(`   ✅ Test 1: ${inferredParent1 === expectedParent1 ? 'SUCCÈS' : 'ÉCHEC'}\n`);
    } else {
        console.log(`   ❌ Test 1: ÉCHEC - Tâche non trouvée\n`);
    }

    // Test 2: Tâche courante
    const testTask2 = '7e533a0b-5348-4ba1-82f7-306b2babd2e5';
    const expectedParent2 = '280632e2-44bb-4f0f-a60f-f32b7cad0b01';
    
    console.log(`📝 Test 2: Tâche courante ${testTask2}`);
    console.log(`   Parent attendu: ${expectedParent2}`);
    
    const taskPath2 = await findTaskPath(testTask2, rooStorageDir);
    if (taskPath2) {
        const apiPath2 = path.join(taskPath2, 'api_conversation_history.json');
        const uiPath2 = path.join(taskPath2, 'ui_messages.json');
        
        const inferredParent2 = await inferParentTaskIdFromContent(apiPath2, uiPath2, {});
        console.log(`   Parent inféré: ${inferredParent2}`);
        console.log(`   ✅ Test 2: ${inferredParent2 === expectedParent2 ? 'SUCCÈS' : 'ÉCHEC'}\n`);
    } else {
        console.log(`   ❌ Test 2: ÉCHEC - Tâche non trouvée\n`);
    }

    console.log('🎯 === TESTS TERMINÉS ===');
}

// Exécuter les tests
testRealTasks().catch(console.error);