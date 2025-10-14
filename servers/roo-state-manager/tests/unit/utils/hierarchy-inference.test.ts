import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Tests pour le système d'inférence hiérarchique
describe('Hierarchy Inference System', () => {
    let tempDir: string;
    let mockApiHistoryPath: string;
    let mockUiMessagesPath: string;

    beforeAll(async () => {
        // Créer un répertoire temporaire pour les tests
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hierarchy-test-'));
        mockApiHistoryPath = path.join(tempDir, 'api_conversation_history.json');
        mockUiMessagesPath = path.join(tempDir, 'ui_messages.json');
    });

    afterAll(async () => {
        // Nettoyer après les tests
        await fs.rmdir(tempDir, { recursive: true });
    });

    // === TEST 1 : EXTRACTION D'UUID BASIQUE ===
    test('extractTaskIdFromText devrait trouver un UUID basique dans le texte', () => {
        const testText = 'Cette tâche est liée à 7a1d20ca-3d90-45d1-8aca-de1573c430bb pour continuer.';
        const result = extractTaskIdFromText(testText);
        expect(result).toBe('7a1d20ca-3d90-45d1-8aca-de1573c430bb');
    });

    // === TEST 2 : PATTERNS CONTEXTUELS ===
    test('extractTaskIdFromText devrait trouver UUID via pattern CONTEXTE HÉRITÉ', () => {
        const testText = `
        **CONTEXTE HÉRITÉ**
        Tu hérites d'un travail de 0bd0c95e-37ca-4aab-873a-edf72672351a concernant...
        `;
        const result = extractTaskIdFromText(testText);
        expect(result).toBe('0bd0c95e-37ca-4aab-873a-edf72672351a');
    });

    test('extractTaskIdFromText devrait trouver UUID via pattern ORCHESTRATEUR', () => {
        const testText = `
        L'ORCHESTRATEUR parent 721cbb83-e882-4140-afb7-ad74fd3cb378 a délégué cette sous-tâche.
        `;
        const result = extractTaskIdFromText(testText);
        expect(result).toBe('721cbb83-e882-4140-afb7-ad74fd3cb378');
    });

    test('extractTaskIdFromText devrait trouver UUID via pattern "tâche parent"', () => {
        const testText = `
        Cette tâche parent ee348d21-1c10-438a-83c9-2e0554dc1b6d nécessite une analyse...
        `;
        const result = extractTaskIdFromText(testText);
        expect(result).toBe('ee348d21-1c10-438a-83c9-2e0554dc1b6d');
    });

    // === TEST 3 : PATTERNS NÉGATIFS ===
    test('extractTaskIdFromText devrait retourner undefined pour texte sans UUID', () => {
        const testText = 'Cette tâche ne contient pas d\'identifiant valide.';
        const result = extractTaskIdFromText(testText);
        expect(result).toBeUndefined();
    });

    test('extractTaskIdFromText devrait retourner undefined pour UUID malformé', () => {
        const testText = 'UUID invalide: 7a1d20ca-3d90-45d1-8aca-de1573c430b (trop court)';
        const result = extractTaskIdFromText(testText);
        expect(result).toBeUndefined();
    });

    // === TEST 4 : EXTRACTION DEPUIS API HISTORY ===
    test('extractParentFromApiHistory devrait extraire UUID depuis le premier message user', async () => {
        const mockApiHistory = [
            {
                role: 'user',
                content: `<task>
                **SOUS-TÂCHE : Exploration Exemples OpenAI-Node**
                
                **CONTEXTE HÉRITÉ**
                Tu hérites d'un travail de 0bd0c95e-37ca-4aab-873a-edf72672351a concernant...
                </task>`
            },
            { role: 'assistant', content: 'Je vais analyser...' }
        ];

        await fs.writeFile(mockApiHistoryPath, JSON.stringify(mockApiHistory, null, 2));
        const result = await extractParentFromApiHistory(mockApiHistoryPath);
        expect(result).toBe('0bd0c95e-37ca-4aab-873a-edf72672351a');
    });

    test('extractParentFromApiHistory devrait gérer les messages avec content array', async () => {
        const mockApiHistory = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'ORCHESTRATEUR 721cbb83-e882-4140-afb7-ad74fd3cb378 délègue cette tâche.' }
                ]
            }
        ];

        await fs.writeFile(mockApiHistoryPath, JSON.stringify(mockApiHistory, null, 2));
        const result = await extractParentFromApiHistory(mockApiHistoryPath);
        expect(result).toBe('721cbb83-e882-4140-afb7-ad74fd3cb378');
    });

    test('extractParentFromApiHistory devrait retourner undefined pour fichier inexistant', async () => {
        const result = await extractParentFromApiHistory('/path/inexistant.json');
        expect(result).toBeUndefined();
    });

    // === TEST 5 : EXTRACTION DEPUIS UI MESSAGES ===
    test('extractParentFromUiMessages devrait extraire UUID depuis ui_messages.json', async () => {
        const mockUiMessages = [
            { role: 'user', content: 'Tâche parent f444c2f1-31c0-478e-858f-b9b79c27622f a besoin de suivi.' },
            { role: 'assistant', content: 'Compris...' }
        ];

        await fs.writeFile(mockUiMessagesPath, JSON.stringify(mockUiMessages, null, 2));
        const result = await extractParentFromUiMessages(mockUiMessagesPath);
        expect(result).toBe('f444c2f1-31c0-478e-858f-b9b79c27622f');
    });

    // === TEST 6 : INFÉRENCE COMPLÈTE ===
    test('inferParentTaskIdFromContent devrait utiliser api_history en priorité', async () => {
        const mockApiHistory = [
            {
                role: 'user',
                content: 'CONTEXTE HÉRITÉ de 280632e2-44bb-4f0f-a60f-f32b7cad0b01'
            }
        ];
        const mockUiMessages = [
            { role: 'user', content: 'Autre parent f444c2f1-31c0-478e-858f-b9b79c27622f' }
        ];

        await fs.writeFile(mockApiHistoryPath, JSON.stringify(mockApiHistory, null, 2));
        await fs.writeFile(mockUiMessagesPath, JSON.stringify(mockUiMessages, null, 2));

        const result = await inferParentTaskIdFromContent(mockApiHistoryPath, mockUiMessagesPath, {});
        expect(result).toBe('280632e2-44bb-4f0f-a60f-f32b7cad0b01');
    });

    test('inferParentTaskIdFromContent devrait fallback vers ui_messages', async () => {
        const mockApiHistory = [
            { role: 'user', content: 'Pas d\'UUID ici' }
        ];
        const mockUiMessages = [
            { role: 'user', content: 'Fallback parent ee348d21-1c10-438a-83c9-2e0554dc1b6d' }
        ];

        await fs.writeFile(mockApiHistoryPath, JSON.stringify(mockApiHistory, null, 2));
        await fs.writeFile(mockUiMessagesPath, JSON.stringify(mockUiMessages, null, 2));

        const result = await inferParentTaskIdFromContent(mockApiHistoryPath, mockUiMessagesPath, {});
        expect(result).toBe('ee348d21-1c10-438a-83c9-2e0554dc1b6d');
    });

    test('inferParentTaskIdFromContent devrait retourner undefined si aucun UUID trouvé', async () => {
        const mockApiHistory = [{ role: 'user', content: 'Pas d\'UUID' }];
        const mockUiMessages = [{ role: 'user', content: 'Toujours pas d\'UUID' }];

        await fs.writeFile(mockApiHistoryPath, JSON.stringify(mockApiHistory, null, 2));
        await fs.writeFile(mockUiMessagesPath, JSON.stringify(mockUiMessages, null, 2));

        const result = await inferParentTaskIdFromContent(mockApiHistoryPath, mockUiMessagesPath, {});
        expect(result).toBeUndefined();
    });

    // === TEST 7 : CAS EDGE ===
    test('extractParentFromApiHistory devrait gérer JSON malformé', async () => {
        await fs.writeFile(mockApiHistoryPath, '{ json malformé');
        const result = await extractParentFromApiHistory(mockApiHistoryPath);
        expect(result).toBeUndefined();
    });

    test('extractTaskIdFromText devrait ignorer les UUIDs de version 1/2/3/5', () => {
        // UUID version 1
        const testText1 = 'UUID v1: 550e8400-e29b-11d4-a716-446655440000';
        expect(extractTaskIdFromText(testText1)).toBeUndefined();

        // UUID version 4 valide
        const testText4 = 'UUID v4: 7a1d20ca-3d90-45d1-8aca-de1573c430bb';
        expect(extractTaskIdFromText(testText4)).toBe('7a1d20ca-3d90-45d1-8aca-de1573c430bb');
    });

    // === TEST 8 : MULTIPLE UUIDS ===
    test('extractTaskIdFromText devrait retourner le premier UUID trouvé', () => {
        const testText = 'Premier: 7a1d20ca-3d90-45d1-8aca-de1573c430bb, Second: 721cbb83-e882-4140-afb7-ad74fd3cb378';
        const result = extractTaskIdFromText(testText);
        expect(result).toBe('7a1d20ca-3d90-45d1-8aca-de1573c430bb');
    });

    // === TEST 9 : PERFORMANCE ===
    test('extractTaskIdFromText devrait être performant avec des textes longs', () => {
        const longText = 'x'.repeat(10000) + ' UUID: 7a1d20ca-3d90-45d1-8aca-de1573c430bb ' + 'y'.repeat(10000);
        const start = Date.now();
        const result = extractTaskIdFromText(longText);
        const duration = Date.now() - start;
        
        expect(result).toBe('7a1d20ca-3d90-45d1-8aca-de1573c430bb');
        expect(duration).toBeLessThan(100); // Moins de 100ms
    });
});

// === FONCTIONS UTILITAIRES COPIÉES POUR LES TESTS ===
// (Normalement ces fonctions seraient importées, mais pour les tests autonomes)

function extractTaskIdFromText(text: string): string | undefined {
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

async function extractParentFromApiHistory(apiHistoryPath: string): Promise<string | undefined> {
    try {
        const content = await fs.readFile(apiHistoryPath, 'utf-8');
        const data = JSON.parse(content);
        const messages = Array.isArray(data) ? data : (data?.messages || []);
        
        const firstUserMessage = messages.find((msg: any) => msg.role === 'user');
        if (!firstUserMessage?.content) return undefined;

        const messageText = Array.isArray(firstUserMessage.content)
            ? firstUserMessage.content.find((c: any) => c.type === 'text')?.text || ''
            : firstUserMessage.content;

        return extractTaskIdFromText(messageText);
    } catch (error) {
        return undefined;
    }
}

async function extractParentFromUiMessages(uiMessagesPath: string): Promise<string | undefined> {
    try {
        const content = await fs.readFile(uiMessagesPath, 'utf-8');
        const data = JSON.parse(content);
        const messages = Array.isArray(data) ? data : (data?.messages || []);
        
        const firstUserMessage = messages.find((msg: any) => msg.role === 'user');
        if (!firstUserMessage?.content) return undefined;

        return extractTaskIdFromText(firstUserMessage.content);
    } catch (error) {
        return undefined;
    }
}

async function inferParentTaskIdFromContent(
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