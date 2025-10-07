/**
 * Script de diagnostic manuel pour l'extraction PATTERN 5
 * 
 * OBJECTIF SDDD: Parser manuellement ui_messages.json réels pour diagnostiquer
 * pourquoi 0 instructions newTask sont extraites sur 37 tâches du workspace
 * 
 * Usage: node scripts/test-pattern-extraction.mjs
 */

import { readFile, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 🎯 PATTERN 5: Format api_req_started production
const API_REQ_PATTERN = /\[new_task in ([^:]+):\s*['"](.+?)['"]\]/gs;

/**
 * Analyse un fichier ui_messages.json pour PATTERN 5
 */
async function analyzeUIMessages(filePath, taskId) {
    console.log(`\n🔍 Analyse PATTERN 5 pour: ${taskId}`);
    
    try {
        const content = await readFile(filePath, 'utf-8');
        const messages = JSON.parse(content);
        
        let totalMessages = messages.length;
        let apiMessages = 0;
        let patternMatches = 0;
        let extractedInstructions = [];
        
        console.log(`📊 Total messages: ${totalMessages}`);
        
        // Parcourir tous les messages
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            
            // PATTERN 5: say/api_req_started avec JSON dans text
            if (message.type === 'say' && 
                message.say === 'api_req_started' && 
                typeof message.text === 'string') {
                
                apiMessages++;
                console.log(`📝 Message API ${apiMessages} trouvé (index ${i})`);
                
                try {
                    // Parser le JSON dans message.text
                    const apiData = JSON.parse(message.text);
                    
                    if (apiData && typeof apiData.request === 'string') {
                        console.log(`   📄 Request length: ${apiData.request.length} chars`);
                        console.log(`   📄 Request preview: ${apiData.request.substring(0, 150)}...`);
                        
                        // Appliquer le pattern PATTERN 5
                        const matches = [...apiData.request.matchAll(API_REQ_PATTERN)];
                        
                        if (matches.length > 0) {
                            console.log(`   ✅ PATTERN 5 matches: ${matches.length}`);
                            
                            for (const match of matches) {
                                const modeWithIcon = match[1].trim();
                                const taskMessage = match[2].trim();
                                
                                // Extraire le mode sans emoji
                                const modeMatch = modeWithIcon.match(/([A-Za-z]+)\s*mode/i);
                                const cleanMode = modeMatch ? modeMatch[1].trim().toLowerCase() : 'task';
                                
                                if (taskMessage.length > 10) {
                                    patternMatches++;
                                    const instruction = {
                                        timestamp: message.timestamp || message.ts || 0,
                                        mode: cleanMode,
                                        message: taskMessage,
                                        source: 'api_req_started',
                                        messageIndex: i
                                    };
                                    extractedInstructions.push(instruction);
                                    
                                    console.log(`      🎯 Mode: "${modeWithIcon}" -> "${cleanMode}"`);
                                    console.log(`      📝 Message: ${taskMessage.substring(0, 100)}...`);
                                }
                            }
                        } else {
                            console.log(`   ❌ Aucun match PATTERN 5 dans ce request`);
                            // Diagnostic: chercher des patterns similaires
                            const similarPatterns = [
                                /new_task/gi,
                                /\[new_task/gi,
                                /mode:/gi
                            ];
                            
                            for (const pattern of similarPatterns) {
                                const partialMatches = apiData.request.match(pattern);
                                if (partialMatches) {
                                    console.log(`   🔍 Partial match "${pattern}": ${partialMatches.length} occurrences`);
                                }
                            }
                        }
                    } else {
                        console.log(`   ⚠️ JSON structure invalide (pas de champ request)`);
                    }
                    
                } catch (jsonError) {
                    console.log(`   ❌ Parsing JSON échoué:`, jsonError.message);
                    console.log(`   📄 Text brut: ${message.text.substring(0, 200)}...`);
                }
            }
        }
        
        // Résumé pour cette tâche
        console.log(`\n📋 RÉSUMÉ ${taskId}:`);
        console.log(`   Messages total: ${totalMessages}`);
        console.log(`   Messages api_req_started: ${apiMessages}`);
        console.log(`   Patterns PATTERN 5 trouvés: ${patternMatches}`);
        console.log(`   Instructions extraites: ${extractedInstructions.length}`);
        
        if (extractedInstructions.length > 0) {
            console.log(`   🎯 Modes extraits: ${extractedInstructions.map(i => i.mode).join(', ')}`);
        }
        
        return {
            taskId,
            totalMessages,
            apiMessages,
            patternMatches,
            extractedInstructions,
            success: true
        };
        
    } catch (error) {
        console.error(`❌ Erreur analyse ${taskId}:`, error.message);
        return {
            taskId,
            success: false,
            error: error.message
        };
    }
}

/**
 * Test sur les fixtures réelles
 */
async function testWithRealFixtures() {
    console.log('🚀 DIAGNOSTIC PATTERN 5 - Fixtures réelles\n');
    
    const fixturesPath = join(__dirname, '..', 'tests', 'fixtures', 'real-tasks');
    
    // Tâches de test connues
    const testTasks = [
        'ac8aa7b4-319c-4925-a139-4f4adca81921',
        'bc93a6f7-cd2e-4686-a832-46e3cd14d338'
    ];
    
    const results = [];
    
    for (const taskId of testTasks) {
        const taskPath = join(fixturesPath, taskId);
        const uiMessagesPath = join(taskPath, 'ui_messages.json');
        
        try {
            await access(uiMessagesPath);
            const result = await analyzeUIMessages(uiMessagesPath, taskId);
            results.push(result);
        } catch (error) {
            console.warn(`⚠️ Fixture manquante: ${taskId}`);
            results.push({
                taskId,
                success: false,
                error: 'Fixture non trouvée'
            });
        }
    }
    
    // Rapport global
    console.log('\n📊 RAPPORT GLOBAL DIAGNOSTIC');
    console.log('=' .repeat(50));
    
    const successful = results.filter(r => r.success);
    const withInstructions = successful.filter(r => r.extractedInstructions && r.extractedInstructions.length > 0);
    
    console.log(`Tâches analysées: ${results.length}`);
    console.log(`Analyses réussies: ${successful.length}`);
    console.log(`Avec instructions extraites: ${withInstructions.length}`);
    
    if (successful.length > 0) {
        const totalMessages = successful.reduce((sum, r) => sum + (r.totalMessages || 0), 0);
        const totalApiMessages = successful.reduce((sum, r) => sum + (r.apiMessages || 0), 0);
        const totalPatterns = successful.reduce((sum, r) => sum + (r.patternMatches || 0), 0);
        const totalInstructions = successful.reduce((sum, r) => sum + (r.extractedInstructions?.length || 0), 0);
        
        console.log(`\nMoyennes:`);
        console.log(`  Messages/tâche: ${(totalMessages / successful.length).toFixed(1)}`);
        console.log(`  API messages/tâche: ${(totalApiMessages / successful.length).toFixed(1)}`);
        console.log(`  Patterns/tâche: ${(totalPatterns / successful.length).toFixed(1)}`);
        console.log(`  Instructions/tâche: ${(totalInstructions / successful.length).toFixed(1)}`);
        
        console.log(`\nTaux d'extraction:`);
        console.log(`  Messages avec API req: ${totalApiMessages > 0 ? ((totalPatterns / totalApiMessages) * 100).toFixed(1) : 0}%`);
        console.log(`  Succès global: ${totalInstructions > 0 ? '✅ PATTERN 5 FONCTIONNE' : '❌ PATTERN 5 DÉFAILLANT'}`);
    }
    
    // Diagnostics recommandés
    console.log('\n🔧 RECOMMANDATIONS:');
    
    if (withInstructions.length === 0) {
        console.log('❌ PROBLÈME: Aucune instruction extraite');
        console.log('   1. Vérifier le format des messages api_req_started');
        console.log('   2. Ajuster la regex PATTERN 5');
        console.log('   3. Examiner les logs détaillés ci-dessus');
    } else if (withInstructions.length < successful.length) {
        console.log('⚠️ PARTIEL: Extraction incomplète');
        console.log('   1. Optimiser la détection des cas limites');
        console.log('   2. Améliorer la robustesse du parsing JSON');
    } else {
        console.log('✅ SUCCÈS: PATTERN 5 fonctionne correctement');
        console.log('   Le problème des "0 instructions" vient probablement du filtrage workspace');
    }
}

/**
 * Test avec des exemples synthétiques pour validation
 */
async function testWithSyntheticData() {
    console.log('\n🧪 TEST PATTERN 5 - Données synthétiques');
    console.log('=' .repeat(40));
    
    const testCases = [
        {
            name: 'Format standard',
            message: {
                type: 'say',
                say: 'api_req_started',
                text: JSON.stringify({
                    request: '[new_task in 🪲 Debug mode: \'Corriger le système hiérarchie\']'
                }),
                timestamp: Date.now()
            }
        },
        {
            name: 'Format guillemets doubles',
            message: {
                type: 'say',
                say: 'api_req_started',
                text: JSON.stringify({
                    request: '[new_task in Code mode: "Implémenter nouvelle feature"]'
                }),
                timestamp: Date.now()
            }
        },
        {
            name: 'Format multiligne',
            message: {
                type: 'say',
                say: 'api_req_started',
                text: JSON.stringify({
                    request: '[new_task in Architect mode: "Conception système\nAvec détails techniques multiples"]'
                }),
                timestamp: Date.now()
            }
        }
    ];
    
    for (const testCase of testCases) {
        console.log(`\n🧪 Test: ${testCase.name}`);
        
        const message = testCase.message;
        if (message.type === 'say' && 
            message.say === 'api_req_started' && 
            typeof message.text === 'string') {
            
            try {
                const apiData = JSON.parse(message.text);
                if (apiData && typeof apiData.request === 'string') {
                    const matches = [...apiData.request.matchAll(API_REQ_PATTERN)];
                    
                    if (matches.length > 0) {
                        for (const match of matches) {
                            const modeWithIcon = match[1].trim();
                            const taskMessage = match[2].trim();
                            
                            const modeMatch = modeWithIcon.match(/([A-Za-z]+)\s*mode/i);
                            const cleanMode = modeMatch ? modeMatch[1].trim().toLowerCase() : 'task';
                            
                            console.log(`   ✅ Mode: "${cleanMode}"`);
                            console.log(`   📝 Message: "${taskMessage}"`);
                            console.log(`   📏 Longueur: ${taskMessage.length} chars`);
                        }
                    } else {
                        console.log(`   ❌ Aucun match pour: "${apiData.request}"`);
                    }
                }
            } catch (e) {
                console.log(`   ❌ Parsing JSON échoué: ${e.message}`);
            }
        }
    }
}

// Exécution principale
async function main() {
    console.log('🎯 SCRIPT DIAGNOSTIC PATTERN 5');
    console.log('Validation extraction newTask format production api_req_started');
    console.log('=' .repeat(60));
    
    // Test 1: Données synthétiques pour validation de la regex
    await testWithSyntheticData();
    
    // Test 2: Fixtures réelles pour diagnostic du problème
    await testWithRealFixtures();
    
    console.log('\n✅ Diagnostic PATTERN 5 terminé');
}

// Exécution si appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}