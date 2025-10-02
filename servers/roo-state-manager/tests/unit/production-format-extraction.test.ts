import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Tests unitaires pour valider l'extraction des instructions newTask
 * au format production (PATTERN 5: say: 'api_req_started')
 * 
 * FORMAT RÉEL:
 * - msg.type === 'say'
 * - msg.say === 'api_req_started'
 * - msg.text === JSON stringifié avec champ "request"
 * - request contient: [new_task in 💻 Code mode: 'instruction...']
 */
describe('Production Format Extraction', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const fixturesDir = path.join(__dirname, '../fixtures/real-tasks');
    
    // Fixture avec 13 sous-tâches confirmées
    const TEST_TASK_ID = 'ac8aa7b4-319c-4925-a139-4f4adca81921';
    const EXPECTED_SUBTASKS = 13;
    
    it('should find fixture directory', () => {
        expect(fs.existsSync(fixturesDir)).toBe(true);
    });
    
    it('should have ac8aa7b4 fixture with ui_messages.json', () => {
        const taskDir = path.join(fixturesDir, TEST_TASK_ID);
        const uiMessagesPath = path.join(taskDir, 'ui_messages.json');
        
        expect(fs.existsSync(taskDir)).toBe(true);
        expect(fs.existsSync(uiMessagesPath)).toBe(true);
    });
    
    it('should parse ui_messages.json for ac8aa7b4', () => {
        const uiMessagesPath = path.join(
            fixturesDir,
            TEST_TASK_ID,
            'ui_messages.json'
        );
        
        const content = fs.readFileSync(uiMessagesPath, 'utf-8');
        const messages = JSON.parse(content);
        
        expect(Array.isArray(messages)).toBe(true);
        expect(messages.length).toBeGreaterThan(0);
    });
    
    it('should diagnose message format and regex matching', () => {
        const uiMessagesPath = path.join(
            fixturesDir,
            TEST_TASK_ID,
            'ui_messages.json'
        );
        
        const content = fs.readFileSync(uiMessagesPath, 'utf-8');
        const messages = JSON.parse(content);
        
        // Trouver le premier message api_req_started avec [new_task in
        const apiReqStartedMessages = messages.filter((msg: any) =>
            msg.type === 'say' &&
            msg.say === 'api_req_started' &&
            typeof msg.text === 'string'
        );
        
        let firstNewTaskMsg = null;
        let firstRequestText = null;
        
        for (const msg of apiReqStartedMessages) {
            try {
                const apiData = JSON.parse(msg.text);
                if (apiData && typeof apiData.request === 'string' && apiData.request.includes('[new_task in')) {
                    firstNewTaskMsg = msg;
                    firstRequestText = apiData.request;
                    break;
                }
            } catch (e) {}
        }
        
        expect(firstNewTaskMsg).toBeTruthy();
        expect(firstRequestText).toBeTruthy();
        
        // Afficher des infos de diagnostic
        console.log('\n=== DIAGNOSTIC ===');
        console.log('Request length:', firstRequestText!.length);
        console.log('First 500 chars:', firstRequestText!.substring(0, 500));
        
        // Chercher le pattern visuellement
        const startIndex = firstRequestText!.indexOf('[new_task in');
        const endIndex = firstRequestText!.indexOf(']', startIndex + 100); // Chercher ] loin
        console.log('\nPattern found at index:', startIndex);
        console.log('Potential end at:', endIndex);
        console.log('Full pattern section:', firstRequestText!.substring(startIndex, Math.min(endIndex + 50, startIndex + 300)));
        
        // Tester différents regex
        const patterns = [
            { name: 'Original (old)', regex: /\[new_task in ([^:]+):\s*['"]([^'"]+)['"]\]/g },
            { name: 'FIXED dotAll', regex: /\[new_task in ([^:]+):\s*['"](.+?)['"]\]/gs },
        ];
        
        console.log('\n=== REGEX TESTS ===');
        for (const p of patterns) {
            p.regex.lastIndex = 0;
            const match = p.regex.exec(firstRequestText!);
            console.log(`${p.name}: ${match ? 'MATCH ✓' : 'NO MATCH ✗'}`);
            if (match) {
                console.log(`  Mode: "${match[1]}"`);
                console.log(`  Message preview: "${match[2].substring(0, 100)}..."`);
            }
        }
    });
    
    it('should find api_req_started messages with new_task pattern', () => {
        const uiMessagesPath = path.join(
            fixturesDir,
            TEST_TASK_ID,
            'ui_messages.json'
        );
        
        const content = fs.readFileSync(uiMessagesPath, 'utf-8');
        const messages = JSON.parse(content);
        
        // Chercher les messages avec say: 'api_req_started'
        const apiReqStartedMessages = messages.filter((msg: any) => 
            msg.type === 'say' &&
            msg.say === 'api_req_started' && 
            typeof msg.text === 'string'
        );
        
        expect(apiReqStartedMessages.length).toBeGreaterThan(0);
        
        // Parser le JSON et chercher le pattern dans le champ "request"
        // Utilise le flag 's' (dotAll) pour supporter les sauts de ligne
        const newTaskPattern = /\[new_task in ([^:]+):\s*['"](.+?)['"]\]/s;
        const messagesWithNewTask = apiReqStartedMessages.filter((msg: any) => {
            try {
                const data = JSON.parse(msg.text);
                if (data && typeof data.request === 'string') {
                    return newTaskPattern.test(data.request);
                }
            } catch (e) {
                // Parsing failed
            }
            return false;
        });
        
        expect(messagesWithNewTask.length).toBe(EXPECTED_SUBTASKS); // ac8aa7b4 a créé 13 sous-tâches
    });
    
    it('should extract correct instruction prefixes from new_task messages', () => {
        const uiMessagesPath = path.join(
            fixturesDir,
            TEST_TASK_ID,
            'ui_messages.json'
        );
        
        const content = fs.readFileSync(uiMessagesPath, 'utf-8');
        const messages = JSON.parse(content);
        
        const apiReqStartedMessages = messages.filter((msg: any) => 
            msg.type === 'say' &&
            msg.say === 'api_req_started' && 
            typeof msg.text === 'string'
        );
        
        // Pattern corrigé avec flag 's' (dotAll) pour supporter les sauts de ligne
        const newTaskPattern = /\[new_task in ([^:]+):\s*['"](.+?)['"]\]/gs;
        const instructions: Array<{ mode: string; message: string }> = [];
        
        for (const msg of apiReqStartedMessages) {
            try {
                const apiData = JSON.parse(msg.text);
                
                if (apiData && typeof apiData.request === 'string') {
                    const requestText = apiData.request;
                    let match;
                    
                    // Reset regex pour chaque message
                    newTaskPattern.lastIndex = 0;
                    
                    while ((match = newTaskPattern.exec(requestText)) !== null) {
                        const modeWithIcon = match[1].trim();
                        const taskMessage = match[2].trim();
                        
                        // Extraire le mode sans l'icône
                        const modeMatch = modeWithIcon.match(/([A-Za-z]+)\s*mode/i);
                        const cleanMode = modeMatch ? modeMatch[1].trim().toLowerCase() : 'task';
                        
                        if (taskMessage.length > 10) {
                            instructions.push({
                                mode: cleanMode,
                                message: taskMessage
                            });
                        }
                    }
                }
            } catch (e) {
                // Parsing failed, skip this message
            }
        }
        
        expect(instructions.length).toBe(EXPECTED_SUBTASKS);
        
        // Vérifier que les instructions contiennent des mots-clés attendus
        const hasDebug = instructions.some(i => i.mode === 'debug');
        const hasCode = instructions.some(i => i.mode === 'code');
        const hasArchitect = instructions.some(i => i.mode === 'architect');
        
        // Au moins un de ces modes devrait être présent
        expect(hasDebug || hasCode || hasArchitect).toBe(true);
        
        // Vérifier que les messages ne sont pas vides
        for (const inst of instructions) {
            expect(inst.message.length).toBeGreaterThan(10);
        }
    });
    
    it('should validate extracted instructions are not empty or truncated', () => {
        const uiMessagesPath = path.join(
            fixturesDir,
            TEST_TASK_ID,
            'ui_messages.json'
        );
        
        const content = fs.readFileSync(uiMessagesPath, 'utf-8');
        const messages = JSON.parse(content);
        
        const apiReqStartedMessages = messages.filter((msg: any) => 
            msg.type === 'say' &&
            msg.say === 'api_req_started' && 
            typeof msg.text === 'string'
        );
        
        let foundNewTask = 0;
        
        for (const msg of apiReqStartedMessages) {
            try {
                const apiData = JSON.parse(msg.text);
                
                if (apiData && typeof apiData.request === 'string') {
                    const requestText = apiData.request;
                    
                    // Vérifier si ce message contient un pattern new_task
                    if (/\[new_task in/.test(requestText)) {
                        foundNewTask++;
                        
                        // Vérifier que le request est non-vide
                        expect(requestText).toBeTruthy();
                        expect(requestText.length).toBeGreaterThan(50); // Au moins 50 caractères
                        
                        // Vérifier que le pattern est correct
                        expect(requestText).toMatch(/\[new_task in ([^:]+):\s*['"]([^'"]+)['"]\]/);
                    }
                }
            } catch (e) {
                // Skip parsing errors
            }
        }
        
        expect(foundNewTask).toBe(EXPECTED_SUBTASKS);
    });
    
    it('should match the exact parsing logic from roo-storage-detector', () => {
        const uiMessagesPath = path.join(
            fixturesDir,
            TEST_TASK_ID,
            'ui_messages.json'
        );
        
        const content = fs.readFileSync(uiMessagesPath, 'utf-8');
        const messages = JSON.parse(content);
        
        // Simuler exactement la logique de PATTERN 5 dans roo-storage-detector.ts
        const instructions: Array<{ mode: string; message: string }> = [];
        
        for (const message of messages) {
            if (message.type === 'say' && message.say === 'api_req_started' && typeof message.text === 'string') {
                try {
                    // Parser le JSON dans message.text
                    const apiData = JSON.parse(message.text);
                    
                    // Extraire le champ "request" qui contient le vrai texte
                    if (apiData && typeof apiData.request === 'string') {
                        const requestText = apiData.request;
                        
                        // Pattern: [new_task in 🪲 Debug mode: 'instruction text here']
                        // Align with production extractor (RooStorageDetector) which supports multiline instructions
                        const newTaskApiPattern = /\[new_task in ([^:]+):\s*['"](.+?)['"]\]/gs;
                        let apiMatch;
                        
                        while ((apiMatch = newTaskApiPattern.exec(requestText)) !== null) {
                            const modeWithIcon = apiMatch[1].trim();
                            const taskMessage = apiMatch[2].trim();
                            
                            // Extraire le mode sans l'icône (ex: "🪲 Debug mode" -> "debug")
                            const modeMatch = modeWithIcon.match(/([A-Za-z]+)\s*mode/i);
                            const cleanMode = modeMatch ? modeMatch[1].trim().toLowerCase() : 'task';
                            
                            if (taskMessage.length > 10) {
                                instructions.push({
                                    mode: cleanMode,
                                    message: taskMessage
                                });
                            }
                        }
                    }
                } catch (e) {
                    // Parsing JSON échoué, ignorer ce message
                }
            }
        }
        
        // Vérifier que nous avons extrait les instructions
        expect(instructions.length).toBe(EXPECTED_SUBTASKS);
        
        // Vérifier la structure des instructions
        for (const inst of instructions) {
            expect(inst.mode).toBeTruthy();
            expect(inst.message).toBeTruthy();
            expect(inst.message.length).toBeGreaterThan(10);
        }
    });
});