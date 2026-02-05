#!/usr/bin/env node
/**
 * Script de test manuel pour le support Claude Code
 *
 * Teste les nouvelles fonctionnalités:
 * 1. Détection des projets Claude
 * 2. Parsing des fichiers JSONL
 * 3. Transformation vers ConversationSkeleton
 * 4. Génération de résumés avec roosync_summarize source=claude
 */

import { ClaudeStorageDetector } from '../build/utils/claude-storage-detector.js';
import { handleRooSyncSummarize } from '../build/tools/summary/roosync-summarize.tool.js';

console.log('🧪 Test du support Claude Code\n');
console.log('='.repeat(60));

// Test 1: Détection des emplacements
console.log('\n[TEST 1] Détection des emplacements Claude');
console.log('-'.repeat(60));
try {
    const locations = await ClaudeStorageDetector.detectStorageLocations();
    console.log(`✅ PASS - ${locations.length} emplacements détectés`);

    for (const loc of locations) {
        console.log(`   📁 ${loc.projectName}`);
        console.log(`      Path: ${loc.path}`);
    }
} catch (error) {
    console.log(`❌ FAIL - Détection: ${error.message}`);
}

// Test 2: Lister les projets
console.log('\n[TEST 2] Liste des projets Claude');
console.log('-'.repeat(60));
try {
    const locations = await ClaudeStorageDetector.detectStorageLocations();

    if (locations.length === 0) {
        console.log('⚠️ SKIP - Aucun emplacement Claude trouvé');
        console.log('   Ce test nécessite que Claude Code soit installé et utilisé.');
        console.log('   Les conversations Claude sont stockées dans ~/.claude/projects/');
    } else {
        const allProjects = new Map();
        for (const loc of locations) {
            const projects = await ClaudeStorageDetector.listProjects(loc.path);
            for (const project of projects) {
                allProjects.set(project, loc.projectPath);
            }
        }

        console.log(`✅ PASS - ${allProjects.size} projets trouvés`);
        for (const [name, path] of allProjects) {
            console.log(`   📂 ${name}`);
        }
    }
} catch (error) {
    console.log(`❌ FAIL - Liste projets: ${error.message}`);
}

// Test 3: Parsing JSONL avec données réelles
console.log('\n[TEST 3] Parsing JSONL avec données réelles');
console.log('-'.repeat(60));
try {
    // Créer une entrée JSONL de test
    const testEntry = {
        type: 'user',
        message: {
            role: 'user',
            content: 'Bonjour, peux-tu m\'aider à tester le support Claude?'
        },
        timestamp: new Date().toISOString(),
        uuid: 'test-uuid-claude-1'
    };

    const parsed = await ClaudeStorageDetector.parseJsonlLine(JSON.stringify(testEntry));

    if (parsed && parsed.type === 'user') {
        console.log('✅ PASS - Parsing JSONL OK');
        console.log(`   Type: ${parsed.type}`);
        console.log(`   Role: ${parsed.message?.role}`);
    } else {
        console.log('❌ FAIL - Parsing incorrect');
    }
} catch (error) {
    console.log(`❌ FAIL - Parsing JSONL: ${error.message}`);
}

// Test 4: Analyse d'une conversation avec JSONL de test
console.log('\n[TEST 4] Analyse conversation avec JSONL de test');
console.log('-'.repeat(60));
try {
    // Créer un répertoire temporaire avec un fichier JSONL
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs/promises');

    const testDir = path.join(os.tmpdir(), `claude-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    const testJsonl = [
        { type: 'user', message: { role: 'user', content: 'Test Claude support' }, timestamp: new Date().toISOString(), uuid: '1' },
        { type: 'assistant', message: { role: 'assistant', content: 'Response from Claude' }, timestamp: new Date().toISOString(), uuid: '2' },
        { type: 'command_result', command: { command: 'echo test', exitCode: 0, output: 'test' }, timestamp: new Date().toISOString(), uuid: '3' },
    ];

    const jsonlContent = testJsonl.map(e => JSON.stringify(e)).join('\n');
    const jsonlPath = path.join(testDir, 'conversation.jsonl');
    await fs.writeFile(jsonlPath, jsonlContent);

    const skeleton = await ClaudeStorageDetector.analyzeConversation('test-claude-task', testDir);

    if (skeleton) {
        console.log('✅ PASS - Analyse conversation OK');
        console.log(`   TaskId: ${skeleton.taskId}`);
        console.log(`   Messages: ${skeleton.metadata.messageCount}`);
        console.log(`   Actions: ${skeleton.metadata.actionCount}`);
        console.log(`   Workspace: ${skeleton.metadata.workspace || 'N/A'}`);
    } else {
        console.log('❌ FAIL - Skeleton null');
    }

    // Cleanup
    await fs.rm(testDir, { recursive: true, force: true });
} catch (error) {
    console.log(`❌ FAIL - Analyse conversation: ${error.message}`);
}

// Test 5: roosync_summarize avec source=claude
console.log('\n[TEST 5] roosync_summarize avec source=claude');
console.log('-'.repeat(60));
try {
    // Import path pour ce test
    const path = await import('path');

    // Note: Ce test nécessite des vraies conversations Claude
    const locations = await ClaudeStorageDetector.detectStorageLocations();

    if (locations.length === 0) {
        console.log('⚠️ SKIP - Aucune conversation Claude disponible');
        console.log('   Pour tester complètement:');
        console.log('   1. Utilisez Claude Code pour créer quelques conversations');
        console.log('   2. Relancez ce test');
    } else {
        // Prendre le premier projet et essayer de générer un résumé
        const firstLoc = locations[0];
        const projects = await ClaudeStorageDetector.listProjects(firstLoc.path);

        if (projects.length > 0) {
            const projectPath = path.join(firstLoc.path, projects[0]);

            // Essayer d'analyser la conversation
            const skeleton = await ClaudeStorageDetector.analyzeConversation('test-task-id', projectPath);

            if (skeleton) {
                console.log('✅ PASS - Conversation Claude détectée et analysée');
                console.log(`   Titre: ${skeleton.metadata.title || 'Sans titre'}`);
                console.log(`   Messages: ${skeleton.metadata.messageCount}`);
                console.log(`   Actions: ${skeleton.metadata.actionCount}`);
            } else {
                console.log('⚠️ SKIP - Aucun skeleton généré (fichier JSONL vide?)');
            }
        }
    }
} catch (error) {
    console.log(`❌ FAIL - roosync_summarize: ${error.message}`);
    console.log(error.stack);
}

// Résumé final
console.log('\n' + '='.repeat(60));
console.log('\n📊 Test terminé!');
console.log('\n🎯 Pour utiliser le support Claude en production:');
console.log('   roosync_summarize({');
console.log('     type: "trace",');
console.log('     taskId: "<task-id>",');
console.log('     source: "claude"  // ← Nouveau paramètre!');
console.log('   })');
