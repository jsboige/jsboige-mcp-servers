import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Extrait un UUID de tâche à partir d'un texte en utilisant différents patterns
 */
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

/**
 * Extrait le parentTaskId depuis api_conversation_history.json
 */
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

/**
 * Extrait le parentTaskId depuis ui_messages.json
 */
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

/**
 * Fonction principale d'inférence du parentTaskId
 */
async function inferParentTaskIdFromContent(apiHistoryPath, uiMessagesPath, rawMetadata) {
    try {
        console.log(`[inferParentTaskIdFromContent] Début de l'inférence...`);
        
        // 1. Analyser le premier message utilisateur dans api_conversation_history.json
        console.log(`[inferParentTaskIdFromContent] Analyse API History: ${apiHistoryPath}`);
        let parentId = await extractParentFromApiHistory(apiHistoryPath);
        if (parentId) {
            console.log(`[inferParentTaskIdFromContent] ✅ Parent trouvé via API History: ${parentId}`);
            return parentId;
        }

        // 2. Analyser ui_messages.json pour des références
        console.log(`[inferParentTaskIdFromContent] Analyse UI Messages: ${uiMessagesPath}`);
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

async function runTests() {
    console.log('🧪 === TESTS DE VALIDATION DU SYSTÈME D\'INFÉRENCE HIÉRARCHIQUE ===\n');

    // Test 1: Pattern UUID simple
    console.log('📝 Test 1: Extraction UUID simple');
    const uuid1 = extractTaskIdFromText("Voici un UUID: 7a1d20ca-3d90-45d1-8aca-de1573c430bb pour test");
    console.log(`Résultat: ${uuid1}`);
    console.log(`✅ Test 1: ${uuid1 === '7a1d20ca-3d90-45d1-8aca-de1573c430bb' ? 'SUCCÈS' : 'ÉCHEC'}\n`);

    // Test 2: Pattern CONTEXTE HÉRITÉ
    console.log('📝 Test 2: Pattern CONTEXTE HÉRITÉ');
    const uuid2 = extractTaskIdFromText("**CONTEXTE HÉRITÉ** de la tâche parente 280632e2-44bb-4f0f-a60f-f32b7cad0b01");
    console.log(`Résultat: ${uuid2}`);
    console.log(`✅ Test 2: ${uuid2 === '280632e2-44bb-4f0f-a60f-f32b7cad0b01' ? 'SUCCÈS' : 'ÉCHEC'}\n`);

    // Test 3: Pattern ORCHESTRATEUR
    console.log('📝 Test 3: Pattern ORCHESTRATEUR');
    const uuid3 = extractTaskIdFromText("ORCHESTRATEUR: 0bd0c95e-37ca-4aab-873a-edf72672351a a délégué cette tâche");
    console.log(`Résultat: ${uuid3}`);
    console.log(`✅ Test 3: ${uuid3 === '0bd0c95e-37ca-4aab-873a-edf72672351a' ? 'SUCCÈS' : 'ÉCHEC'}\n`);

    // Test 4: Pas d'UUID
    console.log('📝 Test 4: Texte sans UUID');
    const uuid4 = extractTaskIdFromText("Aucun UUID dans ce texte");
    console.log(`Résultat: ${uuid4}`);
    console.log(`✅ Test 4: ${uuid4 === undefined ? 'SUCCÈS' : 'ÉCHEC'}\n`);

    // Test 5: Intégration avec fichiers réels
    console.log('📝 Test 5: Intégration avec tâche réelle');
    
    // Créer des fichiers de test temporaires
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hierarchy-test-'));
    const testApiPath = path.join(tempDir, 'api_conversation_history.json');
    const testUiPath = path.join(tempDir, 'ui_messages.json');

    try {
        // Créer un fichier API history avec UUID
        const apiTestData = {
            messages: [
                {
                    role: 'user',
                    content: '**CONTEXTE HÉRITÉ** de la tâche parente 280632e2-44bb-4f0f-a60f-f32b7cad0b01'
                }
            ]
        };

        await fs.writeFile(testApiPath, JSON.stringify(apiTestData, null, 2), 'utf-8');
        await fs.writeFile(testUiPath, JSON.stringify([], null, 2), 'utf-8');

        const inferredParent = await inferParentTaskIdFromContent(testApiPath, testUiPath, {});
        console.log(`Résultat inférence: ${inferredParent}`);
        console.log(`✅ Test 5: ${inferredParent === '280632e2-44bb-4f0f-a60f-f32b7cad0b01' ? 'SUCCÈS' : 'ÉCHEC'}\n`);

    } finally {
        // Nettoyer
        await fs.rmdir(tempDir, { recursive: true });
    }

    console.log('🎯 === TESTS TERMINÉS ===');
}

// Exécuter les tests
runTests().catch(console.error);