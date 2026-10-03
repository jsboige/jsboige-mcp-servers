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
 * TEST NON RÉINTÉGRABLE - Problème ESM singleton
 *
 * Ce test est désactivé en raison d'un problème avec les singletons ESM qui cause
 * l'erreur "module is already linked" lors de l'exécution des tests.
 *
 * Problème identifié :
 * - Le module task-instruction-index.js utilise un singleton globalTaskInstructionIndex
 * - Lors de l'exécution multiple des tests, le module est déjà lié et ne peut pas être réinitialisé
 * - Les tentatives de nettoyage dans beforeEach ne suffisent pas
 *
 * Pour réintégrer ce test :
 * 1. Refactoriser task-instruction-index.js pour ne plus utiliser de singleton
 * 2. Utiliser l'injection de dépendances ou un pattern factory
 * 3. Permettre la création d'instances isolées pour chaque test
 * 4. Tester la refactorisation avec les tests unitaires existants
 *
 * Voir aussi : https://github.com/vitest-dev/vitest/issues/4043
 */
describe.skip('NewTask Extraction - Ligne Unique Géante (DISABLED: ESM singleton issue)', () => {
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

        // ASSERT
        expect(skeleton).not.toBeNull();
        expect(skeleton.childTaskInstructionPrefixes).toBeDefined();

        // 🎯 VALIDATION CRITIQUE: Les 6 newTask doivent être extraits
        const instructionCount = skeleton.childTaskInstructionPrefixes?.length || 0;
        expect(instructionCount).toBe(6);

        console.log(`✅ Test validé: ${instructionCount} instructions newTask extraites`);
    });

    it('doit extraire des préfixes normalisés non-vides', async () => {
        // ARRANGE
        const skeleton = await (RooStorageDetector as any).analyzeConversation(
            testTaskId,
            testTaskPath,
            true
        );

        // ASSERT
        expect(skeleton.childTaskInstructionPrefixes).toBeDefined();

        for (const prefix of skeleton.childTaskInstructionPrefixes!) {
            expect(prefix).toBeDefined();
            expect(prefix.length).toBeGreaterThan(10); // Préfixes significatifs
            expect(typeof prefix).toBe('string');
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
            expect(mode).toBeDefined();
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
            expect(instruction.message).toBeDefined();
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
        const prefixes = skeleton.childTaskInstructionPrefixes || [];
        const uniquePrefixes = [...new Set(prefixes)];

        // #4037 : plancher — le contrat "pas de doublons" ne doit pas passer à vide :
        // la fixture contient 6 appels newTask réels, un résultat vide ou appauvri
        // serait une régression silencieuse.
        expect(prefixes.length).toBe(6);
        expect(prefixes.length).toBe(uniquePrefixes.length);
        console.log(`✅ Test régression: Pas de doublons (${prefixes.length} préfixes uniques)`);
    });
});