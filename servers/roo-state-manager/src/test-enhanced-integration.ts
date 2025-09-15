/**
 * Test d'intégration pour l'architecture améliorée d'export Markdown
 * 
 * Ce test valide le bon fonctionnement de l'EnhancedTraceSummaryService
 * avec différents niveaux de feature flags
 */

import { EnhancedTraceSummaryService } from './services/EnhancedTraceSummaryService.js';
import { ExportConfigManager } from './services/ExportConfigManager.js';

// Mock data pour les tests
const mockConversation = {
    taskId: 'test-task-123',
    metadata: {
        title: 'Test de l\'Architecture Améliorée',
        createdAt: '2025-01-15T10:00:00Z',
        lastActivity: '2025-01-15T10:30:00Z',
        mode: 'code',
        messageCount: 4,
        actionCount: 1,
        totalSize: 1024,
        workspace: 'test-workspace'
    },
    sequence: [
        {
            role: 'user' as const,
            content: 'Peux-tu créer un fichier de test ?',
            timestamp: '2025-01-15T10:00:00Z',
            isTruncated: false
        },
        {
            role: 'assistant' as const,
            content: 'Je vais créer le fichier test.js pour vous.',
            timestamp: '2025-01-15T10:00:30Z',
            isTruncated: false,
            actions: [{
                toolName: 'write_to_file',
                toolInput: { path: 'test.js', content: 'console.log("Hello World");' },
                toolResult: { success: true, path: 'test.js' }
            }]
        },
        {
            role: 'user' as const,
            content: 'Parfait, le fichier a été créé avec succès.',
            timestamp: '2025-01-15T10:01:00Z',
            isTruncated: false
        },
        {
            role: 'assistant' as const,
            content: 'Excellent ! Le fichier test.js a été créé avec succès.',
            timestamp: '2025-01-15T10:01:30Z',
            isTruncated: false
        }
    ]
};

/**
 * Fonction principale de test
 */
async function testEnhancedArchitecture(): Promise<void> {
    console.log('🚀 Test d\'Intégration de l\'Architecture Améliorée\n');
    
    // Initialiser le service avec config par défaut
    const configManager = new ExportConfigManager();
    const enhancedService = new EnhancedTraceSummaryService(configManager);

    try {
        // Test 1: Mode Legacy (toutes les améliorations désactivées)
        console.log('📝 Test 1: Mode Legacy');
        enhancedService.disableAllEnhancements();
        const legacyResult = await enhancedService.generateSummary(mockConversation, {
            detailLevel: 'Full'
        });
        console.log(`   ✅ Legacy mode: ${legacyResult.success ? 'SUCCESS' : 'FAILED'}`);
        console.log(`   📊 Stats: ${legacyResult.statistics.totalSections} sections\n`);
        
        // Test 2: Mode Enhanced complet
        console.log('📝 Test 2: Mode Enhanced Complet');
        enhancedService.enableAllEnhancements();
        const enhancedResult = await enhancedService.generateSummary(mockConversation, {
            detailLevel: 'Full',
            enhancementFlags: {
                useEnhancedClassification: true,
                useStrategyFiltering: true,
                useSmartCleaning: true,
                useAdvancedRendering: true,
                preserveLegacyBehavior: true
            }
        });
        console.log(`   ✅ Enhanced mode: ${enhancedResult.success ? 'SUCCESS' : 'FAILED'}`);
        console.log(`   📊 Stats: ${enhancedResult.statistics.totalSections} sections\n`);
        
        // Test 3: Activation progressive
        console.log('📝 Test 3: Activation Progressive');
        enhancedService.disableAllEnhancements();
        enhancedService.enableEnhancement('useEnhancedClassification');
        const progressiveResult = await enhancedService.generateSummary(mockConversation, {
            detailLevel: 'Messages'
        });
        console.log(`   ✅ Progressive mode: ${progressiveResult.success ? 'SUCCESS' : 'FAILED'}`);
        console.log(`   📊 Stats: ${progressiveResult.statistics.totalSections} sections\n`);
        
        // Afficher l'état des feature flags
        console.log('🏁 État des Feature Flags:');
        const currentFlags = enhancedService.getCurrentEnhancementFlags();
        Object.entries(currentFlags).forEach(([key, value]) => {
            console.log(`   ${key}: ${value ? '✅' : '❌'}`);
        });
        
        console.log('\n🎉 Tests d\'intégration terminés avec succès !');
        
    } catch (error) {
        console.error('❌ Erreur lors des tests:', error);
        throw error;
    }
}

// Exporter pour utilisation externe
export { testEnhancedArchitecture, mockConversation };

// Exécuter le test si lancé directement
if (require.main === module) {
    testEnhancedArchitecture().catch(console.error);
}