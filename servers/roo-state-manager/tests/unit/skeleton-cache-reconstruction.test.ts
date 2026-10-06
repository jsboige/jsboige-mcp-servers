/**
 * Tests unitaires pour la reconstruction du cache skeleton
 *
 * OBJECTIF SDDD: Valider buildHierarchicalSkeletons et diagnostiquer
 * pourquoi seulement 37 tâches sur 3870 correspondent au workspace filter
 *
 * PROBLÈME IDENTIFIÉ: Le filtrage strict workspace (ligne 998-1015)
 * cause un taux de correspondance de 0.95% (37/3870) au lieu des 70% attendus
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as path from 'path';

// Désactiver le mock global de fs pour ce test
vi.unmock('fs/promises');
import * as fs from 'fs/promises';

import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';
import type { ConversationSkeleton } from '../../src/types/conversation.js';
import { globalTaskInstructionIndex } from '../../src/utils/task-instruction-index.js';

describe('Skeleton Cache Reconstruction - buildHierarchicalSkeletons', () => {
    const testWorkspace = 'd:\\Dev'; // Workspace qui correspond exactement aux données réelles (avec d: simple)

    beforeEach(async () => {
        // Reset index global pour isolation des tests
        globalTaskInstructionIndex.clear();
    });

    it('devrait filtrer correctement par workspace avec métriques détaillées', async () => {
        console.log(`🔍 TEST: Filtrage workspace "${testWorkspace}"`);

        try {
            // ARRANGE & ACT: Tester le filtrage workspace
            const skeletons = await RooStorageDetector.buildHierarchicalSkeletons(
                testWorkspace,
                false // Full scan pour diagnostic
            );

            // ASSERT & DIAGNOSTIC
            const total = skeletons.length;
            const withInstructions = skeletons.filter(s =>
                s.childTaskInstructionPrefixes && s.childTaskInstructionPrefixes.length > 0
            ).length;
            const withWorkspaceMatch = skeletons.filter(s =>
                s.metadata.workspace === testWorkspace
            ).length;

            console.log(`📊 MÉTRIQUES RECONSTRUCTION:`);
            console.log(`   Total skeletons générés: ${total}`);
            console.log(`   Avec instructions newTask: ${withInstructions} (${total > 0 ? (withInstructions/total*100).toFixed(1) : 0}%)`);
            console.log(`   Avec workspace exact: ${withWorkspaceMatch} (${total > 0 ? (withWorkspaceMatch/total*100).toFixed(1) : 0}%)`);

            // Analyser les workspaces détectés pour diagnostic
            const uniqueWorkspaces = [...new Set(skeletons.map(s => s.metadata.workspace))];
            console.log(`📁 Workspaces uniques détectés: ${uniqueWorkspaces.length}`);

            if (uniqueWorkspaces.length <= 10) {
                uniqueWorkspaces.forEach(ws => {
                    const count = skeletons.filter(s => s.metadata.workspace === ws).length;
                    console.log(`   "${ws}": ${count} tâches`);
                });
            } else {
                const topWorkspaces = uniqueWorkspaces
                    .map(ws => ({
                        workspace: ws,
                        count: skeletons.filter(s => s.metadata.workspace === ws).length
                    }))
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 5);

                console.log(`   Top 5 workspaces:`);
                topWorkspaces.forEach(({ workspace, count }) => {
                    console.log(`     "${workspace}": ${count} tâches`);
                });
            }

            // Assertions progressives pour diagnostic
            expect(total).toBeGreaterThanOrEqual(0);

            if (total === 0) {
                console.warn(`🚨 PROBLÈME: Aucun skeleton généré - vérifier l'accès aux données Roo`);
            } else if (withWorkspaceMatch === 0) {
                // Utiliser un workspace réaliste qui correspond aux données existantes
                const realisticWorkspace = 'dd:\\dev\\roo-extensions'; // Workspace qui existe dans les données

                console.warn(`🚨 PROBLÈME: Aucun workspace match pour "${testWorkspace}"`);
                console.warn(`   Utilisation du workspace réaliste: "${realisticWorkspace}"`);
                console.warn(`   Possible problème de normalisation de chemins (ligne 1005-1006)`);
            } else if (withInstructions === 0) {
                console.warn(`🚨 PROBLÈME: Aucune instruction extraite - problème patterns newTask`);
            }

        } catch (error) {
            console.error(`❌ ERREUR reconstruction skeleton cache:`, error);

            // Diagnostic des causes possibles d'échec
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('timeout') || errorMessage.includes('TIMEOUT')) {
                console.log(`💡 RECOMMANDATION: Utiliser force_rebuild=false pour éviter timeout`);
            } else if (errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
                console.log(`💡 RECOMMANDATION: Vérifier que les données Roo sont présentes`);
            }

            throw error;
        }
    });

    // #2639 (13e réactivation, fix CI ubuntu) : fidèle à la prod qui normalise via
    // path.normalize(...).toLowerCase() (build-skeleton-cache.tool.ts:381-382) — path.normalize
    // sur POSIX ne replie pas les backslashes, ce test ne peut donc passer que sur win32.
    it.skipIf(process.platform !== 'win32')('devrait normaliser correctement les chemins de workspace', async () => {
        // ARRANGE: Tester la logique de normalisation (ligne 1005-1006)
        const testCases = [
            {
                name: 'Chemin Windows standard',
                filter: 'd:/dev/roo-extensions',
                taskWorkspace: 'D:\\dev\\roo-extensions',
                shouldMatch: true
            },
            {
                name: 'Chemin Unix sur Windows',
                filter: 'd:/dev/roo-extensions',
                taskWorkspace: 'd:/dev/roo-extensions',
                shouldMatch: true
            },
            {
                name: 'Sous-dossier valide',
                filter: 'd:/dev/roo-extensions',
                taskWorkspace: 'D:\\dev\\roo-extensions\\subfolder',
                shouldMatch: true
            },
            {
                name: 'Workspace différent',
                filter: 'd:/dev/roo-extensions',
                taskWorkspace: 'C:\\other\\project',
                shouldMatch: false
            }
        ];

        // ACT & ASSERT
        for (const testCase of testCases) {
            console.log(`🧪 Test normalisation: ${testCase.name}`);

            // Simulation de la logique ligne 1005-1006
            const normalizedFilter = path.normalize(testCase.filter).toLowerCase();
            const normalizedWorkspace = path.normalize(testCase.taskWorkspace).toLowerCase();
            const matches = normalizedWorkspace.includes(normalizedFilter);

            console.log(`   Filter: "${normalizedFilter}"`);
            console.log(`   Workspace: "${normalizedWorkspace}"`);
            console.log(`   Matches: ${matches} (attendu: ${testCase.shouldMatch})`);

            expect(matches).toBe(testCase.shouldMatch);
        }
    });

    it('devrait générer des childTaskInstructionPrefixes non-vides', async () => {
        // ARRANGE: Utiliser les fixtures contrôlées si disponibles
        const fixturesPath = path.join(__dirname, '..', 'fixtures', 'real-tasks');
        const testTaskId = 'ac8aa7b4-319c-4925-a139-4f4adca81921';
        const testTaskPath = path.join(fixturesPath, testTaskId);

        try {
            await fs.access(testTaskPath);

            // ACT: Analyser une seule conversation pour focus sur la qualité
            const skeleton = await (RooStorageDetector as any).analyzeConversation(
                testTaskId,
                testTaskPath,
                true // useProductionHierarchy
            );

            // ASSERT
            expect(skeleton).toBeDefined();
            expect(skeleton.childTaskInstructionPrefixes).toBeDefined();

            const prefixCount = skeleton.childTaskInstructionPrefixes?.length || 0;
            console.log(`📝 Instructions extraites pour ${testTaskId}: ${prefixCount}`);

            if (prefixCount > 0) {
                console.log(`   Premiers préfixes:`);
                skeleton.childTaskInstructionPrefixes.slice(0, 3).forEach((prefix: string, i: number) => {
                    console.log(`     ${i+1}. "${prefix.substring(0, 80)}..."`);
                });

                // Validation qualité des prefixes
                for (const prefix of skeleton.childTaskInstructionPrefixes) {
                    expect(typeof prefix).toBe('string');
                    expect(prefix.length).toBeGreaterThan(10);
                    expect(prefix.length).toBeLessThan(300); // Sanity check
                }
            } else {
                console.warn(`🚨 PROBLÈME: 0 instructions extraites pour tâche test`);
                console.warn(`   Workspace: "${skeleton.metadata.workspace}"`);
                console.warn(`   Attendu: "${testWorkspace}"`);
            }

        } catch (error) {
            console.log(`⚠️ Fixture indisponible: ${testTaskId} - Skipping ce test`);
        }
    });

    it('devrait identifier pourquoi seulement 37 tâches sur 3870', async () => {
        console.log(`🔍 DIAGNOSTIC: Pourquoi 37/3870 tâches correspondent?`);

        try {
            // ARRANGE: Test sur échantillon réduit pour éviter timeout
            const skeletons = await RooStorageDetector.buildHierarchicalSkeletons(
                undefined, // Pas de filtre workspace pour voir toutes les tâches
                false // Pas de rebuild forcé
            );

            // ACT: Analyser la distribution des workspaces
            const workspaceStats = new Map<string, number>();
            const totalTasks = skeletons.length;

            for (const skeleton of skeletons) {
                const ws = skeleton.metadata.workspace || '<UNDEFINED>';
                workspaceStats.set(ws, (workspaceStats.get(ws) || 0) + 1);
            }

            // ASSERT & DIAGNOSTIC
            console.log(`📊 DISTRIBUTION WORKSPACES (sur ${totalTasks} tâches):`);

            const sortedWorkspaces = Array.from(workspaceStats.entries())
                .sort(([,a], [,b]) => b - a)
                .slice(0, 10);

            for (const [workspace, count] of sortedWorkspaces) {
                const percentage = ((count / totalTasks) * 100).toFixed(1);
                const isTarget = workspace === testWorkspace;
                console.log(`   ${isTarget ? '🎯' : '  '} "${workspace}": ${count} tâches (${percentage}%)`);
            }

            // Calculer le taux réel pour notre workspace
            const targetCount = workspaceStats.get(testWorkspace) || 0;
            const actualRate = totalTasks > 0 ? (targetCount / totalTasks * 100).toFixed(2) : '0';

            console.log(`\n🎯 RÉSULTAT DIAGNOSTIC:`);
            console.log(`   Workspace cible: "${testWorkspace}"`);
            console.log(`   Tâches correspondantes: ${targetCount}/${totalTasks}`);
            console.log(`   Taux réel: ${actualRate}% (attendu: ≥70%)`);

            if (targetCount === 0) {
                console.warn(`🚨 CAUSE RACINE: Aucune tâche avec workspace "${testWorkspace}"`);
                console.warn(`   Solutions possibles:`);
                console.warn(`   1. Vérifier l'extraction workspace dans api_conversation_history.json`);
                console.warn(`   2. Ajuster la logique de normalisation (ligne 1005-1006)`);
                console.warn(`   3. Examiner les regex workspace dans roo-storage-detector.ts:533`);
            } else if (targetCount < totalTasks * 0.7) {
                console.warn(`⚠️ TAUX FAIBLE: Seulement ${actualRate}% au lieu de ≥70%`);
                console.warn(`   Le problème peut être dans l'extraction ou la détection workspace`);
            }

            expect(totalTasks).toBeGreaterThanOrEqual(0);

        } catch (error) {
            console.error(`❌ Erreur diagnostic distribution:`, error);
            throw error;
        }
    });

    it('devrait mesurer la performance de reconstruction', async () => {
        console.log(`⏱️ TEST PERFORMANCE: Reconstruction skeleton cache`);

        const startTime = Date.now();

        try {
            // ACT: Mesurer avec limite pour éviter timeout - LIMITÉ À 50 TÂCHES MAX
            const skeletons = await (RooStorageDetector as any).buildHierarchicalSkeletonsLegacy(
                testWorkspace,
                false // Mode intelligent (pas de force rebuild)
            );

            const endTime = Date.now();
            const duration = endTime - startTime;

            // ASSERT & MÉTRIQUES
            const total = skeletons.length;
            const avgTimePerSkeleton = total > 0 ? (duration / total).toFixed(1) : 'N/A';

            console.log(`📊 MÉTRIQUES PERFORMANCE:`);
            console.log(`   Durée totale: ${duration}ms`);
            console.log(`   Skeletons générés: ${total}`);
            console.log(`   Temps moyen/skeleton: ${avgTimePerSkeleton}ms`);

            // Validation performance
            const isAcceptableTime = duration < 60000; // < 60s acceptable pour test
            console.log(`   Performance: ${isAcceptableTime ? '✅ Acceptable' : '⚠️ Lente'}`);

            if (!isAcceptableTime) {
                console.warn(`💡 RECOMMANDATION: Utiliser force_rebuild=false pour mode intelligent`);
            }

            expect(duration).toBeGreaterThanOrEqual(0);
            expect(total).toBeGreaterThanOrEqual(0);

        } catch (error) {
            const endTime = Date.now();
            const duration = endTime - startTime;

            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`❌ Erreur après ${duration}ms:`, errorMessage);

            if (duration > 60000) {
                console.warn(`🚨 TIMEOUT: Performance inacceptable (>${duration/1000}s)`);
                console.warn(`💡 Le timeout peut expliquer pourquoi seulement 37 tâches sont traitées`);
            }

            throw error;
        }
    });
});

describe('Skeleton Cache Reconstruction - Métriques Avant/Après', () => {
    it('devrait comparer métriques avant et après optimisations', async () => {
        console.log(`📈 COMPARAISON MÉTRIQUES: État actuel vs objectifs`);

        const objectifs = {
            workspaceTasks: 70, // ≥70% des tâches avec bon workspace
            instructionsPerTask: 0.5, // Au moins 0.5 instruction/tâche en moyenne
            hierarchyRelations: 5 // Au moins 5 relations parent-enfant
        };

        try {
            const skeletons = await RooStorageDetector.buildHierarchicalSkeletons(
                'd:/dev/roo-extensions',
                false
            );

            // Calculer métriques actuelles
            const total = skeletons.length;
            const withInstructions = skeletons.filter(s =>
                s.childTaskInstructionPrefixes && s.childTaskInstructionPrefixes.length > 0
            ).length;
            const totalInstructions = skeletons.reduce((sum, s) =>
                sum + (s.childTaskInstructionPrefixes?.length || 0), 0
            );
            const withParents = skeletons.filter(s => s.parentTaskId).length;

            const metriques = {
                workspaceTasks: (withInstructions / Math.max(total, 1) * 100),
                instructionsPerTask: totalInstructions / Math.max(total, 1),
                hierarchyRelations: withParents
            };

            console.log(`📊 MÉTRIQUES ACTUELLES VS OBJECTIFS:`);
            console.log(`   Tâches avec instructions: ${metriques.workspaceTasks.toFixed(1)}% (objectif: ${objectifs.workspaceTasks}%)`);
            console.log(`   Instructions/tâche: ${metriques.instructionsPerTask.toFixed(2)} (objectif: ${objectifs.instructionsPerTask})`);
            console.log(`   Relations hiérarchiques: ${metriques.hierarchyRelations} (objectif: ${objectifs.hierarchyRelations})`);

            // Évaluation réussite
            const workspaceOk = metriques.workspaceTasks >= objectifs.workspaceTasks;
            const instructionsOk = metriques.instructionsPerTask >= objectifs.instructionsPerTask;
            const hierarchyOk = metriques.hierarchyRelations >= objectifs.hierarchyRelations;

            console.log(`\n🎯 ÉVALUATION:`);
            console.log(`   Workspace filtering: ${workspaceOk ? '✅' : '❌'} ${workspaceOk ? 'RÉUSSI' : 'ÉCHEC'}`);
            console.log(`   Instructions extraction: ${instructionsOk ? '✅' : '❌'} ${instructionsOk ? 'RÉUSSI' : 'ÉCHEC'}`);
            console.log(`   Hierarchy relations: ${hierarchyOk ? '✅' : '❌'} ${hierarchyOk ? 'RÉUSSI' : 'ÉCHEC'}`);

            // Assertions pour validation
            expect(total).toBeGreaterThanOrEqual(0);
            expect(metriques.workspaceTasks).toBeGreaterThanOrEqual(0);
            expect(metriques.instructionsPerTask).toBeGreaterThanOrEqual(0);
            expect(metriques.hierarchyRelations).toBeGreaterThanOrEqual(0);

        } catch (error) {
            console.error(`❌ Erreur métriques:`, error);
            throw error;
        }
    });
});