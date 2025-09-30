#!/usr/bin/env node

/**
 * Script de test pour valider la correction du regex escapedNewTaskPattern
 * Teste la fonction extractFromMessageFile sur les fixtures de hiérarchie contrôlée
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Pour obtenir __dirname dans ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import de la fonction corrigée (compilée)
import { RooStorageDetector } from './build/src/utils/roo-storage-detector.js';

async function testRegexCorrection() {
    console.log('🧪 TEST CORRECTION REGEX escapedNewTaskPattern');
    console.log('=============================================\n');

    const fixturesPath = './tests/fixtures/controlled-hierarchy';
    const testTaskId = '38948ef0-4a8b-40a2-ae29-b38d2aa9d5a7'; // TEST-NODE-B1
    const uiMessagesPath = path.join(fixturesPath, testTaskId, 'ui_messages.json');

    try {
        // Lire le fichier ui_messages.json du TEST-NODE-B1
        console.log(`📁 Test sur: ${uiMessagesPath}`);
        const exists = await fs.access(uiMessagesPath).then(() => true).catch(() => false);
        if (!exists) {
            console.error(`❌ Fichier non trouvé: ${uiMessagesPath}`);
            return;
        }

        // Lire le contenu du fichier
        const content = await fs.readFile(uiMessagesPath, 'utf-8');
        console.log(`📏 Taille du fichier: ${content.length} chars`);

        // Tester le parsing JSON
        let messages;
        try {
            messages = JSON.parse(content);
            console.log(`📋 Nombre de messages: ${messages.length}`);
        } catch (error) {
            console.error(`❌ Erreur parsing JSON: ${error.message}`);
            return;
        }

        // Compter les appels newTask dans le contenu brut
        const newTaskMatches = content.match(/"tool":"newTask"/g);
        console.log(`🎯 Appels newTask trouvés dans le contenu: ${newTaskMatches ? newTaskMatches.length : 0}`);

        // Tester le regex corrigé manuellement
        console.log('\n🔍 TEST REGEX CORRIGÉ MANUELLEMENT:');
        const escapedNewTaskPattern = /"text":"(\{\\\"tool\\\":\\\"newTask\\\",\\\"mode\\\":\\\"([^\\\"]+)\\\",\\\"content\\\":\\\"([\\s\\S]*?)\\\",\\\"todos\\\":\\\[\\\]\})"/g;
        let match;
        let matchCount = 0;
        
        while ((match = escapedNewTaskPattern.exec(content)) !== null) {
            matchCount++;
            const mode = match[2];
            const contentPreview = match[3].substring(0, 100);
            console.log(`  ✅ Match ${matchCount}: mode="${mode}", contenu="${contentPreview}..."`);
        }
        
        console.log(`📊 Total matches regex: ${matchCount}`);

        // Test avec la fonction extractFromMessageFile via réflexion
        console.log('\n🧪 TEST FONCTION extractFromMessageFile:');
        const instructions = [];
        
        // Utiliser la méthode privée via réflexion (si possible)
        try {
            await RooStorageDetector.extractFromMessageFile(uiMessagesPath, instructions, 1000);
            
            const newTaskInstructions = instructions.filter(inst => 
                inst.mode !== 'task' && inst.mode !== 'legacy'
            );
            
            console.log(`📋 Instructions totales extraites: ${instructions.length}`);
            console.log(`🎯 Instructions newTask extraites: ${newTaskInstructions.length}`);
            
            newTaskInstructions.forEach((inst, i) => {
                console.log(`  ✅ Instruction ${i + 1}: mode="${inst.mode}", message="${inst.message.substring(0, 100)}..."`);
            });
            
        } catch (error) {
            console.error(`❌ Erreur extractFromMessageFile: ${error.message}`);
        }

        console.log('\n🎉 TEST TERMINÉ');

    } catch (error) {
        console.error('❌ Erreur générale:', error);
    }
}

// Exécuter le test
testRegexCorrection().catch(console.error);