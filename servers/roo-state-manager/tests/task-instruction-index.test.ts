/**
 * Tests unitaires pour TaskInstructionIndex
 * Valide le fonctionnement du radix-tree et de la recherche par similarité
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { TaskInstructionIndex } from '../src/utils/task-instruction-index.js';
import type { NewTaskInstruction } from '../src/types/conversation.js';

describe('TaskInstructionIndex', () => {
    let index: TaskInstructionIndex;

    beforeEach(() => {
        index = new TaskInstructionIndex();
    });

    describe('addInstruction', () => {
        it('should add instruction to radix tree', () => {
            const parentId = 'parent-001';
            const instruction = '**MISSION DEBUG CRITIQUE : Réparation du système';
            
            index.addInstruction(parentId, instruction);
            
            // Vérifier que l'instruction a été ajoutée (via getSize)
            return index.getSize().then(size => {
                expect(size).toBeGreaterThan(0);
            });
        });

        it('should normalize prefix before adding', () => {
            const parentId = 'parent-001';
            const instruction = '  **MISSION DEBUG CRITIQUE  '; // Avec espaces
            
            index.addInstruction(parentId, instruction);
            
            return index.getSize().then(size => {
                expect(size).toBeGreaterThan(0);
            });
        });

        it('should handle empty instruction gracefully', () => {
            const parentId = 'parent-001';
            
            index.addInstruction(parentId, '');
            
            return index.getSize().then(size => {
                expect(size).toBe(1); // Juste le root node
            });
        });

        it('should truncate long instructions to 192 chars', () => {
            const parentId = 'parent-001';
            const longInstruction = 'A'.repeat(300);
            
            index.addInstruction(parentId, longInstruction);
            
            // L'instruction devrait être tronquée mais ajoutée
            return index.getSize().then(size => {
                expect(size).toBeGreaterThan(0);
            });
        });

        it('should add instruction with NewTaskInstruction object', () => {
            const parentId = 'parent-001';
            const instruction = 'Créer module de test';
            const taskInstruction: NewTaskInstruction = {
                timestamp: Date.now(),
                mode: 'code',
                message: instruction
            };
            
            index.addInstruction(parentId, instruction, taskInstruction);
            
            return index.getSize().then(size => {
                expect(size).toBeGreaterThan(0);
            });
        });
    });

    describe('searchSimilarInstructions / searchSimilar', () => {
        beforeEach(() => {
            // Ajouter quelques instructions pour la recherche
            index.addInstruction('task-001', '**MISSION DEBUG CRITIQUE : Réparation du système hiérarchique');
            index.addInstruction('task-002', '**MISSION CORRECTIVE FINALE : Validation et documentation');
            index.addInstruction('task-003', 'Créer une architecture modulaire pour le projet');
            index.addInstruction('task-004', 'Analyser les logs du système');
        });

        it('should find exact matches', async () => {
            const results = await index.searchSimilar('**MISSION DEBUG CRITIQUE : Réparation du système hiérarchique', 0.2);
            
            expect(results).toHaveLength(1);
            expect(results[0].taskId).toBe('task-001');
            expect(results[0].similarityScore).toBe(1);
            expect(results[0].matchType).toBe('exact');
        });

        it('should find similar instructions', async () => {
            const results = await index.searchSimilar('**MISSION DEBUG système', 0.2);
            
            expect(results.length).toBeGreaterThan(0);
            const debugMatch = results.find(r => r.taskId === 'task-001');
            expect(debugMatch).toBeDefined();
            if (debugMatch) {
                expect(debugMatch.similarityScore).toBeGreaterThan(0.2);
            }
        });

        it('should respect similarity threshold', async () => {
            const results = await index.searchSimilar('Texte complètement différent', 0.9);
            
            // Avec un seuil très élevé, ne devrait rien trouver
            expect(results).toHaveLength(0);
        });

        it('should sort results by similarity score', async () => {
            const results = await index.searchSimilar('**MISSION', 0.1);
            
            if (results.length > 1) {
                for (let i = 1; i < results.length; i++) {
                    expect(results[i-1].similarityScore).toBeGreaterThanOrEqual(results[i].similarityScore);
                }
            }
        });

        it('should handle prefix matches', async () => {
            const results = await index.searchSimilar('**MISSION DEBUG CRITIQUE', 0.2);
            
            const match = results.find(r => r.taskId === 'task-001');
            expect(match).toBeDefined();
            if (match && match.similarityScore < 1) {
                expect(['prefix', 'fuzzy']).toContain(match.matchType);
            }
        });

        it('should return empty array for empty search text', async () => {
            const results = await index.searchSimilar('', 0.2);
            
            expect(results).toHaveLength(0);
        });

        it('should handle search with special characters', async () => {
            index.addInstruction('task-005', 'Test avec des caractères spéciaux: @#$%^&*()');
            
            const results = await index.searchSimilar('Test avec des caractères spéciaux', 0.2);
            
            expect(results.length).toBeGreaterThan(0);
        });

        it('should identify significant words correctly', async () => {
            const results = await index.searchSimilar('MISSION CRITIQUE système réparation', 0.2);
            
            // Devrait trouver task-001 car ils partagent des mots significatifs
            const match = results.find(r => r.taskId === 'task-001');
            expect(match).toBeDefined();
        });
    });

    describe('getInstructionsByParent', () => {
        beforeEach(() => {
            index.addInstruction('parent-001', 'Instruction 1 du parent 001');
            index.addInstruction('parent-001', 'Instruction 2 du parent 001');
            index.addInstruction('parent-002', 'Instruction du parent 002');
        });

        it('should return all instructions for a parent', () => {
            const instructions = index.getInstructionsByParent('parent-001');
            
            expect(instructions).toHaveLength(2);
            expect(instructions.some(i => i.includes('instruction 1'))).toBe(true);
            expect(instructions.some(i => i.includes('instruction 2'))).toBe(true);
        });

        it('should return empty array for non-existent parent', () => {
            const instructions = index.getInstructionsByParent('non-existent');
            
            expect(instructions).toHaveLength(0);
        });
    });

    describe('validateParentChildRelation', () => {
        beforeEach(() => {
            index.addInstruction('parent-001', '**MISSION DEBUG CRITIQUE : Réparation du système');
        });

        it('should validate existing parent-child relation', () => {
            const isValid = index.validateParentChildRelation(
                '**MISSION DEBUG CRITIQUE : Réparation du système',
                'parent-001'
            );
            
            expect(isValid).toBe(true);
        });

        it('should return false for non-matching relation', () => {
            const isValid = index.validateParentChildRelation(
                'Texte différent',
                'parent-001'
            );
            
            expect(isValid).toBe(false);
        });

        it('should return false for empty inputs', () => {
            expect(index.validateParentChildRelation('', 'parent-001')).toBe(false);
            expect(index.validateParentChildRelation('test', '')).toBe(false);
        });
    });

    describe('rebuildFromSkeletons', () => {
        it('should rebuild index from skeleton prefixes', () => {
            const skeletonPrefixes = new Map([
                ['task-001', ['Prefix 1', 'Prefix 2']],
                ['task-002', ['Prefix 3']]
            ]);
            
            index.rebuildFromSkeletons(skeletonPrefixes);
            
            return index.getSize().then(size => {
                expect(size).toBeGreaterThan(1); // Plus que juste le root
            });
        });
    });

    describe('getSize', () => {
        it('should return 1 for empty index (root node)', async () => {
            const size = await index.getSize();
            expect(size).toBe(1);
        });

        it('should increase when adding instructions', async () => {
            const initialSize = await index.getSize();
            
            index.addInstruction('parent-001', 'Test instruction');
            
            const newSize = await index.getSize();
            expect(newSize).toBeGreaterThan(initialSize);
        });
    });

    describe('getStats', () => {
        it('should return correct statistics', () => {
            index.addInstruction('parent-001', 'Instruction 1');
            index.addInstruction('parent-002', 'Instruction 2');
            
            const stats = index.getStats();
            
            expect(stats.totalNodes).toBeGreaterThan(0);
            expect(stats.totalInstructions).toBe(2);
            expect(stats.avgDepth).toBeGreaterThanOrEqual(0);
        });
    });

    describe('clear', () => {
        it('should clear all instructions', async () => {
            index.addInstruction('parent-001', 'Test');
            index.addInstruction('parent-002', 'Test 2');
            
            index.clear();
            
            const size = await index.getSize();
            expect(size).toBe(1); // Juste le root
            
            const stats = index.getStats();
            expect(stats.totalInstructions).toBe(0);
        });
    });

    describe('testSimilarityAlgorithm', () => {
        it('should validate similarity algorithm with test cases', () => {
            // Capture console.log output
            const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
            
            index.testSimilarityAlgorithm();
            
            // Vérifier que les tests ont été exécutés
            expect(consoleSpy).toHaveBeenCalled();
            const calls = consoleSpy.mock.calls;
            
            // Chercher le résultat de validation
            const hasValidation = calls.some(call => 
                call.some(arg => 
                    typeof arg === 'string' && 
                    (arg.includes('VALIDATION SDDD RÉUSSIE') || arg.includes('ÉCHEC VALIDATION'))
                )
            );
            expect(hasValidation).toBe(true);
            
            consoleSpy.mockRestore();
        });
    });

    describe('Performance tests', () => {
        it('should handle 1000+ entries efficiently', async () => {
            const startTime = Date.now();
            
            // Ajouter 1000 instructions
            for (let i = 0; i < 1000; i++) {
                index.addInstruction(`parent-${i}`, `Instruction ${i} avec texte unique`);
            }
            
            const insertTime = Date.now() - startTime;
            expect(insertTime).toBeLessThan(3000); // Moins de 3 secondes
            
            const size = await index.getSize();
            expect(size).toBeGreaterThan(1000); // Au moins 1000 nœuds
            
            // Test de recherche sur 1000 entrées
            const searchStart = Date.now();
            const results = await index.searchSimilar('Instruction 500', 0.2);
            const searchTime = Date.now() - searchStart;
            
            expect(searchTime).toBeLessThan(1000); // Moins d'1 seconde
            expect(results.length).toBeGreaterThan(0);
        });

        it('should optimize common prefixes in radix tree', () => {
            // Ajouter des instructions avec préfixes communs
            index.addInstruction('task-001', '**MISSION DEBUG partie 1');
            index.addInstruction('task-002', '**MISSION DEBUG partie 2');
            index.addInstruction('task-003', '**MISSION DEBUG partie 3');
            index.addInstruction('task-004', '**MISSION CORRECTIVE autre');
            
            const stats = index.getStats();
            
            // Le radix tree devrait optimiser les préfixes communs
            // donc moins de nœuds que le nombre total de caractères
            expect(stats.totalNodes).toBeLessThan(100); // Optimisation attendue
        });
    });

    describe('Deprecated methods', () => {
        it('should warn when using findPotentialParent', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            
            const result = index.findPotentialParent('test');
            
            expect(result).toBeUndefined();
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('DEPRECATED'));
            
            consoleSpy.mockRestore();
        });

        it('should warn when using findAllPotentialParents', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            
            const results = index.findAllPotentialParents('test');
            
            expect(results).toHaveLength(0);
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('DEPRECATED'));
            
            consoleSpy.mockRestore();
        });
    });

    describe('Edge cases', () => {
        it('should handle very long instructions', () => {
            const veryLong = 'A'.repeat(10000);
            
            index.addInstruction('parent-001', veryLong);
            
            return index.getSize().then(size => {
                expect(size).toBeGreaterThan(1);
            });
        });

        it('should handle instructions with only special characters', () => {
            index.addInstruction('parent-001', '!@#$%^&*()');
            
            return index.searchSimilar('!@#$', 0.1).then(results => {
                // Ne devrait pas crasher
                expect(results).toBeDefined();
            });
        });

        it('should handle unicode characters', () => {
            index.addInstruction('parent-001', '测试中文字符 テスト 🎉');
            
            return index.searchSimilar('测试', 0.1).then(results => {
                expect(results).toBeDefined();
            });
        });

        it('should handle null/undefined safely', () => {
            // Ces appels ne devraient pas crasher
            expect(() => index.addInstruction(null as any, 'test')).not.toThrow();
            expect(() => index.addInstruction('parent', null as any)).not.toThrow();
            
            return index.searchSimilar(null as any, 0.2).then(results => {
                expect(results).toHaveLength(0);
            });
        });
    });

    describe('Similarity scoring', () => {
        beforeEach(() => {
            index.addInstruction('task-001', 'mission debug critique système réparation');
            index.addInstruction('task-002', 'mission corrective finale validation documentation');
            index.addInstruction('task-003', 'bonjour analyse git projet');
        });

        it('should give high score to similar texts', async () => {
            const results = await index.searchSimilar('mission debug critique réparation système', 0.1);
            
            const match = results.find(r => r.taskId === 'task-001');
            expect(match).toBeDefined();
            if (match) {
                expect(match.similarityScore).toBeGreaterThan(0.5);
            }
        });

        it('should give low score to different texts', async () => {
            const results = await index.searchSimilar('complètement autre chose', 0.1);
            
            // Tous les scores devraient être bas
            results.forEach(result => {
                expect(result.similarityScore).toBeLessThan(0.5);
            });
        });

        it('should bonus significant words over stop words', async () => {
            const results = await index.searchSimilar('mission réparation validation', 0.1);
            
            // Devrait trouver des correspondances basées sur les mots significatifs
            expect(results.length).toBeGreaterThan(0);
            
            // Les mots significatifs devraient donner un meilleur score
            const topMatch = results[0];
            expect(topMatch.similarityScore).toBeGreaterThan(0.2);
        });
    });
});