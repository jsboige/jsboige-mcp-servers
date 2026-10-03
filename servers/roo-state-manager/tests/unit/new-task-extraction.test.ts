/**
 * Tests unitaires pour l'extraction des instructions newTask
 * Valide la correction du bug de parsing incomplet (6 newTask dans une seule ligne)
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as path from 'path';

// Désactiver le mock global de fs pour ce test
vi.unmock('fs/promises');
import * as fs from 'fs/promises';

import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';

/**
 * RÉINTÉGRÉ 2026-10-03 (#2639 lot ESM, probe post-#1318, tête b5b478d4) :
 * le motif ESM « module is already linked » ne se reproduit plus — le bloc s'exécute.
 * Avant la dédup #4037 (fix #1318, fcae582d), 4/6 échouaient sur des assertions de
 * compte (`expected 10 to be 6`) : sur-capture (bloc racine `<task>` + échos
 * doublonnés), PAS un problème ESM. Avec fcae582d, les 6 passent sans refactor du
 * singleton (globalTaskInstructionIndex reste nettoyé dans le beforeEach).
 *
 * Historique du skip ESM d'origine (2026-04, jamais reproduit en probe — voir
 * PR #1323 pour la traçabilité complète) :
 * - task-instruction-index.js utilise un singleton globalTaskInstructionIndex
 * - signalé « déjà lié en cours de run » → non réinitialisable, beforeEach insuffisant
 * - Voir aussi : https://github.com/vitest-dev/vitest/issues/4043
 */
describe('NewTask Extraction - Ligne Unique Géante', () => {
    const fixturesPath = path.join(__dirname, '..', 'fixtures', 'real-tasks');
    const testTaskId = 'bc93a6f7-cd2e-4686-a832-46e3cd14d338';
    const testTaskPath = path.join(fixturesPath, testTaskId);

    beforeAll(async () => {
        // Désactiver les mocks fs pour ce test afin de pouvoir lire de vrais fichiers
        vi.unmock('fs/promises');
        vi.unmock('fs');
        
        // Vérifier que le fichier de test existe
        const uiMessagesPath = path.join(testTaskPath, 'ui_messages.json');
        try {
            await fs.access(uiMessagesPath);
        } catch (error) {
            throw new Error(`Fichier de test manquant: ${uiMessagesPath}`);
        }
    });

    beforeEach(async () => {
        // Nettoyer l'index global entre les tests pour éviter "module is already linked"
        const { globalTaskInstructionIndex } = await import('../../src/utils/task-instruction-index.js');
        globalTaskInstructionIndex.clear();
    });

    it('doit extraire TOUTES les 6 occurrences de newTask depuis une ligne géante', async () => {
        // ARRANGE
        const uiMessagesPath = path.join(testTaskPath, 'ui_messages.json');

        // ACT - Utiliser la méthode privée via analyzeConversation qui l'appelle
        const skeleton = await (RooStorageDetector as any).analyzeConversation(
            testTaskId,
            testTaskPath,
            true // useProductionHierarchy
        );

        // ASSERT — 🎯 VALIDATION CRITIQUE: Les 6 newTask doivent être extraits
        expect(skeleton?.childTaskInstructionPrefixes).toHaveLength(6);

        console.log(`✅ Test validé: ${skeleton!.childTaskInstructionPrefixes!.length} instructions newTask extraites`);
    });

    it('doit extraire des préfixes normalisés non-vides', async () => {
        // ARRANGE
        const skeleton = await (RooStorageDetector as any).analyzeConversation(
            testTaskId,
            testTaskPath,
            true
        );

        // ASSERT
        expect(skeleton!.childTaskInstructionPrefixes).toHaveLength(6);

        for (const prefix of skeleton.childTaskInstructionPrefixes!) {
            expect(typeof prefix).toBe('string');
            expect(prefix.length).toBeGreaterThan(10); // Préfixes significatifs
        }

        console.log(`✅ Test validé: Tous les préfixes sont valides et normalisés`);
    });

    it('doit gérer correctement les modes avec emojis', async () => {
        // ARRANGE
        const uiMessagesPath = path.join(testTaskPath, 'ui_messages.json');

        // Extraire directement via la méthode privée
        const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(
            uiMessagesPath,
            0 // Pas de limite
        );

        // ASSERT
        expect(instructions.length).toBe(6);

        // Vérifier que les modes sont nettoyés (sans emojis)
        const modes = instructions.map((inst: any) => inst.mode);

        for (const mode of modes) {
            expect(typeof mode).toBe('string');
            // Les modes ne doivent pas contenir d'emojis après nettoyage
            expect(mode).not.toMatch(/[🎯🪲💻🏗️🪃❓👨💼]/);
        }

        console.log(`✅ Test validé: Modes extraits et nettoyés: ${modes.join(', ')}`);
    });

    it('doit extraire des messages de longueur raisonnable', async () => {
        // ARRANGE
        const uiMessagesPath = path.join(testTaskPath, 'ui_messages.json');
        const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(
            uiMessagesPath,
            0
        );

        // ASSERT
        for (const instruction of instructions) {
            expect(typeof instruction.message).toBe('string');
            expect(instruction.message.length).toBeGreaterThan(20);
            expect(instruction.message.length).toBeLessThan(10000); // Sanity check
        }

        console.log(`✅ Test validé: Tous les messages ont une longueur raisonnable`);
    });

    it('doit préserver l\'ordre chronologique des instructions', async () => {
        // ARRANGE
        const uiMessagesPath = path.join(testTaskPath, 'ui_messages.json');
        const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(
            uiMessagesPath,
            0
        );

        // ASSERT
        expect(instructions.length).toBe(6);

        // Vérifier que les timestamps sont en ordre croissant
        for (let i = 1; i < instructions.length; i++) {
            expect(instructions[i].timestamp).toBeGreaterThanOrEqual(instructions[i - 1].timestamp);
        }

        console.log(`✅ Test validé: Ordre chronologique préservé`);
    });
});

describe('NewTask Extraction - Régression', () => {
    it('ne doit pas créer de doublons lors du parsing', async () => {
        // ARRANGE
        const testTaskId = 'bc93a6f7-cd2e-4686-a832-46e3cd14d338';
        const testTaskPath = path.join(
            __dirname, '..', 'fixtures', 'real-tasks', testTaskId
        );

        const skeleton = await (RooStorageDetector as any).analyzeConversation(
            testTaskId,
            testTaskPath,
            true
        );

        // ASSERT
        // Plancher d'abord : sans lui, un childTaskInstructionPrefixes undefined
        // rendait 0 === 0 et le test passait à vide.
        // Mesuré sur ce fixture (03/10/2026) : 7 préfixes distincts = les 6 newTask
        // réels + 1 bloc racine <task> (mode='task') capturé par le pattern XML de
        // l'extraction. L'extraction brute rend même 10 instructions (3 échos
        // doublonnés avec mode mal parsé — « debug mode »), dédupliqués par le Set
        // du skeleton. Le comportement d'extraction est épinglé par les suites
        // dédiées (message-extraction-coordinator, extraction-contamination) :
        // y toucher est un grain distinct, pas une correction de test.
        const prefixes = skeleton.childTaskInstructionPrefixes || [];
        expect(prefixes.length).toBeGreaterThanOrEqual(6);
        const uniquePrefixes = [...new Set(prefixes)];

        // #4037 : plancher — le contrat "pas de doublons" ne doit pas passer à vide :
        // la fixture contient 6 appels newTask réels, un résultat vide ou appauvri
        // serait une régression silencieuse.
        expect(prefixes.length).toBe(6);
        expect(prefixes.length).toBe(uniquePrefixes.length);
        console.log(`✅ Test régression: Pas de doublons (${prefixes.length} préfixes uniques)`);
    });
});