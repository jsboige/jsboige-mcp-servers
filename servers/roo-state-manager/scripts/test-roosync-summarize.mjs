#!/usr/bin/env node
/**
 * Script de test manuel pour roosync_summarize (CONS-12)
 *
 * Teste les 3 types : trace, cluster, synthesis
 */

import { handleRooSyncSummarize } from '../build/tools/summary/roosync-summarize.tool.js';

// Mock minimal pour ConversationSkeleton (pas besoin d'importer le type)
function createMockSkeleton(taskId) {
    return {
        taskId,
        messages: [],
        metadata: {
            taskId,
            startTime: new Date().toISOString(),
            conversationId: `conv-${taskId}`,
            title: `Test conversation ${taskId}`,
            summary: `Mock summary for ${taskId}`
        }
    };
}

// Mock getConversationSkeleton
async function mockGetConversationSkeleton(taskId) {
    console.log(`  [MOCK] getConversationSkeleton("${taskId}")`);
    return createMockSkeleton(taskId);
}

// Mock findChildTasks
async function mockFindChildTasks(rootTaskId) {
    console.log(`  [MOCK] findChildTasks("${rootTaskId}")`);
    return [
        createMockSkeleton(`${rootTaskId}-child1`),
        createMockSkeleton(`${rootTaskId}-child2`)
    ];
}

async function testRooSyncSummarize() {
    console.log('🧪 Test CONS-12 - roosync_summarize\n');
    console.log('=' .repeat(60));

    let passCount = 0;
    let failCount = 0;

    // Test 1: Type 'trace'
    console.log('\n[TEST 1] Type: trace');
    console.log('-'.repeat(60));
    try {
        const result = await handleRooSyncSummarize(
            {
                type: 'trace',
                taskId: 'test-trace-123',
                outputFormat: 'markdown',
                detailLevel: 'Summary'
            },
            mockGetConversationSkeleton
        );
        console.log('✅ PASS - Type trace OK');
        console.log(`  Résultat: ${typeof result} (${result.length} chars)`);
        passCount++;
    } catch (error) {
        console.log(`❌ FAIL - Type trace: ${error.message}`);
        failCount++;
    }

    // Test 2: Type 'cluster'
    console.log('\n[TEST 2] Type: cluster');
    console.log('-'.repeat(60));
    try {
        const result = await handleRooSyncSummarize(
            {
                type: 'cluster',
                taskId: 'test-cluster-456',
                outputFormat: 'markdown',
                detailLevel: 'Summary',
                clusterMode: 'aggregated'
            },
            mockGetConversationSkeleton,
            mockFindChildTasks
        );
        console.log('✅ PASS - Type cluster OK');
        console.log(`  Résultat: ${typeof result} (${result.length} chars)`);
        passCount++;
    } catch (error) {
        console.log(`❌ FAIL - Type cluster: ${error.message}`);
        failCount++;
    }

    // Test 3: Type 'synthesis'
    console.log('\n[TEST 3] Type: synthesis');
    console.log('-'.repeat(60));
    try {
        const result = await handleRooSyncSummarize(
            {
                type: 'synthesis',
                taskId: 'test-synthesis-789',
                outputFormat: 'json'
            },
            mockGetConversationSkeleton
        );
        console.log('✅ PASS - Type synthesis OK');
        console.log(`  Résultat: ${typeof result} (${result.length} chars)`);
        passCount++;
    } catch (error) {
        console.log(`❌ FAIL - Type synthesis: ${error.message}`);
        failCount++;
    }

    // Test 4: Validation - type manquant
    console.log('\n[TEST 4] Validation: type manquant');
    console.log('-'.repeat(60));
    try {
        await handleRooSyncSummarize(
            { taskId: 'test-123' },
            mockGetConversationSkeleton
        );
        console.log('❌ FAIL - Devrait rejeter si type manquant');
        failCount++;
    } catch (error) {
        if (error.message.includes('type est requis')) {
            console.log('✅ PASS - Validation type OK');
            passCount++;
        } else {
            console.log(`❌ FAIL - Mauvais message d'erreur: ${error.message}`);
            failCount++;
        }
    }

    // Test 5: Validation - taskId manquant
    console.log('\n[TEST 5] Validation: taskId manquant');
    console.log('-'.repeat(60));
    try {
        await handleRooSyncSummarize(
            { type: 'trace' },
            mockGetConversationSkeleton
        );
        console.log('❌ FAIL - Devrait rejeter si taskId manquant');
        failCount++;
    } catch (error) {
        if (error.message.includes('taskId est requis')) {
            console.log('✅ PASS - Validation taskId OK');
            passCount++;
        } else {
            console.log(`❌ FAIL - Mauvais message d'erreur: ${error.message}`);
            failCount++;
        }
    }

    // Test 6: Validation - type invalide
    console.log('\n[TEST 6] Validation: type invalide');
    console.log('-'.repeat(60));
    try {
        await handleRooSyncSummarize(
            { type: 'invalid', taskId: 'test-123' },
            mockGetConversationSkeleton
        );
        console.log('❌ FAIL - Devrait rejeter si type invalide');
        failCount++;
    } catch (error) {
        if (error.message.includes('Type d\'opération non supporté')) {
            console.log('✅ PASS - Validation type invalide OK');
            passCount++;
        } else {
            console.log(`❌ FAIL - Mauvais message d'erreur: ${error.message}`);
            failCount++;
        }
    }

    // Résumé
    console.log('\n' + '='.repeat(60));
    console.log(`\n📊 Résultat: ${passCount}/${passCount + failCount} tests passent (${Math.round(passCount / (passCount + failCount) * 100)}%)`);
    console.log(`✅ Pass: ${passCount}`);
    console.log(`❌ Fail: ${failCount}`);

    if (failCount === 0) {
        console.log('\n🎉 Tous les tests passent ! CONS-12 validé.');
        process.exit(0);
    } else {
        console.log('\n⚠️ Certains tests échouent.');
        process.exit(1);
    }
}

// Exécuter les tests
testRooSyncSummarize().catch(error => {
    console.error('❌ Erreur fatale:', error);
    process.exit(1);
});
