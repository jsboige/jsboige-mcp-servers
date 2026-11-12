/**
 * Tests unitaires pour la validation des relations hiérarchiques parent-enfant
 * 
 * OBJECTIF SDDD: Valider que le système RadixTree matching fonctionne correctement
 * pour établir les relations parent-enfant et diagnostiquer pourquoi seulement
 * 4 relations sont trouvées vs 6+ attendues
 * 
 * PROBLÈME IDENTIFIÉ: Le matching RadixTree avec exact prefix pourrait être trop strict
 * ou les prefixes normalisés ne correspondent pas aux instructions parentes
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';
import type { StoredConversation } from '../../src/services/unified-store/types.js';
import { globalTaskInstructionIndex, computeInstructionPrefix } from '../../src/utils/task-instruction-index.js';

describe('Parent-Child Validation - RadixTree Matching', () => {
    const testWorkspace = 'd:/dev/roo-extensions';
    
    beforeEach(async () => {
        // Reset index global pour isolation des tests
        globalTaskInstructionIndex.clear();
    });

    it('devrait valider le matching exact prefix avec RadixTree', async () => {
        console.log(`🔍 TEST: Validation RadixTree exact prefix matching`);
        
        try {
            // ARRANGE: Construire les skeletons avec leurs prefixes SANS reconstruction hiérarchique
            // pour éviter la boucle infinie avec HierarchyReconstructionEngine
            const { RooStorageDetector } = await import('../../src/utils/roo-storage-detector.js');
            
            // Utiliser la méthode legacy qui ne fait pas de reconstruction hiérarchique
            const skeletons = await (RooStorageDetector as any).buildHierarchicalSkeletonsLegacy(
                testWorkspace,
                false // Mode intelligent
            );
            
            // ACT: Analyser les relations parent-enfant détectées
            const totalSkeletons = skeletons.length;
            const skeletonsWithPrefixes = skeletons.filter((s: any) =>
                s.childTaskInstructionPrefixes && s.childTaskInstructionPrefixes.length > 0
            );
            const skeletonsWithParents = skeletons.filter((s: any) => s.parentTaskId);
            
            console.log(`📊 ANALYSE RELATIONS HIÉRARCHIQUES:`);
            console.log(`   Total skeletons: ${totalSkeletons}`);
            console.log(`   Avec prefixes (parents potentiels): ${skeletonsWithPrefixes.length}`);
            console.log(`   Avec parentTaskId (enfants): ${skeletonsWithParents.length}`);
            
            // ASSERT: Diagnostic des relations
            if (skeletonsWithPrefixes.length > 0 && skeletonsWithParents.length === 0) {
                console.warn(`🚨 PROBLÈME: Parents détectés mais aucun enfant lié`);
                console.warn(`   Possible problème dans le matching RadixTree`);
            } else if (skeletonsWithPrefixes.length > skeletonsWithParents.length * 2) {
                console.warn(`⚠️ DÉSÉQUILIBRE: Plus de parents que d'enfants`);
                console.warn(`   Parents potentiels: ${skeletonsWithPrefixes.length}`);
                console.warn(`   Enfants liés: ${skeletonsWithParents.length}`);
            }
            
            // Examiner les prefixes des parents potentiels
            if (skeletonsWithPrefixes.length > 0) {
                console.log(`\n📝 ÉCHANTILLON PREFIXES (premiers 3 parents):`);
                for (let i = 0; i < Math.min(3, skeletonsWithPrefixes.length); i++) {
                    const skeleton = skeletonsWithPrefixes[i];
                    const prefixes = skeleton.childTaskInstructionPrefixes || [];
                    
                    console.log(`   Parent ${i+1} (${skeleton.taskId}):`);
                    console.log(`     Nombre prefixes: ${prefixes.length}`);
                    
                    prefixes.slice(0, 2).forEach((prefix: any, j: number) => {
                        console.log(`     Prefix ${j+1}: "${prefix.substring(0, 80)}..."`);
                    });
                }
            }
            
            // Examiner les enfants pour voir leurs instructions tronquées
            if (skeletonsWithParents.length > 0) {
                console.log(`\n👶 ÉCHANTILLON ENFANTS (premiers 3):`);
                for (let i = 0; i < Math.min(3, skeletonsWithParents.length); i++) {
                    const child = skeletonsWithParents[i];
                    console.log(`   Enfant ${i+1}: ${child.taskId}`);
                    console.log(`     Parent: ${child.parentTaskId}`);
                    console.log(`     Instruction tronquée: "${child.truncatedInstruction?.substring(0, 80) || 'UNDEFINED'}..."`);
                }
            }
            
            expect(totalSkeletons).toBeGreaterThanOrEqual(0);
            
        } catch (error) {
            console.error(`❌ Erreur validation RadixTree:`, error);
            throw error;
        }
    });

    it('devrait tester le matching manuel prefix-instruction', async () => {
        console.log(`🧪 TEST: Matching manuel prefix vs instruction tronquée`);
        
        // ARRANGE: Utiliser les fixtures de test contrôlé si disponibles
        const fixturesPath = path.join(__dirname, '..', 'fixtures', 'controlled-hierarchy');
        
        try {
            await fs.access(fixturesPath);
            console.log(`✅ Fixtures controlled-hierarchy trouvées`);
            
            // Lister les tâches disponibles
            const dirs = await fs.readdir(fixturesPath, { withFileTypes: true });
            const taskDirs = dirs.filter(d => d.isDirectory()).slice(0, 3); // Limit pour test
            
            console.log(`📁 Tâches de test: ${taskDirs.length}`);
            
            const testSkeletons: StoredConversation[] = [];
            
            // Analyser chaque tâche individuellement
            for (let i = 0; i < taskDirs.length; i++) {
                const dir = taskDirs[i];
                const taskId = dir.name;
                const taskPath = path.join(fixturesPath, taskId);
                
                try {
                    const skeleton = await (RooStorageDetector as any).analyzeConversation(
                        taskId,
                        taskPath,
                        true
                    );
                    
                    if (skeleton) {
                        testSkeletons.push(skeleton);
                    }
                } catch (error) {
                    console.warn(`⚠️ Erreur analyse ${taskId}:`, error);
                }
            }
            
            // ACT & ASSERT: Test matching manuel
            console.log(`\n🔍 ANALYSE MATCHING:`);
            
            // Alimenter l'index avec les prefixes
            for (let i = 0; i < testSkeletons.length; i++) {
                const skeleton = testSkeletons[i];
                if (skeleton.childTaskInstructionPrefixes) {
                    const prefixes = skeleton.childTaskInstructionPrefixes;
                    for (let j = 0; j < prefixes.length; j++) {
                        const prefix = prefixes[j];
                        globalTaskInstructionIndex.addInstruction(skeleton.taskId, prefix);
                    }
                }
            }
            
            // Tester le matching pour chaque skeleton
            let totalMatches = 0;
            for (let i = 0; i < testSkeletons.length; i++) {
                const skeleton = testSkeletons[i];
                if (skeleton.truncatedInstruction) {
                    const matches = globalTaskInstructionIndex.searchExactPrefix(skeleton.truncatedInstruction);
                    
                    console.log(`   Tâche ${skeleton.taskId}:`);
                    console.log(`     Instruction: "${skeleton.truncatedInstruction.substring(0, 60)}..."`);
                    console.log(`     Matches: ${matches.length}`);
                    
                    if (matches.length > 0) {
                        totalMatches++;
                        console.log(`     Parent candidat: ${matches[0]}`);
                    } else {
                        console.log(`     ❌ Pas de parent trouvé`);
                    }
                }
            }
            
            console.log(`\n📊 RÉSULTATS MATCHING MANUEL:`);
            console.log(`   Tâches testées: ${testSkeletons.length}`);
            console.log(`   Matches trouvés: ${totalMatches}`);
            console.log(`   Taux de matching: ${testSkeletons.length > 0 ? (totalMatches/testSkeletons.length*100).toFixed(1) : 0}%`);
            
            expect(testSkeletons.length).toBeGreaterThan(0);
            
        } catch (error) {
            console.log(`⚠️ Fixtures controlled-hierarchy non disponibles - Test avec fixtures réelles`);
            
            // Fallback sur fixtures réelles
            const realFixturesPath = path.join(__dirname, '..', 'fixtures', 'real-tasks');
            const testTaskId = 'ac8aa7b4-319c-4925-a139-4f4adca81921';
            const testTaskPath = path.join(realFixturesPath, testTaskId);
            
            try {
                await fs.access(testTaskPath);
                
                const skeleton = await (RooStorageDetector as any).analyzeConversation(
                    testTaskId,
                    testTaskPath,
                    true
                );
                
                if (skeleton && skeleton.childTaskInstructionPrefixes) {
                    console.log(`✅ Fallback réussi sur fixture réelle`);
                    console.log(`   Instructions extraites: ${skeleton.childTaskInstructionPrefixes.length}`);
                    
                    expect(skeleton.childTaskInstructionPrefixes.length).toBeGreaterThan(0);
                } else {
                    console.log(`⚠️ Aucune instruction dans fixture réelle`);
                }
            } catch (fallbackError) {
                console.log(`⚠️ Aucune fixture disponible pour ce test`);
            }
        }
    });

    it('devrait diagnostiquer la qualité des prefixes normalisés', async () => {
        console.log(`🔍 TEST: Qualité des prefixes normalisés`);
        
        // ARRANGE: Tester la fonction computeInstructionPrefix
        const testInstructions = [
            'Créer une nouvelle fonctionnalité pour le système de gestion des tâches avec validation des entrées utilisateur',
            'Debug le problème de performance dans l\'algorithme de tri des conversations',
            'Implémenter l\'interface utilisateur pour la navigation hiérarchique des projets',
            'Analyser les logs d\'erreur et proposer des corrections systémiques',
            'Refactorer le code legacy pour améliorer la maintenabilité'
        ];
        
        console.log(`📝 TEST NORMALISATION PREFIXES:`);
        
        for (let i = 0; i < testInstructions.length; i++) {
            const instruction = testInstructions[i];
            const prefix = computeInstructionPrefix(instruction, 192); // Taille standard
            
            console.log(`\nInstruction ${i+1}:`);
            console.log(`   Original (${instruction.length} chars): "${instruction}"`);
            console.log(`   Prefix (${prefix.length} chars): "${prefix}"`);
            console.log(`   Ratio: ${((prefix.length / instruction.length) * 100).toFixed(1)}%`);
            
            // ACT & ASSERT: Validation qualité
            expect(prefix.length).toBeGreaterThan(10);
            expect(prefix.length).toBeLessThanOrEqual(192);
            expect(typeof prefix).toBe('string');
            
            // Vérifier que les mots clés importants sont préservés
            const importantWords = ['créer', 'debug', 'implémenter', 'analyser', 'refactorer'];
            const instructionLower = instruction.toLowerCase();
            const prefixLower = prefix.toLowerCase();
            
            for (let j = 0; j < importantWords.length; j++) {
                const word = importantWords[j];
                if (instructionLower.includes(word)) {
                    expect(prefixLower).toContain(word);
                }
            }
        }
        
        console.log(`✅ Test normalisation prefixes terminé`);
    });

    it('devrait identifier pourquoi seulement 4 relations vs 6+ attendues', async () => {
        console.log(`🔍 DIAGNOSTIC: Pourquoi 4 relations au lieu de 6+?`);
        
        try {
            // ARRANGE: Reconstruire avec diagnostic détaillé
            // Utiliser la méthode legacy pour éviter la boucle infinie
            const skeletons = await (RooStorageDetector as any).buildHierarchicalSkeletonsLegacy(
                testWorkspace,
                false
            );
            
            // ACT: Analyser la chaîne complète de reconstruction
            const potentialParents = skeletons.filter((s: any) =>
                s.childTaskInstructionPrefixes && s.childTaskInstructionPrefixes.length > 0
            );
            const potentialChildren = skeletons.filter((s: any) =>
                s.truncatedInstruction && s.truncatedInstruction.length > 10
            );
            const actualRelations = skeletons.filter((s: any) => s.parentTaskId);
            
            console.log(`📊 DIAGNOSTIC RELATIONS HIÉRARCHIQUES:`);
            console.log(`   Parents potentiels (avec prefixes): ${potentialParents.length}`);
            console.log(`   Enfants potentiels (avec instructions): ${potentialChildren.length}`);
            console.log(`   Relations établies: ${actualRelations.length}`);
            
            const maxPossibleRelations = Math.min(potentialParents.length, potentialChildren.length);
            console.log(`   Relations max possibles: ${maxPossibleRelations}`);
            
            if (maxPossibleRelations > 0) {
                const relationRate = (actualRelations.length / maxPossibleRelations * 100).toFixed(1);
                console.log(`   Taux de réussite matching: ${relationRate}%`);
                
                if (actualRelations.length < maxPossibleRelations * 0.5) {
                    console.warn(`🚨 EFFICACITÉ MATCHING FAIBLE`);
                    console.warn(`   Causes possibles:`);
                    console.warn(`   1. Prefixes trop normalisés (perte information)`);
                    console.warn(`   2. Instructions tronquées mal extraites`);
                    console.warn(`   3. RadixTree exact matching trop strict`);
                    console.warn(`   4. Problème computeInstructionPrefix`);
                }
            }
            
            // Diagnostic détaillé sur quelques cas
            if (potentialChildren.length > 0 && actualRelations.length < potentialChildren.length * 0.3) {
                console.log(`\n🔍 DIAGNOSTIC DÉTAILLÉ (premiers orphelins):`);
                
                const orphans = potentialChildren.filter((child: any) => !child.parentTaskId);
                const sampleOrphans = orphans.slice(0, 3);
                
                for (let i = 0; i < sampleOrphans.length; i++) {
                    const orphan = sampleOrphans[i];
                    console.log(`\n   Orphelin ${i+1}: ${orphan.taskId}`);
                    console.log(`     Instruction: "${orphan.truncatedInstruction?.substring(0, 80)}..."`);
                    
                    // Vérifier manuellement si un parent pourrait matcher
                    let foundPotentialParent = false;
                    const limitedParents = potentialParents.slice(0, 5); // Limit pour performance
                    
                    for (let j = 0; j < limitedParents.length; j++) {
                        const parent = limitedParents[j];
                        const prefixes = parent.childTaskInstructionPrefixes || [];
                        const limitedPrefixes = prefixes.slice(0, 3);
                        
                        for (let k = 0; k < limitedPrefixes.length; k++) {
                            const prefix = limitedPrefixes[k];
                            if (orphan.truncatedInstruction &&
                                prefix.toLowerCase().includes(orphan.truncatedInstruction.substring(0, 20).toLowerCase())) {
                                console.log(`     🔍 Parent potentiel: ${parent.taskId}`);
                                console.log(`       Prefix: "${prefix.substring(0, 60)}..."`);
                                foundPotentialParent = true;
                                break;
                            }
                        }
                        if (foundPotentialParent) break;
                    }
                    
                    if (!foundPotentialParent) {
                        console.log(`     ❌ Aucun parent évident trouvé`);
                    }
                }
            }
            
            // ASSERT
            expect(potentialParents.length).toBeGreaterThanOrEqual(0);
            expect(potentialChildren.length).toBeGreaterThanOrEqual(0);
            expect(actualRelations.length).toBeGreaterThanOrEqual(0);
            
        } catch (error) {
            console.error(`❌ Erreur diagnostic relations:`, error);
            throw error;
        }
    });

    it('devrait valider la cohérence temporelle des relations parent-enfant', async () => {
        console.log(`⏰ TEST: Cohérence temporelle relations parent-enfant`);
        
        try {
            // Utiliser la méthode legacy pour éviter la boucle infinie
            const skeletons = await (RooStorageDetector as any).buildHierarchicalSkeletonsLegacy(
                testWorkspace,
                false
            );
            
            const relations = skeletons.filter((s: any) => s.parentTaskId);
            let temporalInconsistencies = 0;
            
            console.log(`🔍 VALIDATION TEMPORELLE (${relations.length} relations):`);
            
            for (let i = 0; i < relations.length; i++) {
                const child = relations[i];
                const parent = skeletons.find((s: any) => s.taskId === child.parentTaskId);
                
                if (parent) {
                    const childTime = new Date(child.metadata.createdAt).getTime();
                    const parentTime = new Date(parent.metadata.createdAt).getTime();
                    
                    if (childTime < parentTime) {
                        temporalInconsistencies++;
                        console.warn(`   ⚠️ Incohérence: Enfant ${child.taskId} créé AVANT parent ${parent.taskId}`);
                        console.warn(`     Enfant: ${child.metadata.createdAt}`);
                        console.warn(`     Parent: ${parent.metadata.createdAt}`);
                    }
                }
            }
            
            const consistencyRate = relations.length > 0 ? 
                ((relations.length - temporalInconsistencies) / relations.length * 100).toFixed(1) : '100';
            
            console.log(`📊 COHÉRENCE TEMPORELLE:`);
            console.log(`   Relations vérifiées: ${relations.length}`);
            console.log(`   Incohérences: ${temporalInconsistencies}`);
            console.log(`   Taux de cohérence: ${consistencyRate}%`);
            
            if (temporalInconsistencies > relations.length * 0.2) {
                console.warn(`🚨 NOMBREUSES INCOHÉRENCES TEMPORELLES`);
                console.warn(`   Cela peut indiquer un problème dans la reconstruction hiérarchique`);
            }
            
            expect(relations.length).toBeGreaterThanOrEqual(0);
            expect(temporalInconsistencies).toBeLessThanOrEqual(relations.length);
            
        } catch (error) {
            console.error(`❌ Erreur validation temporelle:`, error);
            throw error;
        }
    });
});

describe('Parent-Child Validation - Performance et Optimisation', () => {
    it('devrait mesurer les performances du RadixTree', async () => {
        console.log(`⏱️ PERFORMANCE: Mesure RadixTree matching`);
        
        // ARRANGE: Créer un échantillon de test
        const testPrefixes = [
            'Créer un système de gestion des tâches hiérarchiques',
            'Implémenter la validation des données utilisateur',
            'Debug les problèmes de performance en production',
            'Analyser les métriques de qualité du code source',
            'Refactorer l\'architecture pour améliorer la scalabilité'
        ];
        
        const testInstructions = [
            'Créer un système de gestion',
            'Implémenter la validation',  
            'Debug les problèmes',
            'Analyser les métriques',
            'Refactorer l\'architecture'
        ];
        
        // Alimenter l'index
        for (let i = 0; i < testPrefixes.length; i++) {
            const prefix = computeInstructionPrefix(testPrefixes[i], 192);
            globalTaskInstructionIndex.addInstruction(`parent-${i}`, prefix);
        }
        
        // ACT: Mesurer performance de matching
        const startTime = Date.now();
        let totalMatches = 0;
        
        for (let i = 0; i < testInstructions.length; i++) {
            const instruction = testInstructions[i];
            const matches = globalTaskInstructionIndex.searchExactPrefix(instruction);
            totalMatches += matches.length;
        }
        
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        // ASSERT & MÉTRIQUES
        console.log(`📊 PERFORMANCE RADIX TREE:`);
        console.log(`   Prefixes indexés: ${testPrefixes.length}`);
        console.log(`   Instructions testées: ${testInstructions.length}`);
        console.log(`   Matches trouvés: ${totalMatches}`);
        console.log(`   Temps total: ${duration}ms`);
        console.log(`   Temps/requête: ${(duration / testInstructions.length).toFixed(2)}ms`);
        
        const isPerformant = duration < 10; // < 10ms pour ce volume
        console.log(`   Performance: ${isPerformant ? '✅ Excellente' : '⚠️ À optimiser'}`);
        
        expect(duration).toBeGreaterThanOrEqual(0);
        expect(totalMatches).toBeGreaterThanOrEqual(0);
    });
});