#!/usr/bin/env node
/**
 * Script pour analyser le format exact des messages api_req_started
 * dans les vraies tâches et comprendre comment extraire les instructions newTask
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function main() {
    console.log('🔍 ANALYSE: Format des messages api_req_started\n');
    
    // Chemin vers les fixtures réelles
    const fixturesDir = path.join(__dirname, '../tests/fixtures/real-tasks');
    
    if (!fs.existsSync(fixturesDir)) {
        console.error('❌ Répertoire fixtures introuvable:', fixturesDir);
        return;
    }
    
    const taskDirs = fs.readdirSync(fixturesDir).filter(name => {
        const fullPath = path.join(fixturesDir, name);
        return fs.statSync(fullPath).isDirectory();
    });
    
    console.log(`📁 Analyse de ${taskDirs.length} tâches réelles\n`);
    console.log('='.repeat(80));
    
    let totalApiReqStarted = 0;
    let totalWithNewTask = 0;
    let examplesShown = 0;
    const maxExamples = 3;
    
    for (const taskId of taskDirs) {
        const uiMessagesPath = path.join(fixturesDir, taskId, 'ui_messages.json');
        
        if (!fs.existsSync(uiMessagesPath)) {
            continue;
        }
        
        const content = fs.readFileSync(uiMessagesPath, 'utf-8');
        const messages = JSON.parse(content);
        
        // Filtrer les messages api_req_started
        const apiReqMessages = messages.filter(msg => 
            msg.type === 'say' && msg.say === 'api_req_started'
        );
        
        totalApiReqStarted += apiReqMessages.length;
        
        for (const msg of apiReqMessages) {
            // Analyser le champ text
            if (typeof msg.text === 'string') {
                // Vérifier si c'est du JSON
                let isJson = false;
                let parsedText = null;
                
                try {
                    parsedText = JSON.parse(msg.text);
                    isJson = true;
                } catch (e) {
                    // Pas du JSON, peut-être du texte brut
                }
                
                // Chercher le pattern new_task
                const hasNewTask = msg.text.includes('[new_task in');
                
                if (hasNewTask) {
                    totalWithNewTask++;
                    
                    if (examplesShown < maxExamples) {
                        console.log(`\n📋 Exemple ${examplesShown + 1} - Task: ${taskId.substring(0, 8)}`);
                        console.log('-'.repeat(80));
                        console.log(`Is JSON: ${isJson}`);
                        console.log(`Text length: ${msg.text.length}`);
                        
                        if (isJson && parsedText) {
                            console.log('\n✅ Structure JSON détectée:');
                            console.log('Fields:', Object.keys(parsedText).join(', '));
                            
                            if (parsedText.request) {
                                console.log('\n📝 Champ "request":');
                                const requestPreview = parsedText.request.substring(0, 300);
                                console.log(requestPreview);
                                if (parsedText.request.length > 300) {
                                    console.log(`... (${parsedText.request.length - 300} chars restants)`);
                                }
                                
                                // Chercher le pattern new_task dans request
                                const newTaskMatch = parsedText.request.match(/\[new_task in ([^\]]+) mode: '([^']+)'\]/);
                                if (newTaskMatch) {
                                    console.log('\n🎯 Pattern new_task trouvé:');
                                    console.log(`  Mode: ${newTaskMatch[1]}`);
                                    console.log(`  Message (début): ${newTaskMatch[2].substring(0, 100)}...`);
                                }
                            }
                        } else {
                            console.log('\n⚠️  Texte brut (non-JSON):');
                            console.log(msg.text.substring(0, 200));
                        }
                        
                        examplesShown++;
                    }
                }
            }
        }
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('\n📊 STATISTIQUES:');
    console.log(`Total messages api_req_started: ${totalApiReqStarted}`);
    console.log(`Messages avec pattern [new_task in: ${totalWithNewTask}`);
    console.log(`Ratio: ${totalApiReqStarted > 0 ? ((totalWithNewTask / totalApiReqStarted) * 100).toFixed(1) : 0}%`);
    
    console.log('\n💡 RECOMMANDATION:');
    if (totalWithNewTask > 0) {
        console.log('Le pattern existe dans les données réelles.');
        console.log('Le parsing doit:');
        console.log('1. Détecter si msg.text est du JSON');
        console.log('2. Si oui, parser et extraire le champ "request"');
        console.log('3. Chercher le pattern [new_task in X mode: \'Y\'] dans "request"');
    } else {
        console.log('Aucun pattern [new_task in trouvé dans les fixtures réelles.');
        console.log('Vérifier si les fixtures sont à jour ou si le format a changé.');
    }
}

main();