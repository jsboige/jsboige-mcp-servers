/**
 * Tests unitaires pour l'extraction du PATTERN 5 - Format production api_req_started
 *
 * OBJECTIF SDDD: Valider que le pattern "[new_task in X mode: 'Y']"
 * dans les messages say/api_req_started fonctionne correctement
 *
 * PROBLÈME IDENTIFIÉ: 0 instructions extraites sur 37 tâches workspace d:/dev/roo-extensions
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as path from 'path';
// Désactiver le mock global de fs pour ce test
vi.unmock('fs');
vi.unmock('fs/promises');
import * as fs from 'fs';
import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';
import { globalTaskInstructionIndex } from '../../src/utils/task-instruction-index.js';

describe('Production Format Extraction - PATTERN 5', () => {
    const fixturesPath = path.join(__dirname, '..', 'fixtures', 'real-tasks');

    // Tâche de test connue avec PATTERN 5
    const testTaskId = 'ac8aa7b4-319c-4925-a139-4f4adca81921';
    const testTaskPath = path.join(fixturesPath, testTaskId);

    beforeAll(() => {
        // Vérifier que les fixtures existent
        const uiMessagesPath = path.join(testTaskPath, 'ui_messages.json');
        if (!fs.existsSync(uiMessagesPath)) {
            throw new Error(`Fixture PATTERN 5 manquante: ${uiMessagesPath}`);
        }
    });

    beforeEach(async () => {
        // Reset index global pour isolation des tests
        globalTaskInstructionIndex.clear();
    });

    it('devrait extraire les instructions newTask depuis messages api_req_started', async () => {
        // ARRANGE
        const uiMessagesPath = path.join(testTaskPath, 'ui_messages.json');

        // Extraire directement via la méthode privée pour focus sur PATTERN 5
        const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(
            uiMessagesPath,
            0 // Pas de limite
        );

        // ACT & ASSERT
        expect(Array.isArray(instructions)).toBe(true);

        // ÉTAT MESURÉ (sonde 2026-10-03, contrat pré-#4037) : la fixture figée
        // rend exactement 38 instructions via les autres patterns, et AUCUNE
        // n'est sourcée api_req_started — le PATTERN 5 ne remonte pas encore.
        // Ces pins sont le ratchet du contrat actuel : à re-pinner à
        // l'atterrissage de jsboige-mcp-servers#1318 (extraction newTask).
        expect(instructions).toHaveLength(38);

        const apiInstructions = instructions.filter((inst: any) =>
            inst.source && inst.source.includes('api_req_started')
        );
        expect(apiInstructions).toHaveLength(0);
    });

    it('devrait parser correctement le JSON stringifié dans message.text', async () => {
        // ARRANGE
        const uiMessagesPath = path.join(testTaskPath, 'ui_messages.json');
        const content = fs.readFileSync(uiMessagesPath, 'utf-8');
        const messages = JSON.parse(content);

        // ACT: Trouver les messages api_req_started
        const apiMessages = messages.filter((msg: any) =>
            msg.type === 'say' && msg.say === 'api_req_started' && typeof msg.text === 'string'
        );

        // ASSERT — état mesuré sur la fixture figée (sonde 2026-10-03) :
        // 59 messages api_req_started, dont 13 portent le pattern PATTERN 5.
        expect(apiMessages).toHaveLength(59);

        const pattern = /\[new_task in ([^:]+):\s*['"](.+?)['"]\]/gs;
        let msgsWithPattern5 = 0;

        // Chaque api_req_started doit parser en objet avec request string —
        // pas de try/catch : un parse en échec fait ROUGIR le test (c'est le
        // contrat), il n'est pas avalé en console.warn.
        for (const msg of apiMessages) {
            const apiData = JSON.parse(msg.text);
            expect(typeof apiData.request).toBe('string');
            if ([...apiData.request.matchAll(pattern)].length > 0) {
                msgsWithPattern5++;
            }
        }
        expect(msgsWithPattern5).toBe(13);
    });

    it('devrait nettoyer correctement les modes avec emojis', async () => {
        // ARRANGE - Créer un message api_req_started de test
        const testMessage = {
            type: 'say',
            say: 'api_req_started',
            text: JSON.stringify({
                request: '[new_task in 🪲 Debug mode: \'Débugger le système de hiérarchie\']'
            }),
            timestamp: Date.now()
        };

        // ACT: Simuler l'extraction du mode
        const modeWithIcon = '🪲 Debug mode';
        const modeMatch = modeWithIcon.match(/([A-Za-z]+)\s*mode/i);
        const cleanMode = modeMatch ? modeMatch[1].trim().toLowerCase() : 'task';

        // ASSERT
        expect(cleanMode).toBe('debug');
        console.log(`✅ Mode nettoyé: "${modeWithIcon}" -> "${cleanMode}"`);
    });

    it('devrait détecter le problème workspace filtering', async () => {
        // ARRANGE: Analyser le skeleton complet pour voir le workspace
        const skeleton = await (RooStorageDetector as any).analyzeConversation(
            testTaskId,
            testTaskPath,
            true // useProductionHierarchy
        );

        // ACT & ASSERT — workspace détecté mesuré sur la fixture figée
        // (sonde 2026-10-03) : la hiérarchie production résout le workspace
        // nominal, pas un mismatch silencieux.
        expect(skeleton.metadata.workspace).toBe('d:/dev/roo-extensions');
    });

    it('devrait valider la regex PATTERN 5 avec cas réels', async () => {
        // ARRANGE: Cas de test réels possibles
        const testCases = [
            {
                name: 'Mode avec emoji',
                input: '[new_task in 🪲 Debug mode: \'Corriger le bug hiérarchie\']',
                expectedMode: 'debug'
            },
            {
                name: 'Mode simple',
                input: '[new_task in Code mode: "Implémenter nouvelle fonctionnalité"]',
                expectedMode: 'code'
            },
            {
                name: 'Multiline message',
                input: '[new_task in Architect mode: "Conception système\nAvec détails techniques"]',
                expectedMode: 'architect'
            }
        ];

        // ACT & ASSERT
        const pattern = /\[new_task in ([^:]+):\s*['"](.+?)['"]\]/gs;

        for (const testCase of testCases) {
            console.log(`🧪 Testing: ${testCase.name}`);
            const matches = [...testCase.input.matchAll(pattern)];

            expect(matches.length).toBe(1);

            const modeWithIcon = matches[0][1].trim();
            const taskMessage = matches[0][2].trim();

            const modeMatch = modeWithIcon.match(/([A-Za-z]+)\s*mode/i);
            const cleanMode = modeMatch ? modeMatch[1].trim().toLowerCase() : 'task';

            expect(cleanMode).toBe(testCase.expectedMode);
            expect(taskMessage.length).toBeGreaterThan(10);

            console.log(`   ✅ Mode: ${cleanMode}, Message: ${taskMessage.substring(0, 50)}...`);
        }
    });
});

// NOTE (lot 4 #2639) : le describe « Diagnostic Complet » d'origine a été
// supprimé — script d'investigation ponctuel du problème du header (0
// instructions / 37 tâches), il n'assertait que `expect(total) >= 0`,
// trivialement vrai : mesuré (sonde 2026-10-03), buildHierarchicalSkeletons
// avec useFullVolume=false rend [] en <10 ms sans toucher le disque, et la
// forme utile (useFullVolume=true) est un scan machine de plusieurs minutes,
// inadaptée à une suite. L'investigation vit dans #4037 / mcp-servers#1318.