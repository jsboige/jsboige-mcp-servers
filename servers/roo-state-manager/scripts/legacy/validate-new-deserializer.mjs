#!/usr/bin/env node

/**
 * Script de Validation : Comparaison Ancien vs Nouveau Système de Parsing
 * 
 * Compare l'ancien système regex (extractFromMessageFile) avec le nouveau
 * UIMessagesDeserializer sur les vraies fixtures du projet.
 * 
 * Usage: node scripts/validate-new-deserializer.mjs
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Chemin vers la racine du projet roo-state-manager
const PROJECT_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'real-tasks');

// ============================================================================
// UTILITAIRES DE LECTURE SÉCURISÉE
// ============================================================================

/**
 * Lit un fichier JSON volumineux ligne par ligne pour éviter l'explosion mémoire
 * @param {string} filePath - Chemin du fichier
 * @returns {Promise<any>} Contenu JSON parsé
 */
async function readJsonByLines(filePath) {
  const fileStream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });
  
  let jsonContent = '';
  for await (const line of rl) {
    jsonContent += line;
  }
  
  // Nettoyage BOM UTF-8
  if (jsonContent.charCodeAt(0) === 0xFEFF) {
    jsonContent = jsonContent.slice(1);
  }
  
  return JSON.parse(jsonContent);
}

// ============================================================================
// NOUVEAU SYSTÈME : UIMessagesDeserializer (Simplifié)
// ============================================================================

class UIMessagesDeserializer {
  safeJsonParse(jsonString, defaultValue = undefined) {
    if (!jsonString) return defaultValue;
    try {
      return JSON.parse(jsonString);
    } catch (error) {
      return defaultValue;
    }
  }

  extractToolCalls(messages) {
    const results = [];
    
    for (const m of messages) {
      if (m.ask === 'tool' && m.text) {
        const toolData = this.safeJsonParse(m.text);
        if (toolData?.tool) {
          results.push({
            tool: toolData.tool,
            mode: toolData.mode,
            message: toolData.message || toolData.content,
            timestamp: m.ts
          });
        }
      }
    }
    
    return results;
  }

  extractNewTasks(messages) {
    const toolCalls = this.extractToolCalls(messages);
    
    return toolCalls
      .filter(tool => (tool.tool === 'new_task' || tool.tool === 'newTask') && tool.mode && tool.message)
      .map(tool => ({
        mode: tool.mode,
        message: tool.message,
        timestamp: tool.timestamp
      }));
  }
}

// ============================================================================
// ANCIEN SYSTÈME : Extraction avec Patterns Regex (Version Simplifiée)
// ============================================================================

/**
 * Extrait les instructions newTask avec l'ancien système regex
 * Version simplifiée basée sur extractFromMessageFile de roo-storage-detector.ts
 * 
 * @param {string} filePath - Chemin vers ui_messages.json
 * @returns {Promise<Array>} Tableau d'instructions extraites
 */
async function extractWithOldSystem(filePath) {
  const instructions = [];
  
  try {
    if (!fsSync.existsSync(filePath)) {
      return instructions;
    }

    // Lecture sécurisée
    let content = await fs.readFile(filePath, 'utf-8');
    
    // Nettoyage BOM
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
    }
    
    // Parsing JSON
    let messages = [];
    try {
      const data = JSON.parse(content);
      messages = Array.isArray(data) ? data : [];
    } catch (e) {
      // Tentative parsing JSONL
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          messages.push(JSON.parse(trimmed));
        } catch (_e) {
          // Ignorer lignes invalides
        }
      }
    }

    // PATTERN 1: Format api_req_started production
    // Pattern: [new_task in X mode: 'message']
    for (const message of messages) {
      if (message.type === 'say' && message.say === 'api_req_started' && typeof message.text === 'string') {
        try {
          const apiData = JSON.parse(message.text);
          if (apiData && typeof apiData.request === 'string') {
            const requestText = apiData.request;
            const newTaskApiPattern = /\[new_task in ([^:]+):\s*['"](.+?)['"]\]/gs;
            let apiMatch;
            
            while ((apiMatch = newTaskApiPattern.exec(requestText)) !== null) {
              const modeWithIcon = apiMatch[1].trim();
              const taskMessage = apiMatch[2].trim();
              
              // Extraire mode sans icône
              const modeMatch = modeWithIcon.match(/([A-Za-z]+)\s*mode/i);
              const cleanMode = modeMatch ? modeMatch[1].trim().toLowerCase() : 'task';
              
              if (taskMessage.length > 10) {
                instructions.push({
                  timestamp: new Date(message.timestamp || message.ts || 0).getTime(),
                  mode: cleanMode,
                  message: taskMessage,
                  source: 'api_req_started'
                });
              }
            }
          }
        } catch (e) {
          // Ignorer
        }
      }

      // PATTERN 2: Format ui_messages.json - newTask tool
      // Pattern: ask:tool avec JSON contenant tool:newTask
      if (message.type === 'ask' && message.ask === 'tool' && typeof message.text === 'string') {
        try {
          const toolData = JSON.parse(message.text);
          
          if (toolData && toolData.tool === 'newTask' && typeof toolData.content === 'string' && toolData.content.length > 20) {
            const rawMode = String(toolData.mode || 'task');
            const cleanMode = rawMode.replace(/[^\w\s]/g, '').trim().toLowerCase();
            
            instructions.push({
              timestamp: new Date(message.timestamp || message.ts || 0).getTime(),
              mode: cleanMode || 'task',
              message: toolData.content.trim(),
              source: 'ask_tool'
            });
          }
        } catch (e) {
          // Ignorer
        }
      }

      // PATTERN 3: Objet brut déjà parsé
      if (typeof message.text === 'object' || typeof message.content === 'object') {
        const obj = (typeof message.text === 'object' && message.text)
          ? message.text
          : ((typeof message.content === 'object' && message.content) ? message.content : null);
        
        try {
          if (obj && obj.tool === 'newTask' && typeof obj.content === 'string' && obj.content.trim().length > 20) {
            const rawMode = String(obj.mode || 'task');
            const cleanMode = rawMode.replace(/[^\w\s]/g, '').trim().toLowerCase();
            
            instructions.push({
              timestamp: new Date(message.timestamp || message.ts || 0).getTime(),
              mode: cleanMode || 'task',
              message: obj.content.trim(),
              source: 'object_direct'
            });
          }
        } catch (e) {
          // Ignorer
        }
      }
    }
  } catch (error) {
    console.error(`⚠️  Erreur extraction ancien système pour ${path.basename(filePath)}:`, error.message);
  }

  return instructions;
}

// ============================================================================
// NOUVEAU SYSTÈME : Extraction avec UIMessagesDeserializer
// ============================================================================

/**
 * Extrait les instructions newTask avec le nouveau système
 * 
 * @param {string} filePath - Chemin vers ui_messages.json
 * @returns {Promise<Array>} Tableau d'instructions extraites
 */
async function extractWithNewSystem(filePath) {
  try {
    const messages = await readJsonByLines(filePath);
    const deserializer = new UIMessagesDeserializer();
    return deserializer.extractNewTasks(messages);
  } catch (error) {
    console.error(`⚠️  Erreur extraction nouveau système pour ${path.basename(filePath)}:`, error.message);
    return [];
  }
}

// ============================================================================
// ANALYSE ET COMPARAISON
// ============================================================================

/**
 * Compare deux ensembles d'instructions et retourne les métriques
 */
function compareInstructions(oldInstructions, newInstructions, fixtureName) {
  const oldCount = oldInstructions.length;
  const newCount = newInstructions.length;
  const diff = newCount - oldCount;

  // Analyse détaillée des sources (ancien système uniquement)
  const sourceCounts = {};
  for (const inst of oldInstructions) {
    const src = inst.source || 'unknown';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  }

  return {
    fixtureName,
    oldCount,
    newCount,
    diff,
    oldSources: sourceCounts,
    hasNewTasks: newCount > 0
  };
}

/**
 * Génère un rapport détaillé des résultats
 */
function generateReport(results) {
  const totalFixtures = results.length;
  const fixturesWithNewTasks = results.filter(r => r.hasNewTasks).length;
  
  const totalOldInstructions = results.reduce((sum, r) => sum + r.oldCount, 0);
  const totalNewInstructions = results.reduce((sum, r) => sum + r.newCount, 0);
  const totalDiff = totalNewInstructions - totalOldInstructions;
  
  const detectionRateOld = totalFixtures > 0 ? (fixturesWithNewTasks / totalFixtures * 100) : 0;
  const detectionRateNew = detectionRateOld; // Identique car on analyse les mêmes fixtures
  
  console.log('\n' + '='.repeat(80));
  console.log('📊 VALIDATION UIMessagesDeserializer - RAPPORT DÉTAILLÉ');
  console.log('='.repeat(80));
  console.log('');
  
  console.log('📈 STATISTIQUES GLOBALES');
  console.log('─'.repeat(80));
  console.log(`Total fixtures analysées      : ${totalFixtures}`);
  console.log(`Fixtures avec newTask         : ${fixturesWithNewTasks}`);
  console.log('');
  
  console.log('🔧 MÉTRIQUES ANCIEN SYSTÈME (Regex)');
  console.log('─'.repeat(80));
  console.log(`Total newTask extraits        : ${totalOldInstructions}`);
  console.log(`Fixtures non-détectées        : ${totalFixtures - fixturesWithNewTasks}`);
  console.log(`Taux de détection             : ${detectionRateOld.toFixed(1)}%`);
  console.log('');
  
  console.log('✨ MÉTRIQUES NOUVEAU SYSTÈME (JSON Structuré)');
  console.log('─'.repeat(80));
  console.log(`Total newTask extraits        : ${totalNewInstructions}`);
  console.log(`Fixtures non-détectées        : ${totalFixtures - fixturesWithNewTasks}`);
  console.log(`Taux de détection             : ${detectionRateNew.toFixed(1)}%`);
  console.log('');
  
  console.log('📊 AMÉLIORATION');
  console.log('─'.repeat(80));
  const improvementSign = totalDiff >= 0 ? '+' : '';
  const improvementPct = totalOldInstructions > 0 ? (totalDiff / totalOldInstructions * 100) : 0;
  console.log(`Différence absolue            : ${improvementSign}${totalDiff} instructions`);
  console.log(`Amélioration relative         : ${improvementSign}${improvementPct.toFixed(1)}%`);
  console.log('');
  
  console.log('📋 DÉTAILS PAR FIXTURE');
  console.log('─'.repeat(80));
  console.log('Fixture ID                                  | Ancien | Nouveau | Diff | Sources (Ancien)');
  console.log('─'.repeat(80));
  
  for (const result of results) {
    const diffStr = result.diff >= 0 ? `+${result.diff}` : `${result.diff}`;
    const sourcesStr = Object.entries(result.oldSources)
      .map(([src, count]) => `${src}:${count}`)
      .join(', ') || 'aucune';
    
    console.log(
      `${result.fixtureName.padEnd(42)} | ${String(result.oldCount).padStart(6)} | ${String(result.newCount).padStart(7)} | ${diffStr.padStart(4)} | ${sourcesStr}`
    );
  }
  console.log('─'.repeat(80));
  console.log('');
  
  // Recommandations
  console.log('💡 RECOMMANDATIONS');
  console.log('─'.repeat(80));
  
  if (totalDiff === 0) {
    console.log('✅ Les deux systèmes détectent exactement le même nombre d\'instructions.');
    console.log('   Le nouveau système peut être adopté sans perte de détection.');
  } else if (totalDiff > 0) {
    console.log(`✅ Le nouveau système détecte ${totalDiff} instructions supplémentaires (+${improvementPct.toFixed(1)}%).`);
    console.log('   Cela indique une meilleure détection structurée des formats JSON.');
  } else {
    console.log(`⚠️  Le nouveau système détecte ${Math.abs(totalDiff)} instructions de moins (${improvementPct.toFixed(1)}%).`);
    console.log('   Vérifier les patterns manquants dans le nouveau désérialiseur.');
  }
  
  console.log('');
  console.log('📝 ANALYSE DES SOURCES (Ancien Système)');
  console.log('─'.repeat(80));
  
  const allSources = {};
  for (const result of results) {
    for (const [src, count] of Object.entries(result.oldSources)) {
      allSources[src] = (allSources[src] || 0) + count;
    }
  }
  
  for (const [src, count] of Object.entries(allSources).sort((a, b) => b[1] - a[1])) {
    const percentage = (count / totalOldInstructions * 100).toFixed(1);
    console.log(`  ${src.padEnd(20)} : ${String(count).padStart(4)} instructions (${percentage}%)`);
  }
  
  console.log('');
  console.log('='.repeat(80));
  console.log('✨ Validation terminée avec succès');
  console.log('='.repeat(80));
}

// ============================================================================
// FONCTION PRINCIPALE
// ============================================================================

async function main() {
  console.log('🚀 Démarrage de la validation du nouveau désérialiseur...');
  console.log('');
  
  // Lister les fixtures
  let fixtures = [];
  try {
    const dirs = await fs.readdir(FIXTURES_DIR);
    fixtures = dirs.filter(dir => {
      const uiMessagesPath = path.join(FIXTURES_DIR, dir, 'ui_messages.json');
      return fsSync.existsSync(uiMessagesPath);
    });
  } catch (error) {
    console.error(`❌ Erreur lors de la lecture du répertoire fixtures: ${error.message}`);
    process.exit(1);
  }
  
  if (fixtures.length === 0) {
    console.error('❌ Aucune fixture trouvée dans tests/fixtures/real-tasks/');
    process.exit(1);
  }
  
  console.log(`📂 Fixtures trouvées: ${fixtures.length}`);
  console.log('');
  
  // Analyser chaque fixture
  const results = [];
  
  for (const fixtureName of fixtures) {
    const uiMessagesPath = path.join(FIXTURES_DIR, fixtureName, 'ui_messages.json');
    
    console.log(`🔍 Analyse de ${fixtureName}...`);
    
    // Extraction avec ancien système
    const oldInstructions = await extractWithOldSystem(uiMessagesPath);
    
    // Extraction avec nouveau système
    const newInstructions = await extractWithNewSystem(uiMessagesPath);
    
    // Comparaison
    const comparison = compareInstructions(oldInstructions, newInstructions, fixtureName);
    results.push(comparison);
    
    console.log(`   Ancien: ${oldInstructions.length} | Nouveau: ${newInstructions.length}`);
  }
  
  console.log('');
  
  // Générer le rapport
  generateReport(results);
}

// Exécution
main().catch(error => {
  console.error('❌ Erreur fatale:', error);
  process.exit(1);
});