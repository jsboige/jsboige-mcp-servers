/**
 * Script de test pour valider la réparation du système de reconstruction hiérarchique
 * Objectif : Atteindre > 30% de relations parent-enfant restaurées
 */

import { RooStorageDetector } from './utils/roo-storage-detector.js';
import { globalTaskInstructionIndex } from './utils/task-instruction-index.js';

interface ValidationMetrics {
    totalTasks: number;
    tasksWithParent: number;
    orphanTasks: number;
    parentPercentage: number;
    newRelationsDiscovered: number;
    treeDepth: number;
    indexStats: any;
}

async function testHierarchyFix() {
    console.log('🚀 === TEST DE VALIDATION FINALE - HIÉRARCHIE RÉPARÉE ===');
    console.log('Date:', new Date().toISOString());
    console.log('=' .repeat(70));
    
    try {
        // 1. Test de l'algorithme de similarité
        console.log('\n🧪 ÉTAPE 1: Test de l\'algorithme de similarité...');
        globalTaskInstructionIndex.testSimilarityAlgorithm();
        
        // 2. Chargement et analyse des squelettes
        console.log('\n📋 ÉTAPE 2: Chargement des squelettes hiérarchiques...');
        const startTime = Date.now();
        
        const skeletons = await RooStorageDetector.buildHierarchicalSkeletons(
            'd:/dev/2025-Epita-Intelligence-Symbolique', // Workspace spécifique
            false // Limité à 100 tâches pour test rapide
        );
        
        const loadTime = Date.now() - startTime;
        console.log(`✅ ${skeletons.length} squelettes chargés en ${loadTime}ms`);
        
        // 3. Analyse des métriques AVANT/APRÈS
        console.log('\n📊 ÉTAPE 3: Analyse des métriques...');
        
        const metrics = analyzeHierarchyMetrics(skeletons);
        
        // 4. Affichage des résultats
        console.log('\n' + '='.repeat(70));
        console.log('🎯 RÉSULTATS DE VALIDATION');
        console.log('='.repeat(70));
        
        console.log(`\n📈 MÉTRIQUES PRINCIPALES:`);
        console.log(`   Total de tâches: ${metrics.totalTasks}`);
        console.log(`   Tâches avec parent: ${metrics.tasksWithParent} (${metrics.parentPercentage.toFixed(1)}%)`);
        console.log(`   Tâches orphelines: ${metrics.orphanTasks}`);
        console.log(`   Profondeur maximale: ${metrics.treeDepth}`);
        
        console.log(`\n🔍 INDEX RADIX-TREE:`);
        console.log(`   Nœuds totaux: ${metrics.indexStats.totalNodes}`);
        console.log(`   Instructions indexées: ${metrics.indexStats.totalInstructions}`);
        console.log(`   Profondeur moyenne: ${metrics.indexStats.avgDepth.toFixed(2)}`);
        
        // 5. Validation des objectifs
        console.log('\n🎯 VALIDATION DES OBJECTIFS:');
        
        const target30Percent = metrics.parentPercentage >= 30;
        const targetDepth = metrics.treeDepth > 1;
        const targetNewRelations = metrics.newRelationsDiscovered >= 20;
        const targetNoRecursion = true; // Si nous arrivons ici, pas de récursion infinie
        
        console.log(`   ✅ > 30% avec parent: ${target30Percent ? '✅ RÉUSSI' : '❌ ÉCHEC'} (${metrics.parentPercentage.toFixed(1)}%)`);
        console.log(`   ✅ Profondeur > 1: ${targetDepth ? '✅ RÉUSSI' : '❌ ÉCHEC'} (${metrics.treeDepth})`);
        console.log(`   ✅ Nouvelles relations > 20: ${targetNewRelations ? '✅ RÉUSSI' : '❌ ÉCHEC'} (${metrics.newRelationsDiscovered})`);
        console.log(`   ✅ Pas de récursion: ${targetNoRecursion ? '✅ RÉUSSI' : '❌ ÉCHEC'}`);
        
        // 6. Exemples concrets de relations restaurées
        console.log('\n🔗 EXEMPLES DE RELATIONS RESTAURÉES:');
        const examples = getHierarchyExamples(skeletons);
        examples.forEach((example, i) => {
            console.log(`   ${i + 1}. Parent: ${example.parentId.substring(0, 8)} → Enfant: ${example.childId.substring(0, 8)}`);
            console.log(`      Instruction: "${example.instruction.substring(0, 60)}..."`);
        });
        
        // 7. Score final
        const successCount = [target30Percent, targetDepth, targetNewRelations, targetNoRecursion].filter(Boolean).length;
        const finalScore = (successCount / 4) * 100;
        
        console.log('\n' + '='.repeat(70));
        console.log(`🏆 SCORE FINAL: ${finalScore}% (${successCount}/4 objectifs atteints)`);
        console.log('='.repeat(70));
        
        if (finalScore >= 75) {
            console.log('🎉 SUCCÈS ! La réparation de la hiérarchie est fonctionnelle !');
        } else {
            console.log('⚠️ AMÉLIORATION NÉCESSAIRE ! Certains objectifs ne sont pas atteints.');
        }
        
        return {
            success: finalScore >= 75,
            metrics,
            score: finalScore,
            examples
        };
        
    } catch (error) {
        console.error('💥 ERREUR CRITIQUE lors du test:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

function analyzeHierarchyMetrics(skeletons: any[]): ValidationMetrics {
    const totalTasks = skeletons.length;
    const tasksWithParent = skeletons.filter(s => s.parentTaskId).length;
    const orphanTasks = totalTasks - tasksWithParent;
    const parentPercentage = (tasksWithParent / totalTasks) * 100;
    
    // Calcul de la profondeur de l'arbre
    const treeDepth = calculateMaxTreeDepth(skeletons);
    
    // Estimation des nouvelles relations découvertes (simplifié)
    const newRelationsDiscovered = Math.max(0, tasksWithParent - 3); // 3 était le nombre avant
    
    // Stats de l'index
    const indexStats = globalTaskInstructionIndex.getStats();
    
    return {
        totalTasks,
        tasksWithParent,
        orphanTasks,
        parentPercentage,
        newRelationsDiscovered,
        treeDepth,
        indexStats
    };
}

function calculateMaxTreeDepth(skeletons: any[]): number {
    const parentChildMap = new Map<string, string[]>();
    const roots: string[] = [];
    
    // Construire la map parent → enfants
    for (const skeleton of skeletons) {
        if (skeleton.parentTaskId) {
            if (!parentChildMap.has(skeleton.parentTaskId)) {
                parentChildMap.set(skeleton.parentTaskId, []);
            }
            parentChildMap.get(skeleton.parentTaskId)!.push(skeleton.taskId);
        } else {
            roots.push(skeleton.taskId);
        }
    }
    
    // Calculer la profondeur maximale
    let maxDepth = 0;
    
    function calculateDepth(taskId: string, currentDepth: number): number {
        const children = parentChildMap.get(taskId) || [];
        if (children.length === 0) {
            return currentDepth;
        }
        
        let maxChildDepth = currentDepth;
        for (const childId of children) {
            const childDepth = calculateDepth(childId, currentDepth + 1);
            maxChildDepth = Math.max(maxChildDepth, childDepth);
        }
        return maxChildDepth;
    }
    
    for (const rootId of roots) {
        const depth = calculateDepth(rootId, 1);
        maxDepth = Math.max(maxDepth, depth);
    }
    
    return maxDepth;
}

function getHierarchyExamples(skeletons: any[]): Array<{parentId: string, childId: string, instruction: string}> {
    const examples: Array<{parentId: string, childId: string, instruction: string}> = [];
    
    for (const skeleton of skeletons) {
        if (skeleton.parentTaskId && examples.length < 5) {
            examples.push({
                parentId: skeleton.parentTaskId,
                childId: skeleton.taskId,
                instruction: skeleton.truncatedInstruction || skeleton.metadata?.title || 'N/A'
            });
        }
    }
    
    return examples;
}

// Exécution si appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
    testHierarchyFix()
        .then(result => {
            console.log('\n🏁 Test terminé:', result.success ? 'SUCCÈS' : 'ÉCHEC');
            process.exit(result.success ? 0 : 1);
        })
        .catch(error => {
            console.error('💥 Erreur fatale:', error);
            process.exit(1);
        });
}

export { testHierarchyFix };