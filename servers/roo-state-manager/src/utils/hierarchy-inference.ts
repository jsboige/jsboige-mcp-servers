import * as fs from 'fs/promises';

/**
 * Extrait un UUID version 4 depuis un texte
 */
export function extractTaskIdFromText(text: string): string | undefined {
    if (!text) return undefined;

    // Pattern 1: UUID version 4 basique
    const uuidRegex = /([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi;
    const uuids = text.match(uuidRegex);
    
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
export async function extractParentFromApiHistory(apiHistoryPath: string): Promise<string | undefined> {
    try {
        process.stdout.write(`[extractParentFromApiHistory] Lecture du fichier: ${apiHistoryPath}\n`);
        const content = await fs.readFile(apiHistoryPath, 'utf-8');
        const data = JSON.parse(content);
        const messages = Array.isArray(data) ? data : (data?.messages || []);
        process.stdout.write(`[extractParentFromApiHistory] Messages trouvés: ${messages.length}\n`);
        
        const firstUserMessage = messages.find((msg: any) => msg.role === 'user');
        process.stdout.write(`[extractParentFromApiHistory] Premier message user: ${firstUserMessage ? 'trouvé' : 'non trouvé'}\n`);
        if (!firstUserMessage?.content) {
            process.stdout.write(`[extractParentFromApiHistory] Pas de content dans le premier message user\n`);
            return undefined;
        }

        const messageText = Array.isArray(firstUserMessage.content)
            ? firstUserMessage.content.find((c: any) => c.type === 'text')?.text || ''
            : firstUserMessage.content;
        
        process.stdout.write(`[extractParentFromApiHistory] Texte à analyser: ${messageText.substring(0, 100)}...\n`);

        const result = extractTaskIdFromText(messageText);
        process.stdout.write(`[extractParentFromApiHistory] Résultat: ${result}\n`);
        return result;
    } catch (error) {
        process.stdout.write(`[extractParentFromApiHistory] Erreur: ${error}\n`);
        return undefined;
    }
}

/**
 * Extrait le parentTaskId depuis ui_messages.json
 */
export async function extractParentFromUiMessages(uiMessagesPath: string): Promise<string | undefined> {
    try {
        process.stdout.write(`[extractParentFromUiMessages] Lecture du fichier: ${uiMessagesPath}\n`);
        const content = await fs.readFile(uiMessagesPath, 'utf-8');
        const data = JSON.parse(content);
        const messages = Array.isArray(data) ? data : (data?.messages || []);
        process.stdout.write(`[extractParentFromUiMessages] Messages trouvés: ${messages.length}\n`);
        
        // Chercher le premier message utilisateur (type 'user' dans ui_messages)
        const firstUserMessage = messages.find((msg: any) => msg.type === 'user' || msg.role === 'user');
        process.stdout.write(`[extractParentFromUiMessages] Premier message user: ${firstUserMessage ? 'trouvé' : 'non trouvé'}\n`);
        if (!firstUserMessage?.content) {
            process.stdout.write(`[extractParentFromUiMessages] Pas de content dans le premier message user\n`);
            return undefined;
        }

        process.stdout.write(`[extractParentFromUiMessages] Texte à analyser: ${firstUserMessage.content.substring(0, 100)}...\n`);
        const result = extractTaskIdFromText(firstUserMessage.content);
        process.stdout.write(`[extractParentFromUiMessages] Résultat: ${result}\n`);
        return result;
    } catch (error) {
        process.stdout.write(`[extractParentFromUiMessages] Erreur: ${error}\n`);
        return undefined;
    }
}

/**
 * Infère le parentTaskId depuis le contenu des fichiers
 */
export async function inferParentTaskIdFromContent(
    apiHistoryPath: string,
    uiMessagesPath: string,
    rawMetadata: any
): Promise<string | undefined> {
    try {
        // 1. Analyser le premier message utilisateur dans api_conversation_history.json
        let parentId = await extractParentFromApiHistory(apiHistoryPath);
        if (parentId) return parentId;

        // 2. Analyser ui_messages.json pour des références
        parentId = await extractParentFromUiMessages(uiMessagesPath);
        if (parentId) return parentId;

        return undefined;
    } catch (error) {
        console.error(`[inferParentTaskIdFromContent] Erreur:`, error);
        return undefined;
    }
}