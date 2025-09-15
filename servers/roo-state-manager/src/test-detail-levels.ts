#!/usr/bin/env node

/**
 * Test script pour valider les 6 niveaux de détail du Strategy Pattern
 * 
 * Usage: node test-detail-levels.ts [taskId]
 * Teste tous les niveaux sur une conversation existante
 */

import { TraceSummaryService } from './services/TraceSummaryService.js';
import { ExportConfigManager } from './services/ExportConfigManager.js';
import { DetailLevel } from './types/enhanced-conversation.js';
import { ConversationSkeleton } from './types/conversation.js';
import { writeFile } from 'fs/promises';
import { join } from 'path';

// Mock ConversationSkeleton pour les tests (il faudra remplacer par de vraies données)
const createMockConversation = (taskId: string): ConversationSkeleton => ({
    taskId,
    parentTaskId: undefined,
    metadata: {
        title: `Test Conversation ${taskId}`,
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        mode: 'code',
        messageCount: 10,
        actionCount: 5,
        totalSize: 50000,
        workspace: "D:/dev/test-workspace"
    },
    sequence: [
        // Messages et actions de mock pour les tests
        {
            role: 'user',
            content: `Message utilisateur de test pour ${taskId}`,
            timestamp: new Date().toISOString(),
            isTruncated: false
        },
        {
            role: 'assistant',
            content: `Réponse assistant de test pour ${taskId}`,
            timestamp: new Date().toISOString(),
            isTruncated: false
        },
        {
            type: 'tool',
            name: 'read_file',
            parameters: { path: 'test.txt' },
            status: 'success',
            timestamp: new Date().toISOString(),
            content_size: 1000
        }
    ]
});

/**
 * Teste tous les niveaux de détail sur une conversation
 */
async function testDetailLevels(taskId: string) {
    console.log('🧪 Test des 6 Niveaux de Détail SDDD Phase 3');
    console.log('===============================================\n');

    const exportConfigManager = new ExportConfigManager();
    const traceSummaryService = new TraceSummaryService(exportConfigManager);
    
    // Les 6 niveaux de détail à tester
    const detailLevels: DetailLevel[] = ['Full', 'NoTools', 'NoResults', 'Messages', 'Summary', 'UserOnly'];
    
    const results: { level: DetailLevel; success: boolean; error?: string; outputSize?: number }[] = [];
    
    for (const detailLevel of detailLevels) {
        console.log(`📊 Test du niveau "${detailLevel}"...`);
        
        try {
            // Test avec le nouveau système de stratégies
            const startTime = Date.now();
            
            // Créer un mock conversation (remplacer par une vraie conversation)
            const conversation = createMockConversation(taskId);
            
            const result = await traceSummaryService.generateSummary(conversation, {
                detailLevel,
                outputFormat: 'markdown',
                truncationChars: 0, // Pas de troncature pour les tests
                compactStats: false,
                includeCss: false,
                generateToc: true,
                enableDetailLevels: true // 🔥 Feature flag activé
            });
            
            const duration = Date.now() - startTime;
            const outputSize = result.content.length;
            
            // Sauvegarde du résultat pour inspection manuelle
            const outputPath = join(process.cwd(), `test-output-${detailLevel.toLowerCase()}.md`);
            await writeFile(outputPath, result.content, 'utf-8');
            
            console.log(`  ✅ Succès - ${outputSize.toLocaleString()} caractères (${duration}ms)`);
            console.log(`  📄 Sauvegardé: ${outputPath}\n`);
            
            results.push({ 
                level: detailLevel, 
                success: true, 
                outputSize 
            });
            
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.log(`  ❌ Erreur: ${errorMsg}\n`);
            
            results.push({ 
                level: detailLevel, 
                success: false, 
                error: errorMsg 
            });
        }
    }
    
    // Résumé des résultats
    console.log('\n🏆 RÉSUMÉ DES TESTS');
    console.log('==================');
    
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    
    console.log(`✅ Réussis: ${successful.length}/${results.length}`);
    console.log(`❌ Échoués: ${failed.length}/${results.length}\n`);
    
    // Détail des succès avec tailles
    if (successful.length > 0) {
        console.log('📊 Tailles de sortie par niveau:');
        successful.forEach(r => {
            const size = r.outputSize?.toLocaleString() || 'N/A';
            console.log(`  - ${r.level.padEnd(10)} : ${size} caractères`);
        });
        console.log('');
    }
    
    // Détail des échecs
    if (failed.length > 0) {
        console.log('❌ Détail des échecs:');
        failed.forEach(r => {
            console.log(`  - ${r.level}: ${r.error}`);
        });
        console.log('');
    }
    
    // Test de compatibilité - niveau Full avec ancien système vs nouveau système
    console.log('🔄 Test de Compatibilité (Niveau Full)');
    console.log('======================================');
    
    try {
        const conversation = createMockConversation(taskId);
        
        // Ancien système (feature flag désactivé)
        console.log('📊 Test ancien système...');
        const oldSystemResult = await traceSummaryService.generateSummary(conversation, {
            detailLevel: 'Full',
            outputFormat: 'markdown',
            truncationChars: 0,
            compactStats: false,
            includeCss: false,
            generateToc: true,
            enableDetailLevels: false // Feature flag désactivé
        });
        
        // Nouveau système (feature flag activé)
        console.log('📊 Test nouveau système...');
        const newSystemResult = await traceSummaryService.generateSummary(conversation, {
            detailLevel: 'Full',
            outputFormat: 'markdown',
            truncationChars: 0,
            compactStats: false,
            includeCss: false,
            generateToc: true,
            enableDetailLevels: true // Feature flag activé
        });
        
        const sizeDiff = Math.abs(oldSystemResult.content.length - newSystemResult.content.length);
        const percentDiff = (sizeDiff / oldSystemResult.content.length) * 100;
        
        console.log(`  Ancien système: ${oldSystemResult.content.length.toLocaleString()} caractères`);
        console.log(`  Nouveau système: ${newSystemResult.content.length.toLocaleString()} caractères`);
        console.log(`  Différence: ${sizeDiff.toLocaleString()} caractères (${percentDiff.toFixed(2)}%)`);
        
        if (percentDiff < 5) {
            console.log('  ✅ Compatibilité OK - Différence < 5%');
        } else {
            console.log('  ⚠️  Différence significative détectée');
        }
        
        // Sauvegarde pour comparaison manuelle
        await writeFile('test-output-full-legacy.md', oldSystemResult.content, 'utf-8');
        await writeFile('test-output-full-strategy.md', newSystemResult.content, 'utf-8');
        console.log('  📄 Fichiers de comparaison sauvegardés\n');
        
    } catch (error) {
        console.log(`  ❌ Erreur test compatibilité: ${error}\n`);
    }
    
    return { successful: successful.length, total: results.length };
}

/**
 * Point d'entrée principal
 */
async function main() {
    const taskId = process.argv[2];
    
    if (!taskId) {
        console.error('❌ Usage: node test-detail-levels.js <taskId>');
        console.error('   Exemple: node test-detail-levels.js aug-4-2025_12-42-53-pm');
        process.exit(1);
    }
    
    console.log(`🎯 Test sur la tâche: ${taskId}\n`);
    
    try {
        const results = await testDetailLevels(taskId);
        
        if (results.successful === results.total) {
            console.log('🎉 TOUS LES TESTS RÉUSSIS !');
            process.exit(0);
        } else {
            console.log(`⚠️  ${results.total - results.successful} test(s) échoué(s)`);
            process.exit(1);
        }
        
    } catch (error) {
        console.error('💥 Erreur fatale:', error);
        process.exit(1);
    }
}

// Exécution si script appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export { testDetailLevels };