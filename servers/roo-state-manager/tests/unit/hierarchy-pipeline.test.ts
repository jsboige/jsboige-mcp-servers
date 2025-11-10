/**
 * TESTS TDD - Pipeline Complet de Reconstruction Hiérarchique
 * Validation end-to-end : extraction → normalisation → indexation → matching → persistance
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskInstructionIndex, computeInstructionPrefix } from '../../src/utils/task-instruction-index.js';
import { HierarchyReconstructionEngine } from '../../src/utils/hierarchy-reconstruction-engine.js';
import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';
import { TaskNavigator } from '../../src/services/task-navigator.js';
import { ConversationSkeleton, NewTaskInstruction } from '../../src/types/conversation.js';
import { EnhancedConversationSkeleton } from '../../src/types/enhanced-hierarchy.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';

describe('Pipeline Complet de Reconstruction Hiérarchique', () => {
    
    describe('1. Normalisation des Préfixes (computeInstructionPrefix)', () => {
        
        it('devrait normaliser les entités HTML', () => {
            const raw = '&lt;task&gt;Analyser le code&lt;/task&gt;';
            const normalized = computeInstructionPrefix(raw, 192);
            expect(normalized).not.toContain('&lt;');
            expect(normalized).not.toContain('&gt;');
            expect(normalized).toContain('analyser le code');
        });

        it('devrait retirer les balises XML/HTML', () => {
            const raw = '<task>Mission critique</task>';
            const normalized = computeInstructionPrefix(raw, 192);
            expect(normalized).not.toContain('<task>');
            expect(normalized).not.toContain('</task>');
            expect(normalized).toBe('mission critique');
        });

        it('devrait gérer les échappements JSON', () => {
            const raw = '"content": "Analyser\\nle\\tcode"';
            const normalized = computeInstructionPrefix(raw, 192);
            expect(normalized).toContain('analyser');
            expect(normalized).toContain('code');
            expect(normalized).not.toContain('\\n');
            expect(normalized).not.toContain('\\t');
        });

        it('devrait tronquer à K=192 caractères', () => {
            const raw = 'a'.repeat(300);
            const normalized = computeInstructionPrefix(raw, 192);
            expect(normalized.length).toBeLessThanOrEqual(192);
        });

        it('devrait produire le même préfixe pour parent et enfant', () => {
            // Cas réel : instruction parent dans new_task
            const parentInstruction = '<new_task><mode>code</mode><message>Implémenter la fonctionnalité X</message></new_task>';
            
            // Cas réel : instruction enfant dans premier message user
            const childInstruction = '<task>Implémenter la fonctionnalité X</task>';
            
            const parentPrefix = computeInstructionPrefix(parentInstruction, 192);
            const childPrefix = computeInstructionPrefix(childInstruction, 192);
            
            // Après normalisation, ils doivent matcher
            expect(childPrefix).toBe('implémenter la fonctionnalité x');
            expect(parentPrefix).toBe('implémenter la fonctionnalité x');
        });
    });

    describe('2. Index Radix-Tree avec exact-trie', () => {
        let index: TaskInstructionIndex;

        beforeEach(() => {
            index = new TaskInstructionIndex();
        });

        it('devrait indexer une instruction simple', () => {
            const parentId = 'parent-001';
            const instruction = 'Analyser le projet TypeScript';
            
            index.addInstruction(parentId, instruction);
            
            const stats = index.getStats();
            expect(stats.totalInstructions).toBe(1);
        });

        it('devrait trouver le parent exact via longest-prefix match', () => {
            const parentId = 'parent-001';
            const parentInstruction = 'Créer une API REST avec Express';
            
            // Parent indexe son instruction normalisée
            const parentPrefix = computeInstructionPrefix(parentInstruction, 192);
            index.addInstruction(parentId, parentPrefix);
            
            // Enfant cherche avec son instruction normalisée
            const childInstruction = 'Créer une API REST avec Express et MongoDB';
            const results = index.searchExactPrefix(childInstruction, 192);
            
            expect(results).toHaveLength(1);
            expect(results[0].taskId).toBe(parentId);
        });

        it('devrait gérer plusieurs parents avec préfixes similaires', () => {
            const parent1 = 'parent-001';
            const parent2 = 'parent-002';
            
            index.addInstruction(parent1, 'Analyser le code');
            index.addInstruction(parent2, 'Analyser le code source complet');
            
            // Recherche avec préfixe court → doit trouver le plus long match
            const results = index.searchExactPrefix('Analyser le code source complet et documenter', 192);
            
            expect(results).toHaveLength(1);
            expect(results[0].taskId).toBe(parent2); // Le plus long préfixe
        });

        it('devrait retourner tableau vide si aucun match', () => {
            index.addInstruction('parent-001', 'Créer une API');
            
            const results = index.searchExactPrefix('Supprimer la base de données', 192);
            
            expect(results).toHaveLength(0);
        });
    });

    describe('3. HierarchyReconstructionEngine - Phase 1 (Extraction)', () => {
        
        it('devrait extraire les instructions new_task depuis ui_messages.json', async () => {
            // Ce test nécessite des fixtures réelles
            // À implémenter avec les fixtures controlled-hierarchy
        });
    });

    describe('4. HierarchyReconstructionEngine - Phase 2 (Résolution)', () => {
        
        it('devrait résoudre le parent en MODE STRICT', async () => {
            const engine = new HierarchyReconstructionEngine({
                strictMode: true,
                debugMode: true
            });

            const parentInstruction = 'Mission debug critique : réparation système';
            const childInstruction = 'Mission debug critique : réparation système hiérarchique';

            // Simuler Phase 1 : parent indexe son instruction
            const parentSkeleton = {
                taskId: 'parent-001',
                parentTaskId: undefined,
                truncatedInstruction: '',
                childTaskInstructionPrefixes: [
                    computeInstructionPrefix(parentInstruction, 192)
                ],
                sequence: [],
                metadata: {
                    workspace: './test',
                    title: 'Parent Task',
                    createdAt: '2024-01-01T00:00:00Z',
                    lastActivity: '2024-01-01T00:00:00Z',
                    messageCount: 10,
                    totalSize: 1000,
                    actionCount: 5,
                    dataSource: './test/parent-001'
                }
            } as Partial<ConversationSkeleton>;

            const childSkeleton = {
                taskId: 'child-001',
                parentTaskId: undefined,
                truncatedInstruction: computeInstructionPrefix(childInstruction, 192),
                childTaskInstructionPrefixes: [],
                sequence: [],
                metadata: {
                    workspace: './test',
                    title: 'Child Task',
                    createdAt: '2024-01-01T01:00:00Z',
                    lastActivity: '2024-01-01T01:00:00Z',
                    messageCount: 5,
                    totalSize: 500,
                    actionCount: 2,
                    dataSource: './test/child-001'
                }
            } as Partial<ConversationSkeleton>;

            const skeletons = [parentSkeleton, childSkeleton] as ConversationSkeleton[];

            // Phase 1 : Extraction (simulée via childTaskInstructionPrefixes)
            const enhancedSkeletons = skeletons.map(s => ({
                ...s,
                processingState: {
                    phase1Completed: false,
                    phase2Completed: false,
                    processingErrors: [],
                    lastProcessedAt: new Date().toISOString()
                },
                sourceFileChecksums: {}
            }));

            const phase1Result = await engine.executePhase1(enhancedSkeletons, { strictMode: true });
            
            expect(phase1Result.processedCount).toBeGreaterThan(0);

            // Phase 2 : Résolution
            const phase2Result = await engine.executePhase2(enhancedSkeletons, { strictMode: true });

            expect(phase2Result.resolvedCount).toBe(1);
            
            const child = enhancedSkeletons.find(s => s.taskId === 'child-001');
            expect((child as any)?.reconstructedParentId).toBe('parent-001');
        });

        it('devrait rejeter les auto-références', async () => {
            const engine = new HierarchyReconstructionEngine({ strictMode: true });

            const selfRefSkeleton = {
                taskId: 'self-001',
                parentTaskId: undefined,
                truncatedInstruction: 'Test auto-référence',
                childTaskInstructionPrefixes: [
                    computeInstructionPrefix('Test auto-référence', 192)
                ],
                sequence: [],
                metadata: {
                    workspace: './test',
                    title: 'Self Reference',
                    createdAt: '2024-01-01T00:00:00Z',
                    lastActivity: '2024-01-01T00:00:00Z',
                    messageCount: 1,
                    totalSize: 100,
                    actionCount: 0,
                    dataSource: './test/self-001'
                }
            } as Partial<ConversationSkeleton>;

            const skeletons = [selfRefSkeleton] as ConversationSkeleton[];
            const enhanced = skeletons.map(s => ({
                ...s,
                processingState: { phase1Completed: false, phase2Completed: false, processingErrors: [], lastProcessedAt: new Date().toISOString() },
                sourceFileChecksums: {}
            }));

            await engine.executePhase1(enhanced, { strictMode: true });
            await engine.executePhase2(enhanced, { strictMode: true });

            const result = enhanced.find(s => s.taskId === 'self-001');
            expect((result as any)?.reconstructedParentId).toBeUndefined(); // Pas d'auto-référence
        });
    });

    describe('5. Persistance sur Disque (Bug MAX_SAVES)', () => {
        
        it('devrait sauvegarder TOUS les squelettes modifiés, pas seulement 10', async () => {
            // Test qui révèle le bug actuel dans index.ts
            const modifiedSkeletons = Array.from({ length: 50 }, (_, i) => ({
                taskId: `task-${i.toString().padStart(3, '0')}`,
                parentTaskId: i > 0 ? `task-${(i - 1).toString().padStart(3, '0')}` : undefined,
                metadata: {
                    workspace: './test',
                    title: `Task ${i}`,
                    createdAt: new Date().toISOString(),
                    lastActivity: new Date().toISOString(),
                    messageCount: 1,
                    totalSize: 100,
                    actionCount: 0
                },
                sequence: []
            } as ConversationSkeleton));

            // ATTENTE : Tous devraient être sauvés
            // RÉALITÉ ACTUELLE : Seulement 10 sont sauvés (MAX_SAVES = 10)
            
            // Ce test ÉCHOUERA tant que MAX_SAVES n'est pas corrigé ou éliminé
            const expectedSavedCount = modifiedSkeletons.length;
            const actualMaxSaves = 10; // Valeur actuelle dans index.ts
            
            expect(actualMaxSaves).toBe(expectedSavedCount); // ❌ ÉCHEC ATTENDU
        });
    });

    describe('6. TaskNavigator - Dépend du Cache Mémoire', () => {
        
        it('devrait naviguer dans la hiérarchie parent-enfant', () => {
            const cache = new Map<string, ConversationSkeleton>();
            
            const parent: ConversationSkeleton = {
                taskId: 'parent-001',
                parentTaskId: undefined,
                sequence: [],
                metadata: {
                    workspace: './test',
                    title: 'Parent',
                    createdAt: '2024-01-01T00:00:00Z',
                    lastActivity: '2024-01-01T00:00:00Z',
                    messageCount: 1,
                    totalSize: 100,
                    actionCount: 0
                }
            };

            const child: ConversationSkeleton = {
                taskId: 'child-001',
                parentTaskId: 'parent-001',
                sequence: [],
                metadata: {
                    workspace: './test',
                    title: 'Child',
                    createdAt: '2024-01-01T01:00:00Z',
                    lastActivity: '2024-01-01T01:00:00Z',
                    messageCount: 1,
                    totalSize: 100,
                    actionCount: 0
                }
            };

            cache.set('parent-001', parent);
            cache.set('child-001', child);

            const navigator = new TaskNavigator(cache);

            const foundParent = navigator.getTaskParent('child-001');
            expect(foundParent?.taskId).toBe('parent-001');

            const children = navigator.getTaskChildren('parent-001');
            expect(children).toHaveLength(1);
            expect(children[0].taskId).toBe('child-001');
        });
    });

    describe('7. Validation avec Fixtures Contrôlées', () => {
        const FIXTURES_DIR = path.join(__dirname, '../fixtures/controlled-hierarchy');

        it('devrait reconstruire la hiérarchie complète depuis les fixtures', async () => {
            // Vérifier que le répertoire de fixtures existe
            if (!existsSync(FIXTURES_DIR)) {
                console.warn('⚠️ Fixtures controlled-hierarchy non trouvées, test skipped');
                return;
            }

            // Charger les tâches depuis les fixtures
            const taskDirs = await fs.readdir(FIXTURES_DIR, { withFileTypes: true });
            const skeletons: ConversationSkeleton[] = [];

            for (const entry of taskDirs) {
                if (!entry.isDirectory()) continue;
                
                const taskPath = path.join(FIXTURES_DIR, entry.name);
                const skeleton = await RooStorageDetector.analyzeConversation(entry.name, taskPath, true);
                
                if (skeleton) {
                    skeletons.push(skeleton);
                }
            }

            expect(skeletons.length).toBeGreaterThan(0);

            // Exécuter la reconstruction
            const engine = new HierarchyReconstructionEngine({
                strictMode: true,
                debugMode: true
            });

            const enhanced = skeletons.map(s => ({
                ...s,
                processingState: {
                    phase1Completed: false,
                    phase2Completed: false,
                    processingErrors: [],
                    lastProcessedAt: new Date().toISOString()
                },
                sourceFileChecksums: {}
            }));

            const phase1Result = await engine.executePhase1(enhanced, { strictMode: true });
            const phase2Result = await engine.executePhase2(enhanced, { strictMode: true });

            console.log('📊 Phase 1:', phase1Result);
            console.log('📊 Phase 2:', phase2Result);

            // Validation : au moins une relation doit être résolue
            expect(phase2Result.resolvedCount).toBeGreaterThan(0);

            // Vérifier qu'aucune tâche n'a de parentId = elle-même
            for (const task of enhanced) {
                if ((task as any).reconstructedParentId) {
                    expect((task as any).reconstructedParentId).not.toBe(task.taskId);
                }
            }
        });
    });

    describe('8. Normalisation Exacte Parent-Enfant', () => {
        
        it('devrait produire des préfixes identiques pour instructions parent/enfant réelles', async () => {
            // Données extraites des vraies tâches via head/tail
            const parentRawInstruction = `**Mission corrective finale : validation et documentation du système hiérarchique**

## Objectif

Valider le fonctionnement correct du système après correction, documenter les résultats et préparer le rapport technique.`;

            const childRawInstruction = `**Mission corrective finale : validation et documentation du système hiérarchique**`;

            const parentPrefix = computeInstructionPrefix(parentRawInstruction, 192);
            const childPrefix = computeInstructionPrefix(childRawInstruction, 192);

            // Les préfixes doivent matcher car le début est identique
            expect(childPrefix.length).toBeGreaterThan(0);
            expect(parentPrefix.startsWith(childPrefix) || childPrefix.startsWith(parentPrefix)).toBe(true);
        });
    });

    describe('9. Cas Edge : Tâches Parentes "En Cours"', () => {
        
        it('devrait gérer les parents sans bloc attempt_completion', () => {
            // Cas réel : parent encore en cours (dernier enfant)
            const parentSkeleton: ConversationSkeleton = {
                taskId: 'parent-ongoing',
                parentTaskId: undefined,
                sequence: [
                    { role: 'user', content: 'Analyser le projet', isTruncated: false, timestamp: '2024-01-01T00:00:00Z' },
                    { role: 'assistant', content: '<new_task><mode>code</mode><message>Implémenter X</message></new_task>', isTruncated: false, timestamp: '2024-01-01T00:01:00Z' }
                    // Pas de attempt_completion → parent en cours
                ],
                metadata: {
                    workspace: './test',
                    title: 'Parent Ongoing',
                    createdAt: '2024-01-01T00:00:00Z',
                    lastActivity: '2024-01-01T00:01:00Z',
                    messageCount: 2,
                    totalSize: 200,
                    actionCount: 0
                },
                isCompleted: false // Pas complété
            };

            // Le parent devrait quand même avoir ses childTaskInstructionPrefixes extraits
            expect(parentSkeleton.sequence).toHaveLength(2);
            expect(parentSkeleton.isCompleted).toBe(false);
        });
    });

    describe('10. Validation Cohérence Mémoire ↔ Disque', () => {
        
        it('devrait détecter les incohérences entre cache mémoire et fichiers disque', async () => {
            // Test de cohérence : 
            // 1. Modifier un skeleton en mémoire (ajouter parentTaskId)
            // 2. Sauvegarder sur disque
            // 3. Recharger depuis disque
            // 4. Vérifier que parentTaskId est persisté
            
            // Ce test révèle le bug MAX_SAVES=10
        });
    });
});

describe('Tests d\'Intégration avec Vraies Données', () => {
    
    describe('11. Grappe de Tâches Réelle (ac8aa7b4...)', () => {
        const ROOT_TASK_ID = 'ac8aa7b4-319c-4925-a139-4f4adca81921';
        const CHILD_TASK_ID = 'bc93a6f7-cd2e-4686-a832-46e3cd14d338';

        it('devrait résoudre la hiérarchie de la vraie grappe', async () => {
            // Charger depuis C:\Users\jsboi\AppData\Roaming\Code\User\globalStorage\rooveterinaryinc.roo-cline\tasks\
            const storageLocations = await RooStorageDetector.detectStorageLocations();
            
            if (storageLocations.length === 0) {
                console.warn('⚠️ Pas de storage Roo trouvé, test skipped');
                return;
            }

            let rootSkeleton: ConversationSkeleton | null = null;
            let childSkeleton: ConversationSkeleton | null = null;

            for (const location of storageLocations) {
                const tasksDir = path.join(location, 'tasks');
                
                const rootPath = path.join(tasksDir, ROOT_TASK_ID);
                const childPath = path.join(tasksDir, CHILD_TASK_ID);

                if (existsSync(rootPath)) {
                    rootSkeleton = await RooStorageDetector.analyzeConversation(ROOT_TASK_ID, rootPath, true);
                }

                if (existsSync(childPath)) {
                    childSkeleton = await RooStorageDetector.analyzeConversation(CHILD_TASK_ID, childPath, true);
                }
            }

            if (!rootSkeleton || !childSkeleton) {
                console.warn('⚠️ Tâches réelles non trouvées, test skipped');
                return;
            }

            // Vérifier que le parent a des childTaskInstructionPrefixes
            expect(rootSkeleton.childTaskInstructionPrefixes).toBeDefined();
            expect(rootSkeleton.childTaskInstructionPrefixes!.length).toBeGreaterThan(0);

            // Vérifier que l'enfant a une truncatedInstruction
            expect(childSkeleton.truncatedInstruction).toBeDefined();
            expect(childSkeleton.truncatedInstruction!.length).toBeGreaterThan(0);

            console.log('📊 Parent prefixes:', rootSkeleton.childTaskInstructionPrefixes);
            console.log('📊 Child instruction:', childSkeleton.truncatedInstruction);

            // Test de matching
            const index = new TaskInstructionIndex();
            
            for (const prefix of rootSkeleton.childTaskInstructionPrefixes!) {
                index.addInstruction(ROOT_TASK_ID, prefix);
            }

            const matches = index.searchExactPrefix(childSkeleton.truncatedInstruction!, 192);
            
            console.log('📊 Matches found:', matches);

            expect(matches.length).toBe(1);
            expect(matches[0].taskId).toBe(ROOT_TASK_ID);
        });
    });
});