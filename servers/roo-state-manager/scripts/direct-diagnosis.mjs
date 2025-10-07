#!/usr/bin/env node

/**
 * Script de diagnostic direct pour la validation SDDD Phase 3
 * Teste buildHierarchicalSkeletons et les patterns d'extraction
 */

import { RooStorageDetector } from '../build/src/utils/roo-storage-detector.js';
import { globalTaskInstructionIndex } from '../build/src/utils/task-instruction-index.js';

const testWorkspace = 'd:/dev/roo-extensions';

console.log(`🔍 DIAGNOSTIC DIRECT SYSTÈME HIÉRARCHIQUE`);
console.log(`   Workspace cible: ${testWorkspace}`);
console.log(`   Timestamp: ${new Date().toISOString()}`);
console.log(`\n`);

try {
    // Reset global index
    globalTaskInstructionIndex.clear();
    
    console.log(`📊 ÉTAPE 1: Test buildHierarchicalSkeletons`);
    const startTime = Date.now();
    
    const skeletons = await RooStorageDetector.buildHierarchicalSkeletons(
        testWorkspace,
        false // Mode complet pour diagnostic
    );
    
    const duration = Date.now() - startTime;
    
    console.log(`✅ Reconstruction terminée en ${duration}ms`);
    console.log(`   Total skeletons: ${skeletons.length}`);
    
    // ANALYSE DÉTAILLÉE
    const withInstructions = skeletons.filter(s => 
        s.childTaskInstructionPrefixes && s.childTaskInstructionPrefixes.length > 0
    );
    const withWorkspace = skeletons.filter(s => s.metadata.workspace === testWorkspace);
    const withParent = skeletons.filter(s => s.parentTaskId);
    
    console.log(`\n📊 MÉTRIQUES CLÉS:`);
    console.log(`   Avec instructions newTask: ${withInstructions.length} (${skeletons.length > 0 ? (withInstructions.length/skeletons.length*100).toFixed(1) : 0}%)`);
    console.log(`   Workspace match exact: ${withWorkspace.length} (${skeletons.length > 0 ? (withWorkspace.length/skeletons.length*100).toFixed(1) : 0}%)`);
    console.log(`   Avec parentTaskId: ${withParent.length} (${skeletons.length > 0 ? (withParent.length/skeletons.length*100).toFixed(1) : 0}%)`);
    
    // DIAGNOSTIC WORKSPACES
    const uniqueWorkspaces = [...new Set(skeletons.map(s => s.metadata.workspace))];
    console.log(`\n📁 WORKSPACES DÉTECTÉS (${uniqueWorkspaces.length} uniques):`);
    
    if (uniqueWorkspaces.length <= 10) {
        uniqueWorkspaces.forEach(ws => {
            const count = skeletons.filter(s => s.metadata.workspace === ws).length;
            console.log(`   "${ws}": ${count} tâches${ws === testWorkspace ? ' ← CIBLE' : ''}`);
        });
    } else {
        // Top 10 workspaces
        const topWorkspaces = uniqueWorkspaces
            .map(ws => ({ 
                workspace: ws, 
                count: skeletons.filter(s => s.metadata.workspace === ws).length 
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
        
        topWorkspaces.forEach(({ workspace, count }) => {
            console.log(`   "${workspace}": ${count} tâches${workspace === testWorkspace ? ' ← CIBLE' : ''}`);
        });
    }
    
    // ÉCHANTILLON D'INSTRUCTIONS EXTRAITES
    if (withInstructions.length > 0) {
        console.log(`\n📝 ÉCHANTILLON INSTRUCTIONS EXTRAITES (3 premiers):`);
        
        withInstructions.slice(0, 3).forEach((skeleton, i) => {
            const prefixes = skeleton.childTaskInstructionPrefixes || [];
            console.log(`\n   Parent ${i+1}: ${skeleton.taskId}`);
            console.log(`     Workspace: ${skeleton.metadata.workspace}`);
            console.log(`     Nombre prefixes: ${prefixes.length}`);
            
            if (prefixes.length > 0) {
                console.log(`     Premier prefix (${prefixes[0].length} chars):`);
                console.log(`       "${prefixes[0].substring(0, 120)}..."`);
            }
        });
    }
    
    // DIAGNOSTIC PATTERN MATCHING
    if (withParent.length > 0) {
        console.log(`\n👶 ÉCHANTILLON ENFANTS AVEC PARENTS (3 premiers):`);
        
        withParent.slice(0, 3).forEach((child, i) => {
            console.log(`\n   Enfant ${i+1}: ${child.taskId}`);
            console.log(`     Parent: ${child.parentTaskId}`);
            console.log(`     Instruction: "${child.truncatedInstruction?.substring(0, 80) || 'UNDEFINED'}..."`);
            console.log(`     Workspace: ${child.metadata.workspace}`);
        });
    }
    
    // DIAGNOSTIC PATTERN 5 SPECIFIC
    console.log(`\n🔍 DIAGNOSTIC PATTERN 5 SPÉCIFIQUE:`);
    let pattern5Count = 0;
    
    for (const skeleton of skeletons.slice(0, 5)) { // Test 5 premiers seulement
        try {
            const uiPath = `${skeleton.metadata.conversationPath}/ui_messages.json`;
            
            // Tenter d'extraire avec PATTERN 5
            const instructions = await RooStorageDetector.extractNewTaskInstructionsFromUI(uiPath, 0);
            
            if (instructions && instructions.length > 0) {
                pattern5Count++;
                console.log(`   ✅ ${skeleton.taskId}: ${instructions.length} instructions via PATTERN 5`);
                
                // Montrer exemple
                if (instructions.length > 0) {
                    console.log(`      Exemple: "${instructions[0].substring(0, 60)}..."`);
                }
            }
        } catch (error) {
            // Skip silently pour ce diagnostic
        }
    }
    
    console.log(`   Total échantillon testé PATTERN 5: ${Math.min(5, skeletons.length)} tâches`);
    console.log(`   Avec instructions PATTERN 5: ${pattern5Count}`);
    
    // RÉSUMÉ FINAL
    console.log(`\n🎯 RÉSUMÉ DIAGNOSTIC SDDD:`);
    console.log(`   ❓ Problème #1: Seulement ${withWorkspace.length}/3870 tâches workspace "${testWorkspace}"`);
    console.log(`   ❓ Problème #2: ${withInstructions.length} instructions extraites (0 attendu corrigé)`);
    console.log(`   ❓ Problème #3: ${withParent.length} relations parent-enfant (4 vs 6+ attendues)`);
    
    // RECOMMANDATIONS
    console.log(`\n💡 RECOMMANDATIONS:`);
    if (withWorkspace.length < skeletons.length * 0.05) {
        console.log(`   1. Revoir filtrage workspace - taux très faible (${(withWorkspace.length/skeletons.length*100).toFixed(1)}%)`);
    }
    if (withInstructions.length === 0) {
        console.log(`   2. PATTERN 5 ne fonctionne pas - vérifier regex ligne 1295`);
    }
    if (withParent.length < withInstructions.length * 0.5) {
        console.log(`   3. RadixTree matching défaillant - taux ${withInstructions.length > 0 ? (withParent.length/withInstructions.length*100).toFixed(1) : 0}%`);
    }
    
    console.log(`\n✅ Diagnostic terminé avec succès`);
    
} catch (error) {
    console.error(`\n❌ ERREUR DIAGNOSTIC:`, error.message);
    console.error(`   Stack:`, error.stack?.split('\n').slice(0, 3).join('\n'));
    process.exit(1);
}