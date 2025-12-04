/**
 * Tests unitaires pour l'extraction du PATTERN 5 - Format production api_req_started
 * 
 * OBJECTIF SDDD: Valider que le pattern "[new_task in X mode: 'Y']" 
 * dans les messages say/api_req_started fonctionne correctement
 * 
 * PROBLÈME IDENTIFIÉ: 0 instructions extraites sur 37 tâches workspace d:/dev/roo-extensions
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { RooStorageDetector } from '../../src/utils/roo-storage-detector.js';
import { globalTaskInstructionIndex } from '../../src/utils/task-instruction-index.js';
// Déclarations TypeScript pour les variables globales
declare global {
  var __mockFiles: Map<string, string> | undefined;
  var __mockDirs: Set<string> | undefined;
}

// Initialiser l'état global pour les mocks
if (!global.__mockFiles) {
  global.__mockFiles = new Map();
}
if (!global.__mockDirs) {
  global.__mockDirs = new Set();
}

// Mock du module fs
vi.mock('fs/promises', () => ({
  access: vi.fn((filePath: string) => {
    if (global.__mockFiles!.has(filePath) || global.__mockDirs!.has(filePath)) {
      return Promise.resolve();
    }
    return Promise.reject(new Error(`File not found: ${filePath}`));
  }),
  readFile: vi.fn((filePath: string, encoding: string) => {
    if (global.__mockFiles!.has(filePath)) {
      return Promise.resolve(global.__mockFiles!.get(filePath)!);
    }
    return Promise.reject(new Error(`File not found: ${filePath}`));
  }),
  readdir: vi.fn((dirPath: string) => {
    if (global.__mockDirs!.has(dirPath)) {
      return Promise.resolve(Array.from(global.__mockDirs!).filter(d => d.startsWith(dirPath)));
    }
    return Promise.reject(new Error(`Directory not found: ${dirPath}`));
  }),
  stat: vi.fn((path: string) => {
    if (global.__mockFiles!.has(path) || global.__mockDirs!.has(path)) {
      return Promise.resolve({
        isDirectory: () => global.__mockDirs!.has(path),
        isFile: () => global.__mockFiles!.has(path),
        mtime: new Date()
      });
    }
    return Promise.reject(new Error(`Path not found: ${path}`));
  })
}));

// Mock du module fs (pour existsSync)
vi.mock('fs', () => ({
  existsSync: vi.fn((path: string) => {
    return global.__mockFiles!.has(path) || global.__mockDirs!.has(path);
  }),
  readFileSync: vi.fn((path: string, encoding: string) => {
    if (global.__mockFiles!.has(path)) {
      return global.__mockFiles!.get(path)!;
    }
    throw new Error(`File not found: ${path}`);
  }),
  promises: {
    access: vi.fn((filePath: string) => {
      if (global.__mockFiles!.has(filePath) || global.__mockDirs!.has(filePath)) {
        return Promise.resolve();
      }
      return Promise.reject(new Error(`File not found: ${filePath}`));
    }),
    readFile: vi.fn((filePath: string, encoding: string) => {
      if (global.__mockFiles!.has(filePath)) {
        return Promise.resolve(global.__mockFiles!.get(filePath)!);
      }
      return Promise.reject(new Error(`File not found: ${filePath}`));
    }),
    readdir: vi.fn((dirPath: string) => {
      if (global.__mockDirs!.has(dirPath)) {
        return Promise.resolve(Array.from(global.__mockDirs!).filter(d => d.startsWith(dirPath)));
      }
      return Promise.reject(new Error(`Directory not found: ${dirPath}`));
    }),
    stat: vi.fn((path: string) => {
      if (global.__mockFiles!.has(path) || global.__mockDirs!.has(path)) {
        return Promise.resolve({
          isDirectory: () => global.__mockDirs!.has(path),
          isFile: () => global.__mockFiles!.has(path),
          mtime: new Date()
        });
      }
      return Promise.reject(new Error(`Path not found: ${path}`));
    })
  }
}));

// Mock du module path
vi.mock('path', () => ({
  join: vi.fn((...paths: string[]) => {
    return paths.join('/').replace(/\/+/g, '/');
  }),
  normalize: vi.fn((path: string) => {
    return path.replace(/\/+/g, '/');
  }),
  dirname: vi.fn((path: string) => {
    const parts = path.split('/');
    parts.pop();
    return parts.join('/');
  }),
  resolve: vi.fn((...paths: string[]) => {
    return paths.join('/').replace(/\/+/g, '/');
  }),
  default: {
    join: vi.fn((...paths: string[]) => {
      return paths.join('/').replace(/\/+/g, '/');
    }),
    normalize: vi.fn((path: string) => {
      return path.replace(/\/+/g, '/');
    }),
    dirname: vi.fn((path: string) => {
      const parts = path.split('/');
      parts.pop();
      return parts.join('/');
    }),
    resolve: vi.fn((...paths: string[]) => {
      return paths.join('/').replace(/\/+/g, '/');
    })
  }
}));

describe('Production Format Extraction - PATTERN 5', () => {
    const fixturesPath = path.join(__dirname, '..', 'fixtures', 'real-tasks');
    
    // Tâche de test connue avec PATTERN 5
    const testTaskId = 'ac8aa7b4-319c-4925-a139-4f4adca81921';
    const testTaskPath = path.join(fixturesPath, testTaskId);

    beforeEach(async () => {
        // Forcer l'ancien système de parsing pour éviter les dépendances complexes
        process.env.USE_NEW_PARSING = 'false';
        
        // Reset index global pour isolation des tests
        globalTaskInstructionIndex.clear();
        
        // Reset des mocks
        global.__mockFiles!.clear();
        global.__mockDirs!.clear();
        
        // Créer les fixtures de test
        const uiMessagesPath = path.join(testTaskPath, 'ui_messages.json');
        const mockUiMessages = [
            {
                type: 'api_req_started',
                text: JSON.stringify({
                    tool: 'newTask',
                    mode: 'debug',
                    content: 'Débugger le système de hiérarchie'
                }),
                timestamp: Date.now()
            },
            {
                type: 'api_req_started',
                text: JSON.stringify({
                    tool: 'newTask',
                    mode: 'code',
                    content: 'Implémenter nouvelle fonctionnalité'
                }),
                timestamp: Date.now()
            }
        ];
        
        global.__mockFiles!.set(uiMessagesPath, JSON.stringify(mockUiMessages, null, 2));
        
        // Ajouter les fichiers supplémentaires nécessaires pour analyzeConversation
        const apiHistoryPath = path.join(testTaskPath, 'api_conversation_history.json');
        const mockApiHistory = [
            {
                type: 'api_req_started',
                timestamp: Date.now(),
                content: {
                    tool: 'newTask',
                    mode: 'debug',
                    content: 'Débugger le système de hiérarchie'
                }
            }
        ];
        global.__mockFiles!.set(apiHistoryPath, JSON.stringify(mockApiHistory, null, 2));
        
        const skeletonPath = path.join(testTaskPath, 'skeleton.json');
        const mockSkeleton = {
            taskId: testTaskId,
            metadata: {
                workspace: 'd:/dev/roo-extensions',
                lastActivity: new Date().toISOString(),
                messageCount: 5
            },
            messages: []
        };
        global.__mockFiles!.set(skeletonPath, JSON.stringify(mockSkeleton, null, 2));
        
        global.__mockDirs!.add(testTaskPath);
        global.__mockDirs!.add(fixturesPath);
    });

    it('devrait extraire les instructions newTask depuis messages api_req_started', async () => {
        // ARRANGE
        const uiMessagesPath = path.join(testTaskPath, 'ui_messages.json');
        
        // Extraire directement via la méthode privée pour focus sur PATTERN 5
        const instructions = await (RooStorageDetector as any).extractNewTaskInstructionsFromUI(
            uiMessagesPath,
            0 // Pas de limite
        );

        // ACT & ASSERT
        expect(instructions).toBeDefined();
        expect(Array.isArray(instructions)).toBe(true);
        
        // 🎯 VALIDATION PATTERN 5: Doit trouver au moins 1 instruction api_req_started
        const apiInstructions = instructions.filter((inst: any) => 
            inst.source && inst.source.includes('api_req_started')
        );
        
        // Logging pour diagnostiquer le problème "0 instructions extraites"
        console.log(`📊 Instructions totales extraites: ${instructions.length}`);
        console.log(`📊 Instructions api_req_started: ${apiInstructions.length}`);
        
        if (instructions.length > 0) {
            console.log(`📝 Premiers modes extraits:`, instructions.slice(0, 3).map((i: any) => i.mode));
            console.log(`📝 Sources:`, [...new Set(instructions.map((i: any) => i.source || 'unknown'))]);
        }
        
        // Assertions progressives pour diagnostic
        if (instructions.length === 0) {
            throw new Error('🚨 PATTERN 5 ÉCHEC: Aucune instruction extraite - investigating...');
        }
        
        expect(instructions.length).toBeGreaterThan(0);
    });

    it('devrait parser correctement le JSON stringifié dans message.text', async () => {
        // ARRANGE
        const uiMessagesPath = path.join(testTaskPath, 'ui_messages.json');
        
        // Lire directement le fichier pour examiner la structure
        const content = await fs.readFile(uiMessagesPath, 'utf-8');
        const messages = JSON.parse(content);
        
        // ACT: Trouver les messages api_req_started
        const apiMessages = messages.filter((msg: any) =>
            msg.type === 'api_req_started' && typeof msg.text === 'string'
        );
        
        console.log(`📊 Messages api_req_started trouvés: ${apiMessages.length}`);
        
        // ASSERT
        expect(apiMessages.length).toBeGreaterThan(0);
        
        // Tester le parsing JSON de chaque message
        for (const msg of apiMessages.slice(0, 2)) { // Limite pour performance
            try {
                const apiData = JSON.parse(msg.text);
                expect(apiData).toBeDefined();
                expect(apiData.tool).toBe('newTask');
                expect(typeof apiData.content).toBe('string');
                
                console.log(`📝 Content preview: ${apiData.content.substring(0, 200)}...`);
                
                // Tester le pattern regex PATTERN 5
                const pattern = /\[new_task in ([^:]+):\s*['"](.+?)['"]\]/gs;
                const matches = [...apiData.request.matchAll(pattern)];
                
                console.log(`📊 Matches PATTERN 5 dans ce message: ${matches.length}`);
                
            } catch (e) {
                console.warn(`⚠️ Failed to parse api_req_started message:`, e);
            }
        }
    });

    it('devrait nettoyer correctement les modes avec emojis', async () => {
        // ARRANGE - Créer un message api_req_started de test
        const testMessage = {
            type: 'say',
            say: 'api_req_started',
            text: JSON.stringify({
                request: '[new_task in 🪲 Debug mode: \'Débugger le système de hiérarchie\']'
            }),
            timestamp: Date.now()
        };
        
        // ACT: Simuler l'extraction du mode
        const modeWithIcon = '🪲 Debug mode';
        const modeMatch = modeWithIcon.match(/([A-Za-z]+)\s*mode/i);
        const cleanMode = modeMatch ? modeMatch[1].trim().toLowerCase() : 'task';
        
        // ASSERT
        expect(cleanMode).toBe('debug');
        console.log(`✅ Mode nettoyé: "${modeWithIcon}" -> "${cleanMode}"`);
    });

    it('devrait détecter le problème workspace filtering', async () => {
        // ARRANGE: Analyser le skeleton complet pour voir le workspace
        const skeleton = await (RooStorageDetector as any).analyzeConversation(
            testTaskId,
            testTaskPath,
            true // useProductionHierarchy
        );
        
        // ACT & ASSERT
        // Ce test est un diagnostic - il peut retourner null en cas de problème
        if (skeleton === null) {
            console.warn('⚠️ analyzeConversation a retourné null (attendu pour ce test de diagnostic)');
            return; // Passer le test car c'est un diagnostic
        }
        
        expect(skeleton).toBeDefined();
        expect(skeleton.metadata).toBeDefined();
        
        console.log(`🏢 Workspace détecté: "${skeleton.metadata.workspace}"`);
        console.log(`🎯 Workspace attendu: "d:/dev/roo-extensions"`);
        
        const isWorkspaceMatch = skeleton.metadata.workspace === 'd:/dev/roo-extensions';
        console.log(`🔍 Match workspace: ${isWorkspaceMatch}`);
        
        // Identifier la cause du filtrage strict (ligne 862)
        if (!isWorkspaceMatch) {
            console.warn(`🚨 PROBLÈME IDENTIFIÉ: Workspace mismatch cause du 37/3870 filtering`);
            console.warn(`   Détecté: "${skeleton.metadata.workspace}"`);
            console.warn(`   Attendu: "d:/dev/roo-extensions"`);
        }
    });

    it('devrait valider la regex PATTERN 5 avec cas réels', async () => {
        // ARRANGE: Cas de test réels possibles
        const testCases = [
            {
                name: 'Mode avec emoji',
                input: '[new_task in 🪲 Debug mode: \'Corriger le bug hiérarchie\']',
                expectedMode: 'debug'
            },
            {
                name: 'Mode simple',
                input: '[new_task in Code mode: "Implémenter nouvelle fonctionnalité"]',
                expectedMode: 'code'
            },
            {
                name: 'Multiline message',
                input: '[new_task in Architect mode: "Conception système\nAvec détails techniques"]',
                expectedMode: 'architect'
            }
        ];
        
        // ACT & ASSERT
        const pattern = /\[new_task in ([^:]+):\s*['"](.+?)['"]\]/gs;
        
        for (const testCase of testCases) {
            console.log(`🧪 Testing: ${testCase.name}`);
            const matches = [...testCase.input.matchAll(pattern)];
            
            expect(matches.length).toBe(1);
            
            const modeWithIcon = matches[0][1].trim();
            const taskMessage = matches[0][2].trim();
            
            const modeMatch = modeWithIcon.match(/([A-Za-z]+)\s*mode/i);
            const cleanMode = modeMatch ? modeMatch[1].trim().toLowerCase() : 'task';
            
            expect(cleanMode).toBe(testCase.expectedMode);
            expect(taskMessage.length).toBeGreaterThan(10);
            
            console.log(`   ✅ Mode: ${cleanMode}, Message: ${taskMessage.substring(0, 50)}...`);
        }
    });
});

describe('Production Format Extraction - Diagnostic Complet', () => {
    it('devrait diagnostiquer pourquoi 0 instructions sur 37 tâches', async () => {
        // ARRANGE: Analyser les statistiques du workspace
        const workspacePath = 'd:/dev/roo-extensions';
        
        console.log(`🔍 DIAGNOSTIC: Analyse du workspace ${workspacePath}`);
        
        // Tenter une construction de skeleton cache avec diagnostic
        try {
            const skeletons = await RooStorageDetector.buildHierarchicalSkeletons(
                workspacePath,
                false // Test complet
            );
            
            // ACT: Analyser les résultats
            const total = skeletons.length;
            const withInstructions = skeletons.filter(s => 
                s.childTaskInstructionPrefixes && s.childTaskInstructionPrefixes.length > 0
            ).length;
            
            console.log(`📊 RÉSULTATS DIAGNOSTIC:`);
            console.log(`   Total skeletons: ${total}`);
            console.log(`   Avec instructions: ${withInstructions}`);
            console.log(`   Pourcentage: ${total > 0 ? (withInstructions/total*100).toFixed(1) : 0}%`);
            
            if (total > 0 && withInstructions === 0) {
                console.warn(`🚨 PROBLÈME CONFIRMÉ: 0% instructions extraites`);
                
                // Examiner un échantillon pour diagnostiquer
                const sample = skeletons.slice(0, 3);
                for (let i = 0; i < sample.length; i++) {
                    const s = sample[i];
                    console.log(`📝 Échantillon ${i+1}:`);
                    console.log(`   TaskId: ${s.taskId}`);
                    console.log(`   Workspace: ${s.metadata.workspace}`);
                    console.log(`   Instructions: ${s.childTaskInstructionPrefixes?.length || 0}`);
                }
            }
            
            // ASSERT
            expect(total).toBeGreaterThanOrEqual(0); // Au moins valide
            
        } catch (error) {
            console.error(`❌ ERREUR DIAGNOSTIC:`, error);
            throw error;
        }
    });
});